/* Vox offscreen document — owns the audio graph, the reading queue and all
   playback state, and drives tts-worker.js for the actual synthesis.

   The service worker is deliberately kept dumb, because MV3 evicts it whenever
   it feels like it. This document is longer-lived, but not permanent either, so
   anything needed to resume a read is mirrored to session storage. */

import * as store from "./audio-store.js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const VOICE_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main/voices/`;
const SAMPLE_RATE = 24000;

/* -------------------------------------------------------------- app state */

const state = {
  status: "idle",          // idle | loading | ready | buffering | playing | paused | error
  ready: false,
  index: 0,
  total: 0,
  device: "wasm",
  dtype: "q8",
  rendered: 0,           // sentences already synthesised and on disk
  renderedMask: "",      // one character per sentence: 1 = audio ready on disk
  speakers: [],          // [{ name, voice }] when the page is a dialogue
  rtf: null,             // seconds of compute per second of speech
  keepingUp: true,       // false once synthesis is slower than playback
  title: "",
  source: "",
  voice: "af_heart",
  speed: 1.0,
  profile: "balanced",
  threads: 1,
  error: null,
  errorDetail: null,       // the underlying cause, shown verbatim in the popup
  downloaded: false,       // distinguishes "never fetched" from "fetched, won't start"
  download: null,          // { pct, loaded, total, file }
  chunkPreview: "",
};

let loadPromise = null;
let modelReady = false;
let chunks = [];
let tabId = null;
let epoch = 0;             // bumped on every stop/seek/param change
let genChain = Promise.resolve();
const audioCache = new Map();
const rendered = new Set();   // chunk indices known to be in the persistent store
let sweeping = false;
// Deliberately not `epoch`: that one is bumped by every seek and pause, and the
// background render should survive those. It only resets when the document or
// the voice/rate changes.
let sweepToken = 0;

// Real-time factor, measured rather than assumed. Above ~0.9 the reader cannot
// stay ahead of itself and the user hears a gap before every sentence, which is
// a configuration problem the UI should own up to rather than hide.
const rtfSamples = [];

function noteRtf(ms, audioSeconds) {
  if (!audioSeconds) return;
  rtfSamples.push(ms / 1000 / audioSeconds);
  if (rtfSamples.length > 8) rtfSamples.shift();
  const sorted = [...rtfSamples].sort((x, y) => x - y);
  const median = sorted[sorted.length >> 1];
  const keepingUp = median < 0.9;
  if (state.rtf === null || Math.abs(median - state.rtf) > 0.03 || keepingUp !== state.keepingUp) {
    pushState({ rtf: Number(median.toFixed(2)), keepingUp });
  }
}

const LOOKAHEAD = 12;         // decoded clips kept in memory around the cursor

// When a page turns out to be a dialogue, each speaker gets their own voice.
// Ordered so consecutive speakers contrast in gender and accent rather than
// sounding like two takes of the same person.
const CAST = [
  "am_michael", "bf_emma", "am_fenrir", "bm_george",
  "af_bella", "bm_fable", "af_nicole", "am_puck",
];
let speakerVoices = new Map();   // speaker label -> voice id

function voiceFor(chunk) {
  return (chunk && chunk.speaker && speakerVoices.get(chunk.speaker)) || state.voice;
}

// The reader's chosen voice plays whoever speaks first; everyone else is cast
// around it, skipping anything already in use.
async function castSpeakers(speakers) {
  speakerVoices = new Map();
  if (!speakers || speakers.length < 2) {
    pushState({ speakers: [] });
    return;
  }
  const used = new Set([state.voice]);
  speakerVoices.set(speakers[0], state.voice);
  let next = 0;
  for (const speaker of speakers.slice(1)) {
    while (next < CAST.length && used.has(CAST[next])) next++;
    const voice = next < CAST.length ? CAST[next] : state.voice;
    used.add(voice);
    speakerVoices.set(speaker, voice);
    next++;
  }
  await Promise.all([...speakerVoices.values()].map(seedBundledVoice));
  pushState({ speakers: [...speakerVoices].map(([name, voice]) => ({ name, voice })) });
}

