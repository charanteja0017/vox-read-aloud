/* Loads dist/ into a real Chrome, downloads the model, and synthesizes a
   sentence — end to end, through the extension's own message protocol. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Branded Chrome refuses --load-extension, so this needs a Chrome for Testing
// build. Point CHROME_BIN at one, or run:
//   npx @puppeteer/browsers install chrome@stable --path .browsers
const CHROME = process.env.CHROME_BIN
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const DIST = path.resolve(process.env.VOX_DIST || "dist");
const HEADFUL = process.argv.includes("--headful");

// A reusable profile keeps the 88 MB model download out of every run.
const profile = process.env.VOX_E2E_PROFILE || (await mkdtemp(path.join(os.tmpdir(), "vox-e2e-")));
const args = [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--load-extension=${DIST}`,
  `--disable-extensions-except=${DIST}`,
  "--autoplay-policy=no-user-gesture-required",
  "--no-first-run", "--no-default-browser-check",
  "--disable-features=DialMediaRouteProvider",
  "about:blank",
];
if (!HEADFUL) args.unshift("--headless=new");

const chrome = spawn(CHROME, args, { stdio: ["ignore", "pipe", "pipe"] });
let chromeLog = "";
chrome.stderr.on("data", (d) => { chromeLog += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browserWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return (await res.json()).webSocketDebuggerUrl;
    } catch { await sleep(250); }
  }
  throw new Error(`Chrome never opened the debug port.\n${chromeLog}`);
}

/* ------------------------------------------------------------------- CDP */

let ws, nextId = 1;
const pending = new Map();

function cdp(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function connect(url) {
  ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === "Target.attachedToTarget") {
      const sid = msg.params.sessionId;
      cdp("Runtime.enable", {}, sid).catch(() => {});
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled" && /warn|error/.test(msg.params.type)) {
      console.log("    [page]", msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 500));
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      console.log("    [exception]", (d.exception?.description || d.text || "").slice(0, 500));
    }
    if (!msg.id) return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message));
    else slot.resolve(msg.result);
  };
}

/* ------------------------------------------------------------------ steps */

