/* Vox synthesis worker.

   Kokoro inference is synchronous WASM. Running it on the offscreen document's
   main thread would freeze the message loop for seconds at a time, so pause and
   stop would not land until the current sentence finished generating. It lives
   in a worker instead — which is also why the offscreen document legitimately
   declares the WORKERS reason. */

import { KokoroTTS } from "kokoro-js";
import { env } from "@huggingface/transformers";

// The "-timestamped" export is the same weights re-exported with the duration
// predictor's output exposed as a second tensor. Verified bit-identical audio
// to the plain export (max sample difference 0.0) at identical file sizes, so
// word-level highlighting costs nothing in quality or download.
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped";

// The worker is served from the extension origin, so its own URL is enough to
// locate the bundled ONNX Runtime binaries — no chrome.* access needed.
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL("ort/", self.location.href).href;
env.backends.onnx.wasm.proxy = false;

// Chrome grants SharedArrayBuffer to extension contexts even though they are
// not cross-origin isolated, so ORT's threaded WASM build is usable here. It is
// the difference between synthesising slower than real time and faster.
// SharedArrayBuffer existing is not the same as shared WASM memory being
// allowed. ORT needs the latter, so probe for the real thing.
function sharedMemoryUsable() {
  if (typeof SharedArrayBuffer === "undefined") return false;
  try {
    new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    return true;
  } catch {
    return false;
  }
}

function threadBudget(requested) {
  if (requested === 1) return 1;
  if (!sharedMemoryUsable()) return 1;
  const cores = self.navigator?.hardwareConcurrency || 4;
  // Leave a couple of cores for the browser; past six the gain is noise.
  const wanted = requested || Math.min(6, Math.max(2, cores - 2));
  return Math.max(1, Math.min(wanted, cores));
}

// Measured on an M-series laptop, real-time factor over warm sentences
// (lower is better; anything at or above 1.0 stutters):
//   q4  wasm  4 threads   0.45     q4f16 webgpu   0.16
//   q8  wasm  4 threads   0.79     fp16  webgpu   0.16
//   q8  wasm  1 thread    1.52     fp32  webgpu   0.17
// WebNN (the only route to Apple's Neural Engine) is not an option: ONNX
// Runtime's WebNN provider needs 'unsafe-eval', which Manifest V3 rejects
// outright — Chrome refuses to load the extension at all.
// Each profile names one file so the download size quoted in the UI is exact;
// the second entry is the fallback for machines without WebGPU.
// Two honest choices. A q4 profile used to sit alongside these, but in this
// export model_q4.onnx is 291 MB — larger than q8 and worse — and q4f16 (147 MB)
// is within 8 MB of fp16 while sounding worse, so neither earned its slot.
// MEASURED, not assumed. Against q8/wasm as the reference, on the same sentence:
//
//   backend        real-time factor   zero-crossing rate   verdict
//   q8    wasm     0.79 (6 threads)   x1.00                reference
//   fp32  webgpu   0.17               x0.99                clean, and cool
//   fp16  webgpu   0.16               x0.39                CONSONANTS DESTROYED
//   q4f16 webgpu   0.18               x0.33                worse still
//
// Zero-crossing rate tracks high-frequency energy, which is where sibilants and
// plosives live. Every f16 path on WebGPU loses roughly two thirds of it and
// comes out sounding like noise through a pipe, so no f16 profile is offered
// however fast or small it looks. See tools/test-quality.mjs.
const PROFILES = {
  balanced: [{ dtype: "q8", device: "wasm" }],
  best: [{ dtype: "fp32", device: "webgpu" }, { dtype: "q8", device: "wasm" }],
};

let tts = null;
let loadedProfile = null;
let takeCapture = () => null;

/* --------------------------------------------------------- word timestamps */

const FRAMES_PER_SECOND = 24000 / 600;   // the vocoder emits 600 samples a frame
const SEPARATORS = new Set([" ", "$", "\n", "\t", ""]);

// kokoro-js only reads `waveform` off the model output, so wrap the callable to
// keep hold of `durations` and the ids they line up with.
function instrument(instance) {
  const inner = instance.model;
  let captured = null;
  instance.model = async (inputs) => {
    const outputs = await inner(inputs);
    captured = { ids: inputs.input_ids, durations: outputs.durations };
    return outputs;
  };
  return () => {
    const value = captured;
    captured = null;
    return value;
  };
}