/* -------------------------------------------------------------- messaging */

function post(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { /* nobody listening */ });
}

// Offscreen documents are handed chrome.runtime and very little else — notably
// no chrome.storage — so settings round-trip through the service worker.
async function ask(type, extra = {}) {
  try {
    return await chrome.runtime.sendMessage({ to: "bg", type, ...extra });
  } catch {
    return null;
  }
}

let pushScheduled = false;
function pushState(patch) {
  if (patch) Object.assign(state, patch);
  if (pushScheduled) return;
  pushScheduled = true;
  queueMicrotask(() => {
    pushScheduled = false;
    post({ to: "ui", type: "STATE", state: snapshot() });
    post({ to: "bg", type: "STATE", state: snapshot() });
  });
}

function snapshot() {
  return { ...state, tabId, hasContent: chunks.length > 0 };
}

/* ------------------------------------------------------------ voice assets */

// The 82M model ships one 510 KB style vector per voice. The popular ones are
// packaged with the extension; anything else falls back to a Hub download.
async function seedBundledVoice(id) {
  try {
    const cache = await caches.open("kokoro-voices");
    const url = VOICE_BASE + `${id}.bin`;
    if (await cache.match(url)) return;
    const res = await fetch(chrome.runtime.getURL(`voices/${id}.bin`));
    if (!res.ok) return;
    const buf = await res.arrayBuffer();
    await cache.put(url, new Response(buf, { headers: { "Content-Type": "application/octet-stream" } }));
  } catch { /* cache unavailable — kokoro-js will fetch from the Hub */ }
}

/* ---------------------------------------------------------- session state */

// This document can still go away — on extension reload, browser restart, or a
// worker crash — so the reading position is mirrored into the service worker's
// session storage. Coming back to a paused article must not lose your place.
let saveTimer = null;
let savedChunks = false;
function saveSession({ full = false } = {}) {
  if (full) savedChunks = false;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const session = {
      tabId,
      index: state.index,
      title: state.title,
      source: state.source,
      total: state.total,
    };
    // The article text only needs writing when the article changes.
    if (!savedChunks) {
      session.chunks = chunks;
      savedChunks = true;
    }
    ask("SAVE_SESSION", { session, merge: !session.chunks });
  }, 400);
}

async function restoreSession() {
  const saved = (await ask("LOAD_SESSION"))?.session;
  if (!saved || !saved.chunks?.length) return;
  chunks = saved.chunks;
  tabId = saved.tabId ?? null;
  Object.assign(state, {
    index: Math.min(saved.index || 0, saved.chunks.length - 1),
    total: saved.chunks.length,
    title: saved.title || "",
    source: saved.source || "",
    status: "paused",
    chunkPreview: saved.chunks[saved.index || 0]?.text || "",
  });
}

/* ------------------------------------------------------------------ worker */

let worker = null;
let nextRequestId = 1;
const inflight = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(chrome.runtime.getURL("tts-worker.js"), { type: "module" });

  worker.onmessage = ({ data }) => {
    if (data.type === "progress") return trackProgress(data.payload);
    if (data.type === "ready") return;
    if (data.type === "fatal") return failWorker(new Error(data.error));
    const slot = inflight.get(data.id);
    if (!slot) return;
    inflight.delete(data.id);
    if (data.ok) slot.resolve(data.result);
    else slot.reject(new Error(data.error));
  };

  worker.onerror = (event) => {
    const where = event.filename ? ` at ${event.filename}:${event.lineno}:${event.colno}` : "";
    failWorker(new Error(
      (event.message ? event.message + where : "") ||
      "The speech worker could not start — its script failed to load or threw while initialising.",
    ));
  };

  return worker;
}

function failWorker(error) {
  for (const slot of inflight.values()) slot.reject(error);
  inflight.clear();
  try { worker?.terminate(); } catch { /* already gone */ }
  worker = null;
  modelReady = false;
  loadPromise = null;
}

