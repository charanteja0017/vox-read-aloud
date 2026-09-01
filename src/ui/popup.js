/* Vox popup — a remote control. All state lives in the offscreen engine, so
   this file renders what it is told and never guesses. */

const VOICES = [
  { id: "af_heart",   label: "Heart — warm, expressive",  group: "American · Female" },
  { id: "af_bella",   label: "Bella — bright, energetic", group: "American · Female" },
  { id: "af_nicole",  label: "Nicole — soft, close-mic",  group: "American · Female" },
  { id: "af_aoede",   label: "Aoede — calm, even",        group: "American · Female" },
  { id: "af_kore",    label: "Kore — clear, neutral",     group: "American · Female" },
  { id: "af_sarah",   label: "Sarah — friendly",          group: "American · Female" },
  { id: "am_michael", label: "Michael — steady narrator", group: "American · Male" },
  { id: "am_fenrir",  label: "Fenrir — deep, grounded",   group: "American · Male" },
  { id: "am_puck",    label: "Puck — light, quick",       group: "American · Male" },
  { id: "bf_emma",    label: "Emma — poised RP",          group: "British · Female" },
  { id: "bm_george",  label: "George — measured RP",      group: "British · Male" },
  { id: "bm_fable",   label: "Fable — storytelling",      group: "British · Male" },
];

// Each profile downloads one specific file, and which one depends on whether
// this machine has WebGPU — so the sizes shown are the sizes actually fetched.
const PROFILE_COPY = {
  balanced: {
    title: "Balanced voice",
    gpu: { size: "88 MB", note: "8-bit weights on the CPU. Works everywhere, but runs warm." },
    cpu: { size: "88 MB", note: "8-bit weights on the CPU. Works on every machine." },
  },
  best: {
    title: "GPU voice",
    gpu: { size: "310 MB", note: "Full-precision weights on your GPU. Five times faster, and cool." },
    cpu: { size: "88 MB", note: "No WebGPU here, so this falls back to the balanced CPU model." },
  },
};

const $ = (id) => document.getElementById(id);
const el = {
  statusPill: $("statusPill"), rtfChip: $("rtfChip"),
  modelTitle: $("modelTitle"), modelSub: $("modelSub"), downloadBtn: $("downloadBtn"),
  progressWrap: $("progressWrap"), progressBar: $("progressBar"), errorDetail: $("errorDetail"),
  docTitle: $("docTitle"), cast: $("cast"), preview: $("preview"), upNext: $("upNext"),
  counter: $("counter"), prepared: $("prepared"),
  scrub: $("scrub"), scrubPrepared: $("scrubPrepared"), scrubPlayed: $("scrubPlayed"),
  scrubKnob: $("scrubKnob"), scrubTip: $("scrubTip"), scrubTipNum: $("scrubTipNum"), scrubTipText: $("scrubTipText"),
  prevBtn: $("prevBtn"), playBtn: $("playBtn"), playIcon: $("playIcon"), nextBtn: $("nextBtn"), stopBtn: $("stopBtn"),
  readBtn: $("readBtn"), voice: $("voice"), speed: $("speed"), speedValue: $("speedValue"),
  profile: $("profile"), shortcutList: $("shortcutList"), editShortcuts: $("editShortcuts"),
  anchorToggle: $("anchorToggle"), toast: $("toast"), kbdRead: $("kbdRead"), cacheInfo: $("cacheInfo"),
  transcript: $("transcript"),
  gpuBanner: $("gpuBanner"), gpuBannerWhy: $("gpuBannerWhy"), gpuSwitch: $("gpuSwitch"),
};

const PLAY_PATH = "M8 5v14l11-7z";
const PAUSE_PATH = "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z";

let current = null;
let hasGPU = false;
let chunkTexts = [];
let speedTimer = null;
let pendingSpeed = null;

/* ------------------------------------------------------------- messaging */

// Routed through the service worker: it revives the offscreen document if
// Chrome has closed it.
async function engine(type, extra = {}) {
  try {
    return await chrome.runtime.sendMessage({ to: "bg", type: "ENGINE", payload: { type, ...extra } });
  } catch {
    return null;
  }
}