function reverseVocab(tokenizer) {
  const map = new Map();
  const pairs = tokenizer?.model?.tokens_to_ids;
  if (pairs && typeof pairs.forEach === "function") {
    pairs.forEach((id, token) => map.set(id, token));
    return map;
  }
  const vocab = tokenizer?.model?.vocab;
  if (Array.isArray(vocab)) vocab.forEach((token, id) => map.set(id, token));
  else if (vocab) for (const [token, id] of Object.entries(vocab)) map.set(id, token);
  return map;
}

// Durations are per phoneme token, in frames, and already scaled by `speed`.
// Rounding each one and summing reproduces the waveform length exactly, so the
// cumulative total is a real timeline rather than an estimate.
function wordTimings(capture, tokenizer) {
  if (!capture?.durations || !capture?.ids) return null;
  const durations = Array.from(capture.durations.data);
  const ids = Array.from(capture.ids.data, Number);
  const vocab = reverseVocab(tokenizer);

  const spans = [];
  let frame = 0;
  let start = null;
  for (let i = 0; i < ids.length; i++) {
    const token = vocab.get(ids[i]) ?? "";
    if (SEPARATORS.has(token)) {
      if (start !== null) { spans.push([start, frame]); start = null; }
    } else if (start === null) {
      start = frame;
    }
    frame += Math.round(durations[i] || 0);
  }
  if (start !== null) spans.push([start, frame]);

  return spans.map(([a, b]) => [a / FRAMES_PER_SECOND, b / FRAMES_PER_SECOND]);
}

function progress(payload) {
  self.postMessage({ type: "progress", payload });
}

async function load(profileName, threads, warmVoice) {
  if (tts && loadedProfile === profileName) return loadedProfile;

  env.backends.onnx.wasm.numThreads = threadBudget(threads);
  const attempts = PROFILES[profileName] || PROFILES.balanced;
  let lastError = null;

  for (const attempt of attempts) {
    try {
      if (attempt.device === "webgpu" && !self.navigator?.gpu) throw new Error("WebGPU not available");
      tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: attempt.dtype,
        device: attempt.device,
        progress_callback: progress,
      });
      takeCapture = instrument(tts);
      loadedProfile = profileName;
      // The very first inference pays for graph warm-up and kernel compilation.
      // Spending it here keeps it off the first sentence the user asked for.
      if (warmVoice !== false) {
        try {
          await tts.generate("Ready.", { voice: warmVoice || "af_heart", speed: 1 });
        } catch (err) {
          console.warn("[vox worker] warm-up skipped", err);
        }
      }
      return {
        profile: profileName,
        dtype: attempt.dtype,
        device: attempt.device,
        threads: env.backends.onnx.wasm.numThreads,
      };
    } catch (err) {
      lastError = err;
      console.warn("[vox worker] load failed", attempt, err);
    }
  }
  tts = null;
  loadedProfile = null;
  throw lastError || new Error("Model failed to load");
}

async function generate({ text, voice, speed }) {
  if (!tts) throw new Error("Model is not loaded");
  const audio = await tts.generate(text, { voice, speed });
  let words = null;
  try {
    words = wordTimings(takeCapture(), tts.tokenizer);
  } catch (err) {
    console.warn("[vox worker] word timing unavailable", err);
  }
  return { pcm: audio.audio, sampleRate: audio.sampling_rate, words };
}

const handlers = {
  load: (msg) => load(msg.profile, msg.threads, msg.voice),
  generate,
};

// One model, one request at a time. Overlapping generate calls would interleave
// inside tts.generate() and the duration capture could then be paired with the
// wrong utterance, mistiming the word highlighting.
let queue = Promise.resolve();

self.onmessage = (event) => {
  const msg = event.data;
  const handler = handlers[msg.type];
  if (!handler) return;
  queue = queue.then(async () => {
    try {
      const result = await handler(msg);
      const transfer = result?.pcm instanceof Float32Array ? [result.pcm.buffer] : [];
      self.postMessage({ id: msg.id, ok: true, result }, transfer);
    } catch (err) {
      self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
    }
  });
};

// A module worker that dies on startup fires an ErrorEvent with an empty
// message, which tells the user nothing. Report the real reason instead.
self.addEventListener("error", (event) => {
  self.postMessage({
    type: "fatal",
    error: [event.message, event.filename && `${event.filename}:${event.lineno}:${event.colno}`]
      .filter(Boolean).join(" ") || "worker error",
  });
});

self.addEventListener("unhandledrejection", (event) => {
  self.postMessage({ type: "fatal", error: String(event.reason?.stack || event.reason) });
});

self.postMessage({ type: "ready" });