// An incomplete or stale copy of the extension folder fails in exactly the same
// opaque way as a crash, so check the files are actually there and readable.
async function preflight() {
  const broken = [];
  const check = async (name, readFully) => {
    try {
      const res = await fetch(chrome.runtime.getURL(name));
      if (!res.ok) { broken.push(`${name} → HTTP ${res.status}`); return; }
      if (readFully) {
        const size = (await res.arrayBuffer()).byteLength;
        if (size < 1024) broken.push(`${name} → only ${size} bytes`);
      } else {
        res.body?.cancel();
      }
    } catch (err) {
      broken.push(`${name} → ${err.message || err}`);
    }
  };

  await check("tts-worker.js", true);
  await check("ort/ort-wasm-simd-threaded.jsep.mjs", true);
  await check("ort/ort-wasm-simd-threaded.jsep.wasm", false);
  await check(`voices/${state.voice}.bin`, true);
  return broken;
}

function callWorker(type, payload = {}, timeoutMs = 0) {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    let timer = null;
    const settle = (fn) => (value) => { if (timer) clearTimeout(timer); fn(value); };
    inflight.set(id, { resolve: settle(resolve), reject: settle(reject) });
    ensureWorker().postMessage({ id, type, ...payload });
    // Rejecting an already-settled promise is a no-op, so this fires
    // unconditionally rather than consulting a map that teardown code mutates.
    // Note the model load is deliberately given no timeout: it spans a download
    // that can legitimately take minutes on a slow connection.
    if (timeoutMs) {
      timer = setTimeout(() => {
        inflight.delete(id);
        reject(new Error("The speech engine stopped responding."));
      }, timeoutMs);
    }
  });
}

/* -------------------------------------------------------------- model load */

const downloads = new Map();
let lastProgressPct = -1;
let lastProgressAt = 0;

function trackProgress(p) {
  if (!p || !p.file) return;
  if (p.status === "progress" || p.status === "download") {
    downloads.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
  } else if (p.status === "done" && downloads.has(p.file)) {
    const f = downloads.get(p.file);
    downloads.set(p.file, { loaded: f.total || f.loaded, total: f.total || f.loaded });
  }
  let loaded = 0, total = 0;
  for (const f of downloads.values()) { loaded += f.loaded; total += f.total; }
  if (!total) return;
  if (loaded >= total) state.downloaded = true;

  // Progress fires hundreds of times a second; each push wakes the service
  // worker to repaint a badge that only shows whole percents anyway.
  const now = Date.now();
  const pct = Math.min(100, Math.round((loaded / total) * 100));
  if (pct !== 100 && pct === lastProgressPct && now - lastProgressAt < 250) return;
  lastProgressPct = pct;
  lastProgressAt = now;
  pushState({ download: { pct, loaded, total, file: (p.file || "").split("/").pop() } });
}

async function loadModel(force = false) {
  if (modelReady && !force) return true;
  if (loadPromise && !force) return loadPromise;

  downloads.clear();
  pushState({
    status: "loading",
    error: null,
    errorDetail: null,
    download: { pct: 0, loaded: 0, total: 0, file: "" },
  });

  loadPromise = (async () => {
    const broken = await preflight();
    if (broken.length) {
      const err = new Error(`Extension files are missing or unreadable:\n  ${broken.join("\n  ")}`);
      pushState({
        status: "error", ready: false, download: null,
        error: "The extension folder looks incomplete. Rebuild it and reload the extension.",
        errorDetail: `${err.message}\n${await diagnose()}`,
      });
      throw err;
    }

    await seedBundledVoice(state.voice);
    try {
      // Threads are a large speed win but the most environment-dependent part
      // of the stack, so a failure retries single-threaded before giving up.
      let info = null;
      let lastError = null;
      for (const threads of [undefined, 1]) {
        try {
          if (!worker) ensureWorker();
          info = await callWorker("load", { profile: state.profile, voice: state.voice, threads });
          break;
        } catch (err) {
          lastError = err;
          console.warn(`[vox] load failed (threads=${threads ?? "auto"})`, err);
          failWorker(err);
        }
      }
      if (!info) throw lastError || new Error("Model failed to load");
      modelReady = true;
      pushState({
        status: "ready",
        ready: true,
        downloaded: true,
        download: null,
        error: null,
        errorDetail: null,
        device: info?.device || "wasm",
        dtype: info?.dtype || "q8",
        threads: info?.threads || 1,
      });
      return true;
    } catch (err) {
      modelReady = false;
      console.error("[vox] model load failed", err);
      const detail = [String((err && err.stack) || err).split("\n").slice(0, 3).join("\n"), await diagnose()]
        .filter(Boolean)
        .join("\n");
      pushState({
        status: "error",
        ready: false,
        download: null,
        error: friendlyError(err),
        errorDetail: detail,
      });
      throw err;
    } finally {
      downloads.clear();
    }
  })();

  try {
    return await loadPromise;
  } finally {
    if (!modelReady) loadPromise = null;
  }
}