let failures = 0;
function step(name, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

try {
  await connect(await browserWs());
  await cdp("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  // An unpacked extension's id is the first 128 bits of sha256(absolute path),
  // with each hex nibble remapped onto a-p. Scanning targets is unreliable
  // because Chrome ships component extensions of its own.
  const digest = createHash("sha256").update(DIST, "utf8").digest("hex").slice(0, 32);
  const extensionId = [...digest].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

  let registered = false;
  for (let i = 0; i < 80 && !registered; i++) {
    const { targetInfos } = await cdp("Target.getTargets");
    registered = targetInfos.some((t) => t.url.includes(extensionId));
    if (!registered) await sleep(250);
  }
  step("extension loads", registered, extensionId);
  if (!registered) throw new Error(`extension ${extensionId} never registered\n${chromeLog.slice(-600)}`);

  // Drive everything from an extension page: it has the full chrome.* API and,
  // unlike the service worker, it will not be evicted mid-test.
  const { targetId } = await cdp("Target.createTarget", {
    url: `chrome-extension://${extensionId}/ui/popup.html`,
  });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Runtime.enable", {}, sessionId);
  await sleep(800);

  const evaluate = async (expression) => {
    const res = await cdp("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || "eval failed");
    return res.result.value;
  };

  const engine = (payload) =>
    evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ to: "bg", type: "ENGINE", payload })})`);

  await evaluate(`chrome.runtime.sendMessage({to:"bg",type:"ENSURE_ENGINE"})`);
  await sleep(500);

  const initial = await engine({ type: "GET_STATE" });
  step("offscreen engine responds", !!initial?.state, initial?.state?.status);

  const commands = await evaluate(`chrome.commands.getAll()`);
  const bound = Object.fromEntries(commands.map((c) => [c.name, c.shortcut]));
  step("read shortcut is bound", !!bound["read-aloud"], bound["read-aloud"]);
  step("play/pause shortcut is bound", !!bound["play-pause"], bound["play-pause"]);
  step("stop shortcut is bound", !!bound["stop"], bound["stop"]);
  step("next-sentence shortcut is bound", !!bound["next-sentence"], bound["next-sentence"]);
  // Chrome adds an implicit _execute_action alongside the seven declared ones.
  const declared = commands.filter((c) => !c.name.startsWith("_"));
  step("all seven commands are registered", declared.length === 7, `${declared.length} declared`);
  step("suggested keys stay within Chrome's limit of four",
    declared.filter((c) => c.shortcut).length <= 4,
    `${declared.filter((c) => c.shortcut).length} bound by default`);

  console.log("\n  downloading model (first run only)…");
  const preload = engine({ type: "PRELOAD" });
  let settled = false;
  preload.then(() => { settled = true; }, () => { settled = true; });

  let lastLine = "";
  for (let i = 0; i < 480 && !settled; i++) {
    await sleep(1500);
    const { state } = (await engine({ type: "GET_STATE" })) || {};
    if (!state) continue;
    const d = state.download;
    const line = d && d.total
      ? `    ${String(d.pct).padStart(3)}%  ${(d.loaded / 1048576).toFixed(1)}/${(d.total / 1048576).toFixed(1)} MB  ${d.file}`
      : `    ${state.status}`;
    if (line !== lastLine) { console.log(line); lastLine = line; }
    if (state.status === "ready" || state.status === "error") break;
  }
  await preload.catch(() => {});

  const loaded = (await engine({ type: "GET_STATE" })).state;
  step("model ready", loaded.ready === true, loaded.error || loaded.status);
  if (!loaded.ready) throw new Error(loaded.error || "model did not load");

  // Word timings drive the moving highlight, so they have to line up with the
  // real audio — not merely exist.
  const SENTENCE = "The kettle refused to boil, humming faintly to itself, so I gave up.";
  const timing = await evaluate(`(async () => {
    const w = new Worker(chrome.runtime.getURL("tts-worker.js"), { type: "module" });
    let seq = 0;
    const call = (msg) => new Promise((res, rej) => {
      const id = ++seq;
      const on = (e) => { if (e.data.id !== id) return; w.removeEventListener("message", on);
        e.data.ok ? res(e.data.result) : rej(new Error(e.data.error)); };
      w.addEventListener("message", on); w.postMessage({ id, ...msg });
    });
    await call({ type: "load", profile: "balanced", voice: "af_heart" });
    const r = await call({ type: "generate", text: ${JSON.stringify(SENTENCE)}, voice: "af_heart", speed: 1 });
    w.terminate();
    return { words: r.words, seconds: r.pcm.length / r.sampleRate };
  })()`);

  const sourceWords = SENTENCE.split(/\s+/).filter(Boolean).length;
  const words = timing.words || [];
  step("model returns word timings", words.length > 0, `${words.length} spans`);
  step("one timing per word", words.length === sourceWords, `${words.length} vs ${sourceWords} words`);
  step("timings are monotonic",
    words.every((w, i) => w[1] >= w[0] && (i === 0 || w[0] >= words[i - 1][1] - 1e-6)));
  step("timings span the whole clip",
    words.length > 0 && Math.abs(words[words.length - 1][1] - timing.seconds) < 0.4,
    `last word ends ${words[words.length - 1]?.[1].toFixed(2)}s of ${timing.seconds.toFixed(2)}s`);
  step("no word is implausibly long",
    words.every(([a, b]) => b - a < 1.6), `longest ${Math.max(...words.map(([a,b]) => b-a)).toFixed(2)}s`);

  console.log("\n  synthesizing…");
  const t0 = Date.now();
  await engine({
    type: "SPEAK",
    title: "E2E test",
    source: "page",
    chunks: [
      { i: 0, text: "The quick brown fox jumps over the lazy dog." },
      { i: 1, text: "Vox reads the web aloud with a voice that runs on your own machine." },
    ],
  });

  let spoke = null;
  for (let i = 0; i < 120; i++) {
    const { state } = await engine({ type: "GET_STATE" });
    if (state.status === "playing") { spoke = state; break; }
    if (state.status === "error") { spoke = state; break; }
    await sleep(500);
  }
  const ms = Date.now() - t0;
  step("first sentence synthesized and playing", spoke?.status === "playing",
    spoke?.status === "playing" ? `${(ms / 1000).toFixed(1)}s to first audio` : spoke?.error);

  // Transport controls act on real state.
  await engine({ type: "TOGGLE" });
  await sleep(400);
  const paused = (await engine({ type: "GET_STATE" })).state;
  step("pause works", paused.status === "paused", paused.status);

  await engine({ type: "TOGGLE" });
  await sleep(400);
  const resumed = (await engine({ type: "GET_STATE" })).state;
  step("resume works", resumed.status === "playing" || resumed.status === "buffering", resumed.status);

  await engine({ type: "NEXT" });
  await sleep(1500);
  const advanced = (await engine({ type: "GET_STATE" })).state;
  step("skip to next sentence", advanced.index === 1, `index ${advanced.index}`);

  // An AUDIO_PLAYBACK-only offscreen document is closed after 30s of silence,
  // which would drop the reading position on every pause. Declaring WORKERS too
  // (which is accurate — synthesis runs in one) removes that timer.
  await engine({ type: "TOGGLE" });
  await sleep(600);
  const beforeIdle = (await engine({ type: "GET_STATE" })).state;
  step("pause holds before the idle window", beforeIdle.status === "paused", beforeIdle.status);

  console.log("\n  holding paused through the 30s offscreen idle timeout…");
  await sleep(35000);

  const { targetInfos } = await cdp("Target.getTargets");
  step("engine survives the idle timeout",
    targetInfos.some((t) => t.url.includes("offscreen.html")), "offscreen document still alive");

  const afterIdle = (await engine({ type: "GET_STATE" }))?.state;
  step("still paused in the same place",
    afterIdle?.status === "paused" && afterIdle?.index === 1,
    `${afterIdle?.status} at ${afterIdle?.index}`);

  await engine({ type: "TOGGLE" });
  await sleep(2500);
  const resumedAfter = (await engine({ type: "GET_STATE" })).state;
  step("resumes after a long pause",
    ["playing", "buffering"].includes(resumedAfter.status), resumedAfter.status);

  // ---- dialogue casting --------------------------------------------------
  await engine({
    type: "SPEAK", title: "Clarifying Requirements", source: "page", tabId: null,
    speakers: ["Candidate", "Interviewer"],
    chunks: [
      { i: 0, text: "Clarifying Requirements", heading: true },
      { i: 1, text: "Candidate: Should we rank the results from most similar to least similar?", speaker: "Candidate" },
      { i: 2, text: "Interviewer: Images that appear first should be more similar.", speaker: "Interviewer" },
    ],
  });
  await sleep(1200);
  const cast = (await engine({ type: "GET_STATE" })).state;
  const voices = (cast.speakers || []).map((s) => s.voice);
  step("a dialogue is cast across two voices", voices.length === 2 && voices[0] !== voices[1],
    JSON.stringify(cast.speakers));
  step("the reader's own voice plays the first speaker", voices[0] === cast.voice, voices[0]);
  // A heading should land as a section break, not as another sentence.
  const headClip = (await engine({ type: "CLIP_INFO", index: 0 }))?.value;
  const bodyClip = (await engine({ type: "CLIP_INFO", index: 1 }))?.value;
  step("a heading is preceded by a real pause", (headClip?.lead ?? 0) > 0.35,
    `${(headClip?.lead ?? 0).toFixed(2)}s of silence before the heading`);
  step("body text is not padded like a heading", (bodyClip?.lead ?? 0) < 0.35,
    `${(bodyClip?.lead ?? 0).toFixed(2)}s`);
  step("each speaker's line is generated in their own voice",
    headClip?.voice !== undefined && bodyClip?.voice === "af_heart", bodyClip?.voice);
  const otherClip = (await engine({ type: "CLIP_INFO", index: 2 }))?.value;
  step("the second speaker uses the other voice", otherClip?.voice === "am_michael", otherClip?.voice);
  step("a change of speaker gets a beat", (otherClip?.lead ?? 0) > 0.15,
    `${(otherClip?.lead ?? 0).toFixed(2)}s`);

  await engine({ type: "STOP" });
  await sleep(200);

  await engine({ type: "STOP" });
  await sleep(300);
  const stopped = (await engine({ type: "GET_STATE" })).state;
  step("stop resets", stopped.status === "ready" && stopped.index === 0, stopped.status);

  // ---- the heat fix: every sentence is synthesised at most once, ever -----
  console.log("\n  waiting for the one-pass render to finish…");
  let swept = null;
  for (let i = 0; i < 240; i++) {
    const { state } = await engine({ type: "GET_STATE" });
    if (state.rendered >= state.total && state.total > 0) { swept = state; break; }
    await sleep(500);
  }
  step("whole document rendered in one pass", !!swept,
    swept ? `${swept.rendered}/${swept.total} sentences` : "never completed");

  const stats = (await engine({ type: "CACHE_STATS" }))?.value;
  step("audio landed in persistent storage", (stats?.bytes || 0) > 0,
    `${((stats?.bytes || 0) / 1024).toFixed(0)} KB on disk`);

  // Replaying the same text must not touch the model at all.
  const replayStart = Date.now();
  await engine({
    type: "SPEAK", title: "E2E replay", source: "page", tabId: null,
    chunks: [
      { i: 0, text: "The quick brown fox jumps over the lazy dog." },
      { i: 1, text: "Vox reads the web aloud with a voice that runs on your own machine." },
    ],
  });
  let replayed = null;
  for (let i = 0; i < 60; i++) {
    const { state } = await engine({ type: "GET_STATE" });
    if (state.status === "playing") { replayed = Date.now() - replayStart; break; }
    await sleep(100);
  }
  step("a revisited page starts from cache, not the model", replayed !== null && replayed < 1500,
    replayed === null ? "never started" : `${(replayed / 1000).toFixed(2)}s to first audio (was ~3s cold)`);

  await engine({ type: "STOP" });

  console.log(`\n  ${failures ? `${failures} failed` : "all checks passed"}\n`);
} catch (err) {
  console.error("\n  ERROR:", err.message);
  if (chromeLog) console.error(chromeLog.split("\n").filter((l) => /vox|error|ERROR/i.test(l)).slice(-15).join("\n"));
  failures++;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill("SIGKILL");
  if (!process.env.VOX_E2E_PROFILE) await rm(profile, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