async function background(type, extra = {}) {
  try {
    return await chrome.runtime.sendMessage({ to: "bg", type, ...extra });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ toast */

let toastTimer = null;
function showToast(message, isError = true, sticky = false) {
  el.toast.textContent = message;
  el.toast.dataset.tone = isError ? "error" : "info";
  el.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  // A message that never clears itself would still be sitting there during
  // perfectly healthy playback ten minutes later.
  if (!sticky) toastTimer = setTimeout(hideToast, 6000);
}
function hideToast() {
  clearTimeout(toastTimer);
  el.toast.classList.add("hidden");
}

/* --------------------------------------------------------------- rendering */

const STATUS_COPY = {
  idle: ["Idle", ""],
  loading: ["Loading", "work"],
  ready: ["Ready", ""],
  buffering: ["Synthesizing", "work"],
  playing: ["Playing", "live"],
  paused: ["Paused", ""],
  error: ["Error", "error"],
};

const voiceName = (id) => (VOICES.find((v) => v.id === id)?.label || id).split(" — ")[0];
const mb = (bytes) => `${(bytes / 1048576).toFixed(bytes > 10 * 1048576 ? 0 : 1)} MB`;
const profileCopy = (name) => {
  const entry = PROFILE_COPY[name] || PROFILE_COPY.balanced;
  return { title: entry.title, ...(hasGPU ? entry.gpu : entry.cpu) };
};

// The rendered set is not a contiguous prefix, so paint it as hard-stop bands.
let gradientCache = { key: "", value: "none" };
function preparedGradient(mask, total) {
  const key = `${total}:${mask}`;
  if (key === gradientCache.key) return gradientCache.value;
  gradientCache = { key, value: buildGradient(mask, total) };
  return gradientCache.value;
}

function buildGradient(mask, total) {
  if (!mask || !total) return "none";
  const stops = [];
  let i = 0;
  while (i < mask.length) {
    const on = mask[i] === "1";
    let j = i;
    while (j < mask.length && (mask[j] === "1") === on) j++;
    const from = (i / total) * 100;
    const to = (j / total) * 100;
    const colour = on ? "color-mix(in srgb, var(--accent) 45%, transparent)" : "transparent";
    stops.push(`${colour} ${from}%`, `${colour} ${to}%`);
    i = j;
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

function render(state) {
  current = state;
  window.__voxLastState = state;   // read by the popup test harness
  const [text, tone] = STATUS_COPY[state.status] || ["Idle", ""];
  el.statusPill.textContent = text;
  if (tone) el.statusPill.dataset.tone = tone; else delete el.statusPill.dataset.tone;

  // Honest about performance: below 1.0x it can outrun playback, above it cannot.
  if (state.rtf) {
    el.rtfChip.classList.remove("hidden");
    el.rtfChip.textContent = `${state.rtf}× realtime`;
    if (state.keepingUp) delete el.rtfChip.dataset.tone;
    else el.rtfChip.dataset.tone = "warn";
  } else {
    el.rtfChip.classList.add("hidden");
  }

  const copy = profileCopy(state.profile);
  if (state.status === "loading" && state.download) {
    const { pct, loaded, total } = state.download;
    el.modelTitle.textContent = `Downloading… ${pct}%`;
    el.modelSub.textContent = total ? `${mb(loaded)} of ${mb(total)} · cached for offline use` : "Starting…";
    el.progressWrap.classList.remove("hidden");
    el.progressBar.style.width = `${pct}%`;
    el.downloadBtn.disabled = true;
    el.downloadBtn.textContent = "…";
  } else if (state.status === "loading") {
    el.modelTitle.textContent = "Preparing model…";
    el.modelSub.textContent = "Warming up the audio engine.";
    el.progressWrap.classList.remove("hidden");
    el.progressBar.style.width = "8%";
    el.downloadBtn.disabled = true;
    el.downloadBtn.textContent = "…";
  } else if (state.status === "error") {
    el.modelTitle.textContent = state.downloaded ? "Voice engine wouldn't start" : "Download failed";
    el.modelSub.textContent = state.error || "Something went wrong.";
    el.progressWrap.classList.add("hidden");
    el.downloadBtn.disabled = false;
    el.downloadBtn.textContent = "Retry";
  } else if (state.ready) {
    const where = state.device === "webgpu" ? "on your GPU" : `on ${state.threads || 1} CPU threads`;
    el.modelTitle.textContent = `${copy.title} ready`;
    el.modelSub.textContent = `Running ${where}. Nothing leaves your device.`;
    el.progressWrap.classList.add("hidden");
    el.downloadBtn.disabled = true;
    el.downloadBtn.textContent = "Ready";
  } else {
    el.modelTitle.textContent = "Voice model not downloaded";
    el.modelSub.textContent = `${copy.title} · ${copy.size} · one-time download.`;
    el.progressWrap.classList.add("hidden");
    el.downloadBtn.disabled = false;
    el.downloadBtn.textContent = "Download";
  }

  // Offer the GPU when there is one and it is not being used. This is the
  // single biggest lever on both heat and the pauses, so it earns the space.
  const showBanner = hasGPU && state.device !== "webgpu" && state.profile !== "best";
  el.gpuBanner.classList.toggle("hidden", !showBanner);
  if (showBanner) {
    el.gpuBannerWhy.textContent = state.rtf && !state.keepingUp
      ? `Speech is generating at ${state.rtf}× realtime on ${state.threads || 6} CPU threads — slower than it plays, which is why it pauses.`
      : `Speech is generating on ${state.threads || 6} CPU threads, which is what makes the laptop warm.`;
  }

  el.errorDetail.textContent = state.errorDetail || "";
  el.errorDetail.classList.toggle("hidden", !state.errorDetail);

  el.docTitle.textContent = state.title || "Nothing yet";

  // When a page turns out to be a dialogue, say who is playing whom.
  const cast = state.speakers || [];
  el.cast.classList.toggle("hidden", cast.length < 2);
  if (cast.length >= 2) {
    el.cast.innerHTML = "";
    for (const { name, voice } of cast) {
      const chip = document.createElement("span");
      const who = document.createElement("b");
      who.textContent = name;
      chip.append(who, document.createTextNode(` · ${voiceName(voice)}`));
      el.cast.appendChild(chip);
    }
  }
  const speaking = ["playing", "buffering", "paused"].includes(state.status);
  if (state.chunkPreview) {
    el.preview.textContent = state.chunkPreview;
    el.preview.classList.toggle("speaking", speaking);
  } else if (!speaking) {
    el.preview.innerHTML = `Press <kbd>${commandMap["read-aloud"] || "your shortcut"}</kbd> on any page, or use Read this page.`;
    el.preview.classList.remove("speaking");
  }

  const next = chunkTexts[state.index + 1];
  if (speaking && next) {
    el.upNext.textContent = next;
    el.upNext.classList.remove("hidden");
  } else {
    el.upNext.classList.add("hidden");
  }

  if (!dragging) paintScrub(state.index, state);
  markTranscript(state.index);

  el.counter.textContent = state.total
    ? `Sentence ${state.index + 1} of ${state.total}${state.source === "selection" ? " · selection" : ""}`
    : "—";
  if (state.total) {
    const done = state.rendered >= state.total;
    el.prepared.textContent = done ? "All audio prepared" : `Preparing audio · ${state.rendered}/${state.total}`;
    el.prepared.dataset.done = done ? "1" : "0";
  } else {
    el.prepared.textContent = "";
  }

  const isPlaying = state.status === "playing" || state.status === "buffering";
  el.playIcon.firstElementChild?.setAttribute("d", isPlaying ? PAUSE_PATH : PLAY_PATH);
  el.playBtn.disabled = !state.hasContent;
  el.prevBtn.disabled = !state.hasContent || state.index === 0;
  el.nextBtn.disabled = !state.hasContent || state.index >= state.total - 1;
  el.stopBtn.disabled = !state.hasContent;
  el.scrub.setAttribute("aria-disabled", state.hasContent && state.total > 1 ? "false" : "true");

  if (document.activeElement !== el.voice) el.voice.value = state.voice;
  if (document.activeElement !== el.profile) el.profile.value = state.profile;
  // Never fight the slider the user is holding, but do not go stale either.
  if (document.activeElement !== el.speed && pendingSpeed === null) {
    el.speed.value = state.speed;
    el.speedValue.textContent = `${Number(state.speed).toFixed(2).replace(/0$/, "")}×`;
  }
}

/* -------------------------------------------------------------- scrubber */

let dragging = false;
let dragIndex = 0;

let transcriptRows = [];
function renderTranscript(state) {
  el.transcript.innerHTML = "";
  transcriptRows = [];
  if (!chunkTexts.length) {
    el.transcript.classList.add("hidden");
    return;
  }
  el.transcript.classList.remove("hidden");
  const frag = document.createDocumentFragment();
  chunkTexts.forEach((text, i) => {
    const row = document.createElement("button");
    row.className = "line";
    row.type = "button";
    row.dataset.index = String(i);
    const num = document.createElement("b");
    num.textContent = String(i + 1);
    const body = document.createElement("span");
    body.textContent = text;
    row.append(num, body);
    frag.appendChild(row);
    transcriptRows.push(row);
  });
  el.transcript.appendChild(frag);
  markTranscript(state?.index ?? 0);
}

let markedRow = -1;
function markTranscript(index) {
  if (index === markedRow) return;
  transcriptRows[markedRow]?.classList.remove("current");
  const row = transcriptRows[index];
  if (row) {
    row.classList.add("current");
    row.scrollIntoView({ block: "nearest" });
  }
  markedRow = index;
}

function paintScrub(index, state) {
  const total = state?.total || 0;
  const fraction = total > 1 ? index / (total - 1) : 0;
  el.scrubPlayed.style.width = `${fraction * 100}%`;
  el.scrubKnob.style.left = `${fraction * 100}%`;
  el.scrubPrepared.style.background = preparedGradient(state?.renderedMask, total);
  el.scrub.setAttribute("aria-valuemin", "1");
  el.scrub.setAttribute("aria-valuemax", String(Math.max(total, 1)));
  el.scrub.setAttribute("aria-valuenow", String(index + 1));
  el.scrub.setAttribute("aria-valuetext", `Sentence ${index + 1} of ${total}`);
}

function indexFromEvent(event) {
  const total = current?.total || 0;
  if (total < 1) return 0;
  const rect = el.scrub.querySelector(".scrub-hit").getBoundingClientRect();
  const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
  return Math.round(ratio * (total - 1));
}

function showTip(index, clientX) {
  const rect = el.scrub.getBoundingClientRect();
  const x = Math.min(Math.max(clientX - rect.left, 60), rect.width - 60);
  el.scrubTip.style.left = `${x}px`;
  el.scrubTipNum.textContent = `Sentence ${index + 1} of ${current?.total || 0}`;
  el.scrubTipText.textContent = chunkTexts[index] || "";
  el.scrubTip.classList.remove("hidden");
}

el.scrub.addEventListener("pointerdown", (event) => {
  if (el.scrub.getAttribute("aria-disabled") === "true") return;
  dragging = true;
  el.scrub.classList.add("dragging");
  el.scrub.setPointerCapture(event.pointerId);
  dragIndex = indexFromEvent(event);
  paintScrub(dragIndex, current);
  showTip(dragIndex, event.clientX);
});

el.scrub.addEventListener("pointermove", (event) => {
  if (el.scrub.getAttribute("aria-disabled") === "true") return;
  const index = indexFromEvent(event);
  if (dragging) {
    dragIndex = index;
    paintScrub(index, current);
  }
  showTip(index, event.clientX);
});

function endDrag(event) {
  if (!dragging) return;
  dragging = false;
  el.scrub.classList.remove("dragging");
  try { el.scrub.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  el.scrubTip.classList.add("hidden");
  // Seeking on release rather than on every pixel: each seek restarts audio.
  engine("SEEK", { index: dragIndex });
}

el.scrub.addEventListener("pointerup", endDrag);
el.scrub.addEventListener("pointercancel", endDrag);
el.scrub.addEventListener("pointerleave", () => { if (!dragging) el.scrubTip.classList.add("hidden"); });

el.scrub.addEventListener("keydown", (event) => {
  const total = current?.total || 0;
  if (!total) return;
  const at = current.index;
  const moves = {
    ArrowLeft: at - 1, ArrowRight: at + 1,
    PageUp: at - 10, PageDown: at + 10,
    Home: 0, End: total - 1,
  };
  if (!(event.key in moves)) return;
  event.preventDefault();
  engine("SEEK", { index: Math.min(Math.max(moves[event.key], 0), total - 1) });
});

/* ------------------------------------------------------------- shortcuts */

let commandMap = {};
async function loadShortcuts() {
  const commands = await chrome.commands.getAll();
  const labels = {
    "read-aloud": "Read page / selection",
    "play-pause": "Play or pause",
    "stop": "Stop",
    "next-sentence": "Next sentence",
    "prev-sentence": "Previous sentence",
    "speed-up": "Speak faster",
    "speed-down": "Speak slower",
  };
  el.shortcutList.innerHTML = "";
  for (const cmd of commands) {
    if (!cmd.name || cmd.name.startsWith("_")) continue;
    commandMap[cmd.name] = cmd.shortcut;
    const li = document.createElement("li");
    const name = document.createElement("b");
    name.textContent = labels[cmd.name] || cmd.description || cmd.name;
    const key = document.createElement("kbd");
    key.textContent = cmd.shortcut || "unassigned";
    li.append(name, key);
    el.shortcutList.appendChild(li);
  }
  if (commandMap["read-aloud"]) el.kbdRead.textContent = commandMap["read-aloud"];
}

/* ------------------------------------------------------------------ wiring */

function buildVoiceOptions() {
  const groups = new Map();
  for (const v of VOICES) {
    if (!groups.has(v.group)) groups.set(v.group, []);
    groups.get(v.group).push(v);
  }
  for (const [name, list] of groups) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = name;
    for (const v of list) {
      const option = document.createElement("option");
      option.value = v.id;
      option.textContent = v.label;
      optgroup.appendChild(option);
    }
    el.voice.appendChild(optgroup);
  }
}

function labelProfiles() {
  for (const option of el.profile.options) {
    const copy = profileCopy(option.value);
    option.textContent = `${copy.title} — ${copy.size}`;
  }
}

el.downloadBtn.addEventListener("click", async () => {
  el.downloadBtn.disabled = true;
  el.downloadBtn.textContent = "…";
  el.errorDetail.classList.add("hidden");
  await chrome.storage.local.set({ autoload: true });
  await engine("PRELOAD");
});

el.gpuSwitch.addEventListener("click", async () => {
  el.gpuSwitch.disabled = true;
  el.gpuSwitch.textContent = "Downloading…";
  await engine("SET", { patch: { profile: "best" } });
  await chrome.storage.local.set({ autoload: true });
  await engine("PRELOAD");
  el.gpuSwitch.disabled = false;
  el.gpuSwitch.textContent = "Use the GPU · 310 MB";
});

el.playBtn.addEventListener("click", () => engine("TOGGLE"));
el.prevBtn.addEventListener("click", () => engine("PREV"));
el.nextBtn.addEventListener("click", () => engine("NEXT"));
el.stopBtn.addEventListener("click", () => engine("STOP"));

el.readBtn.addEventListener("click", async () => {
  el.readBtn.disabled = true;
  el.readBtn.textContent = "Reading…";
  const res = await background("READ_ACTIVE_TAB");
  el.readBtn.disabled = false;
  el.readBtn.textContent = "Read this page";
  // Only get out of the way if it worked; otherwise the popup is the only
  // place the failure can be explained.
  if (res?.ok && res.started) window.close();
  else if (res && !res.started) showToast(res.reason || "Couldn't read this page.", true);
  chunkSig = null;
  await refreshChunks(current);
});

el.voice.addEventListener("change", () => engine("SET", { patch: { voice: el.voice.value } }));

function commitSpeed() {
  if (pendingSpeed === null) return;
  const value = pendingSpeed;
  pendingSpeed = null;
  engine("SET", { patch: { speed: value } });
}

el.speed.addEventListener("input", () => {
  pendingSpeed = Number(el.speed.value);
  el.speedValue.textContent = `${pendingSpeed.toFixed(2).replace(/0$/, "")}×`;
  clearTimeout(speedTimer);
  speedTimer = setTimeout(commitSpeed, 250);
});
// A popup can be dismissed inside the debounce window, silently losing the change.
el.speed.addEventListener("change", commitSpeed);
window.addEventListener("pagehide", commitSpeed);

el.profile.addEventListener("change", async () => {
  const wanted = el.profile.value;
  const res = await engine("SET", { patch: { profile: wanted } });
  labelProfiles();
  if (res?.state?.profile === wanted) {
    showToast(`Switched to the ${profileCopy(wanted).title.toLowerCase()}. Download it to start using it.`, false, true);
  } else {
    showToast("Could not switch model.", true);
  }
});

el.anchorToggle.addEventListener("change", async () => {
  const wanted = el.anchorToggle.checked;
  let granted = false;
  try {
    granted = wanted
      ? await chrome.permissions.request({ origins: ["<all_urls>"] })
      : !(await chrome.permissions.remove({ origins: ["<all_urls>"] }));
  } catch (err) {
    showToast(String(err.message || err), true);
  }
  // The service worker is the authority on what is actually registered.
  const res = await background("SET_ANCHOR", { enabled: granted });
  el.anchorToggle.checked = !!res?.granted;
  if (wanted && !res?.granted) showToast("Permission declined, so right-click reading stays off.", false);
});

el.transcript.addEventListener("click", (event) => {
  const row = event.target.closest(".line");
  if (!row) return;
  engine("SEEK", { index: Number(row.dataset.index) });
});

el.editShortcuts.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.to !== "ui") return false;
  if (msg.type === "STATE") {
    render(msg.state);
    refreshChunks(msg.state);
  }
  if (msg.type === "TOAST") showToast(msg.message, msg.isError);
  return false;
});

// Keyed on the document, not just its length: a different article with the
// same sentence count would otherwise keep the old transcript. The signature is
// claimed before awaiting so a failure cannot retry once per sentence forever.
let chunkSig = null;
async function refreshChunks(state) {
  const sig = `${state?.title || ""}|${state?.total || 0}`;
  if (sig === chunkSig) return;
  chunkSig = sig;
  const res = await engine("GET_CHUNKS");
  chunkTexts = Array.isArray(res?.value) ? res.value : [];
  renderTranscript(state);
}

async function refreshCacheInfo() {
  const res = await engine("CACHE_STATS");
  const bytes = res?.value?.bytes || 0;
  el.cacheInfo.textContent = bytes ? `${mb(bytes)} of speech cached` : "";
}

/* --------------------------------------------------------------------- go */

(async () => {
  buildVoiceOptions();
  await loadShortcuts();
  await background("ENSURE_ENGINE");

  const caps = await engine("CAPABILITIES");
  hasGPU = !!caps?.value?.gpu;
  labelProfiles();

  el.anchorToggle.checked = !!(await background("ANCHOR_STATE"))?.granted;

  const res = await engine("GET_STATE");
  if (res?.state) {
    render(res.state);
    await refreshChunks(res.state);
  } else {
    // Say so rather than presenting a transport that controls nothing.
    showToast("The speech engine isn't responding. Reload the extension if this persists.", true);
  }
  await refreshCacheInfo();
  setInterval(refreshCacheInfo, 4000);
})();