// "It failed" is useless when the model lives on the user's own machine. Work
// out which link in the chain broke and say so.
async function diagnose() {
  const notes = [];

  try {
    const res = await fetch(`https://huggingface.co/${MODEL_ID}/resolve/main/config.json`, { cache: "no-store" });
    if (!res.ok) notes.push(`huggingface.co answered HTTP ${res.status}.`);
  } catch (err) {
    notes.push(`Cannot reach huggingface.co (${String(err.message || err)}). A VPN, firewall, or offline network would do this.`);
  }

  try {
    const probe = await caches.open("vox-selftest");
    await probe.put("https://vox.invalid/probe", new Response("ok"));
    await caches.delete("vox-selftest");
  } catch (err) {
    notes.push(`The browser refused to cache files (${String(err.name || err)}). Check disk space and that this site's data isn't blocked.`);
  }

  let sharedWasm = false;
  try {
    new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    sharedWasm = typeof SharedArrayBuffer !== "undefined";
  } catch { /* not permitted here */ }

  notes.push(
    `sharedArrayBuffer: ${typeof SharedArrayBuffer === "undefined" ? "no" : "yes"}, ` +
    `sharedWasmMemory: ${sharedWasm ? "yes" : "no"}, ` +
    `webgpu: ${navigator.gpu ? "yes" : "no"}, ` +
    `profile: ${state.profile}`,
  );
  notes.push(`loaded from: ${chrome.runtime.getURL("")}`);

  return notes.join("\n");
}

function friendlyError(err) {
  const msg = String((err && err.message) || err || "Unknown error");
  if (/fetch|network|Failed to load|NetworkError/i.test(msg)) {
    return "Could not download the voice model. Check your connection and try again.";
  }
  if (/no available backend|backend not found/i.test(msg)) {
    return "The speech engine failed to start. Try reloading the extension.";
  }
  if (/quota|storage/i.test(msg)) return "Not enough storage to cache the voice model.";
  return msg;
}

/* -------------------------------------------------------------- synthesis */

let audioCtx = null;
function ctx() {
  if (!audioCtx) audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  return audioCtx;
}

// Kokoro pads utterances with a little dead air; trimming it and inserting our
// own gap keeps sentence transitions from dragging.
function trimSilence(pcm) {
  const threshold = 0.0035;
  let start = 0, end = pcm.length;
  while (start < end && Math.abs(pcm[start]) < threshold) start++;
  while (end > start && Math.abs(pcm[end - 1]) < threshold) end--;
  const pad = Math.round(SAMPLE_RATE * 0.01);
  start = Math.max(0, start - pad);
  end = Math.min(pcm.length, end + pad);
  if (end <= start) return { pcm, offset: 0 };
  // The offset matters: word timings come from the untrimmed waveform.
  return { pcm: pcm.subarray(start, end), offset: start / SAMPLE_RATE };
}

function toBuffer(pcm, leadSeconds, tailSeconds) {
  const lead = Math.round(SAMPLE_RATE * leadSeconds);
  const tail = Math.round(SAMPLE_RATE * tailSeconds);
  const buffer = ctx().createBuffer(1, lead + pcm.length + tail, SAMPLE_RATE);
  buffer.copyToChannel(pcm, 0, lead);
  return buffer;
}

// A heading read with the same rhythm as body text sounds like a sentence that
// went missing. Give it silence on both sides so it lands as a section break.
function gapsFor(chunk) {
  const text = (chunk.text || "").trim();
  const last = text.slice(-1);
  if (chunk.heading) return { lead: 0.42, tail: 0.5 };
  // A new speaker in a dialogue gets a beat too, the way a turn does aloud.
  const previous = chunk.i > 0 ? chunks[chunk.i - 1] : null;
  const lead = chunk.speaker && chunk.speaker !== (previous && previous.speaker) ? 0.22 : 0;
  if (".!?…".includes(last)) return { lead, tail: 0.18 };
  if (",;:".includes(last)) return { lead, tail: 0.09 };
  return { lead, tail: 0.12 };
}

function cacheKey(text, voice) {
  return store.keyFor({
    text,
    voice: voice || state.voice,
    speed: state.speed,
    profile: state.profile,
    device: state.dtype,
  });
}

// Turn raw PCM into something playable, and shift the word timings by however
// much leading silence we trimmed off.
function pack(pcm, words, chunk) {
  const trimmed = trimSilence(pcm);
  const { lead, tail } = gapsFor(chunk);
  return {
    buffer: toBuffer(trimmed.pcm, lead, tail),
    // Leading silence delays every word, so the highlight schedule moves with it.
    words: words
      ? words.map(([a, b]) => [
          Math.max(0, a - trimmed.offset) + lead,
          Math.max(0, b - trimmed.offset) + lead,
        ])
      : null,
    duration: lead + trimmed.pcm.length / SAMPLE_RATE,
  };
}

function synth(i) {
  if (audioCache.has(i)) return audioCache.get(i);
  const chunk = chunks[i];
  if (!chunk) return Promise.resolve(null);

  const job = (async () => {
    // Loading first so the key can include the dtype that is actually speaking;
    // once the model is up this returns immediately.
    await loadModel();
    const voice = voiceFor(chunk);
    const key = await cacheKey(chunk.text, voice);

    const hit = await store.get(key);
    if (hit) {
      rendered.add(i);
      return pack(hit.pcm, hit.words, chunk);
    }

    // Inference is serialised: one model, one worker.
    const startedAt = performance.now();
    const result = await (genChain = genChain
      .catch(() => {})
      .then(() => callWorker("generate", {
        text: chunk.text,
        voice,
        speed: state.speed,
      }, 180000)));
    noteRtf(performance.now() - startedAt, result.pcm.length / result.sampleRate);

    store.put(key, { pcm: result.pcm, words: result.words, sampleRate: result.sampleRate })
      .then(() => { rendered.add(i); reportRendered(); })
      .catch(() => {});

    return pack(result.pcm, result.words, chunk);
  })();

  audioCache.set(i, job);
  job.catch((err) => {
    audioCache.delete(i);
    console.warn("[vox] synthesis failed for chunk", i, err);
  });
  return job;
}

// The scrubber shows which sentences are ready, and the sweep fills in from the
// cursor outwards, so a single "prepared up to here" number would be a lie.
function reportRendered() {
  let mask = "";
  for (let i = 0; i < chunks.length; i++) mask += rendered.has(i) ? "1" : "0";
  if (state.rendered !== rendered.size || state.renderedMask !== mask) {
    pushState({ rendered: rendered.size, renderedMask: mask });
  }
}

// Work out what is already on disk so the sweep does not redo it and the UI can
// show a real "prepared" range.
async function surveyRendered() {
  rendered.clear();
  if (!chunks.length) return;
  await loadModel().catch(() => {});
  const keys = await Promise.all(chunks.map((c) => cacheKey(c.text, voiceFor(c))));
  const present = await Promise.all(keys.map((k) => store.has(k)));
  present.forEach((yes, i) => { if (yes) rendered.add(i); });
  reportRendered();
}

// Render the whole document once, nearest-to-the-cursor first, then stop. This
// is the difference between a laptop that warms up briefly and one that stays
// hot for the whole article.
async function sweep(myToken) {
  if (sweeping) return;
  sweeping = true;
  try {
    while (myToken === sweepToken && rendered.size < chunks.length) {
      let next = -1;
      for (let i = state.index; i < chunks.length; i++) if (!rendered.has(i)) { next = i; break; }
      if (next < 0) for (let i = 0; i < chunks.length; i++) if (!rendered.has(i)) { next = i; break; }
      if (next < 0) break;

      try {
        await synth(next);
      } catch {
        rendered.add(next);   // do not spin forever on a sentence that will not render
      }
      rendered.add(next);
      reportRendered();
      pruneCache(state.index);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  } finally {
    sweeping = false;
  }
}

function prefetch(i) {
  if (i < chunks.length && !audioCache.has(i)) synth(i);
}

// Only decoded AudioBuffers are dropped — the audio itself stays on disk, so
// coming back to an earlier sentence is a disk read, never another inference.
function pruneCache(around) {
  for (const key of audioCache.keys()) {
    if (key < around - 2 || key > around + LOOKAHEAD) audioCache.delete(key);
  }
}

/* --------------------------------------------------------------- playback */

let currentSource = null;
let abortCurrent = null;

function playBuffer(buffer, myEpoch) {
  return new Promise((resolve) => {
    const source = ctx().createBufferSource();
    source.buffer = buffer;
    source.connect(ctx().destination);

    const settle = (reason) => {
      if (currentSource === source) { currentSource = null; abortCurrent = null; }
      resolve(reason);
    };
    // Stopping a source clears its onended, so the loop awaiting this promise
    // has to be released by hand or it hangs on forever.
    source.onended = () => settle(myEpoch === epoch ? "ended" : "aborted");
    currentSource = source;
    abortCurrent = () => settle("aborted");
    source.start();
  });
}

function stopSource() {
  if (!currentSource) return;
  const source = currentSource;
  const release = abortCurrent;
  currentSource = null;
  abortCurrent = null;
  source.onended = null;
  try { source.stop(); } catch { /* already stopped */ }
  release?.();
}

async function runFrom(startIndex) {
  const myEpoch = ++epoch;
  stopSource();
  await ctx().resume();
  // Resuming the context is the definition of "play from here", so a pause
  // left over from a previous read is no longer true. Any pause that arrives
  // after this point is honoured by held() below.
  if (state.status === "paused") state.status = "buffering";

  for (let i = startIndex; i < chunks.length; i++) {
    if (myEpoch !== epoch) return;

    // Neither a pause nor an in-progress model download should be painted over
    // by the loop: reporting "buffering" while 163 MB is still arriving hides
    // the only progress the user can act on.
    const held = () => state.status === "paused" || state.status === "loading";
    const paused = () => state.status === "paused";
    const cached = audioCache.has(i);
    pushState({
      index: i,
      status: held() ? state.status : cached ? "playing" : "buffering",
      chunkPreview: chunks[i].text,
    });
    saveSession();
    if (tabId != null) post({ to: "bg", type: "HIGHLIGHT", tabId, index: i });

    let clip;
    try {
      clip = await synth(i);
    } catch (err) {
      // A loop that has already been superseded must not paint its own
      // cancellation over whatever replaced it.
      if (myEpoch !== epoch) return;
      pushState({ status: "error", error: friendlyError(err) });
      return;
    }
    if (myEpoch !== epoch) return;
    if (!clip) continue;

    if (!held()) pushState({ status: "playing" });
    for (let ahead = 1; ahead <= 3; ahead += 1) prefetch(i + ahead);
    pruneCache(i);

    // Hand the page the word schedule so it can animate the highlight itself.
    // A hidden document's timers get throttled; the visible page's do not.
    if (tabId != null) {
      post({
        to: "bg",
        type: "SPEAK_CHUNK",
        tabId,
        index: i,
        words: clip.words,
        duration: clip.duration,
        paused: paused(),
      });
    }

    const result = await playBuffer(clip.buffer, myEpoch);
    if (result === "aborted" || myEpoch !== epoch) return;
  }

  if (myEpoch === epoch) finish();
}

function finish() {
  stopSource();
  // Leaving the context running holds the audio device open for nothing.
  if (audioCtx) audioCtx.suspend().catch(() => {});
  pushState({ status: "ready", index: chunks.length ? chunks.length - 1 : 0, chunkPreview: "" });
  saveSession();
  if (tabId != null) post({ to: "bg", type: "CLEAR", tabId });
}

/* --------------------------------------------------------------- commands */

function tellPage(type) {
  if (tabId != null) post({ to: "bg", type: "PAGE", tabId, action: type });
}

function start(index) {
  runFrom(index).catch((err) => {
    console.warn("[vox] playback loop failed", err);
    pushState({ status: "error", error: friendlyError(err) });
  });
}

async function speak({ chunks: incoming, title, source, tabId: fromTab, startIndex = 0, speakers = [] }) {
  epoch++;
  stopSource();
  audioCache.clear();
  // genChain is deliberately left alone: resetting it while a generate is
  // still running would let two inferences overlap in one worker.
  chunks = incoming || [];
  rendered.clear();
  state.renderedMask = "";
  tabId = fromTab ?? null;
  const from = Math.min(Math.max(startIndex | 0, 0), Math.max(chunks.length - 1, 0));
  pushState({
    title: title || "",
    source: source || "",
    total: chunks.length,
    index: from,
    error: null,
    // Without this a read started while the last one was paused would play
    // while every surface still said "Paused".
    status: "buffering",
    chunkPreview: chunks[from] ? chunks[from].text : "",
  });
  if (!chunks.length) {
    pushState({ status: "error", error: "No readable text found on this page." });
    return;
  }
  await castSpeakers(speakers);
  saveSession({ full: true });
  start(from);

  // Survey what is already on disk, then render whatever is missing exactly
  // once. Revisiting this page later finds everything cached and does no work.
  const myToken = ++sweepToken;
  surveyRendered()
    .then(() => { if (myToken === sweepToken) return sweep(myToken); })
    .catch((err) => console.warn("[vox] render sweep failed", err));
}

async function togglePlay() {
  if (!chunks.length) return;
  if (state.status === "paused") {
    await ctx().resume();
    pushState({ status: currentSource ? "playing" : "buffering" });
    tellPage("RESUME");
    if (!currentSource) start(state.index);
    return;
  }
  if (state.status === "playing" || state.status === "buffering") {
    await ctx().suspend();
    pushState({ status: "paused" });
    tellPage("PAUSE");
    return;
  }
  start(state.index);
}

function stop() {
  epoch++;
  stopSource();
  audioCache.clear();
  if (audioCtx) audioCtx.suspend().catch(() => {});
  pushState({ status: "ready", index: 0, chunkPreview: "" });
  saveSession();
  if (tabId != null) post({ to: "bg", type: "CLEAR", tabId });
}

function seek(delta, absolute) {
  if (!chunks.length) return;
  const target = absolute != null ? absolute : state.index + delta;
  const next = Math.min(Math.max(target, 0), chunks.length - 1);
  start(next);
}

async function setParam(patch) {
  const restart = ("voice" in patch && patch.voice !== state.voice)
    || ("speed" in patch && patch.speed !== state.speed);
  const profileChanged = "profile" in patch && patch.profile !== state.profile;

  Object.assign(state, patch);
  await ask("SAVE_SETTINGS", {
    settings: { voice: state.voice, speed: state.speed, profile: state.profile },
  });

  if (patch.voice) await seedBundledVoice(patch.voice);

  if (profileChanged) {
    epoch++;
    sweepToken++;
    rendered.clear();
    stopSource();
    audioCache.clear();
    // failWorker rejects the in-flight promises. Dropping them silently would
    // leave genChain awaiting something that can never settle, and every later
    // sentence would queue behind it forever.
    failWorker(new Error("Model changed"));
    genChain = Promise.resolve();
    pushState({ ready: false, status: "idle" });
    return;
  }

  audioCache.clear();
  const wasPlaying = state.status === "playing" || state.status === "buffering";
  if (restart) {
    // A different voice or rate is a different waveform, so the previous
    // renders no longer apply — but they stay on disk for switching back.
    rendered.clear();
    pushState({ rendered: 0 });
    if (speakerVoices.size) await castSpeakers([...speakerVoices.keys()]);
    epoch++;
    stopSource();
    const myToken = ++sweepToken;
    surveyRendered()
      .then(() => { if (myToken === sweepToken) return sweep(myToken); })
      .catch(() => {});
    if (wasPlaying) start(state.index);
    return;
  }
  pushState({});
}

/* ---------------------------------------------------------------- routing */

const handlers = {
  GET_STATE: () => snapshot(),
  GET_CHUNKS: () => chunks.map((c) => c.text),
  // Timing of a rendered clip: how long it runs and how much silence leads it.
  CLIP_INFO: async (msg) => {
    const clip = await synth(msg.index);
    if (!clip) return null;
    return {
      duration: clip.duration,
      lead: clip.words?.length ? clip.words[0][0] : null,
      voice: voiceFor(chunks[msg.index]),
    };
  },
  CAPABILITIES: async () => {
    let gpu = false;
    try { gpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch { /* none */ }
    return { gpu, cores: navigator.hardwareConcurrency || 0 };
  },
  CACHE_STATS: async () => ({ bytes: await store.totalBytes(), rendered: rendered.size, total: chunks.length }),
  CLEAR_CACHE: async () => { await store.clear(); rendered.clear(); reportRendered(); return true; },
  SPEAK: (msg) => speak(msg),
  TOGGLE: () => togglePlay(),
  STOP: () => stop(),
  NEXT: () => seek(1),
  PREV: () => seek(-1),
  SEEK: (msg) => seek(0, msg.index),
  SET: (msg) => setParam(msg.patch || {}),
  PRELOAD: () => loadModel().then(() => true).catch(() => false),
  SPEED_STEP: (msg) => {
    const steps = [0.7, 0.85, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0];
    const at = steps.reduce((best, v, idx) =>
      Math.abs(v - state.speed) < Math.abs(steps[best] - state.speed) ? idx : best, 0);
    const next = steps[Math.min(Math.max(at + msg.delta, 0), steps.length - 1)];
    return setParam({ speed: next });
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.to !== "off") return false;
  const handler = handlers[msg.type];
  if (!handler) return false;
  Promise.resolve(handler(msg))
    .then((value) => sendResponse({ ok: true, value, state: snapshot() }))
    .catch((err) => sendResponse({ ok: false, error: friendlyError(err) }));
  return true; // async response
});

/* ------------------------------------------------------------------- boot */

// Older builds offered "tiny", "gpu" and "compact". Map them forward rather
// than silently falling back to balanced on a machine that has a GPU.
function normaliseProfile(name) {
  if (name === "balanced" || name === "best") return name;
  if (name === "gpu" || name === "compact") return "best";
  if (name === "tiny") return "balanced";
  return null;
}

async function defaultProfile() {
  // Kokoro on the CPU is a sustained multi-core WASM load — the thing that
  // makes a laptop hot. Measured real-time factors on Apple silicon:
  //   q8 wasm 6 threads 0.79   q8 wasm 1 thread 1.52   q8 webgpu 1.08
  //   q4 webgpu 0.19           fp16 webgpu 0.16
  // Note q8 is *worse* on WebGPU than on threaded CPU, so the answer is not to
  // move the balanced profile onto the GPU — it is to pick a GPU-shaped model
  // in the first place when there is a GPU to use.
  try {
    if (navigator.gpu && (await navigator.gpu.requestAdapter())) return "best";
  } catch { /* no adapter */ }
  return "balanced";
}

(async () => {
  const saved = (await ask("LOAD_SETTINGS"))?.settings || {};
  Object.assign(state, {
    voice: saved.voice || state.voice,
    speed: saved.speed || state.speed,
    profile: normaliseProfile(saved.profile) || (await defaultProfile()),
  });
  await restoreSession();
  pushState({});
  // If the model is already cached this resolves in a second or two, so the
  // first Ctrl+Shift+U of a session speaks immediately.
  const cached = await caches.has("transformers-cache");
  if (cached || saved.autoload) loadModel().catch(() => {});
})();
