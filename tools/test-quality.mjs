/* Audio quality of the shipped profiles, measured against the CPU reference.

   This exists because a GPU backend was once shipped purely on a speed
   benchmark: it was five times faster and produced noise. Speed says nothing
   about whether the waveform is right, so this compares the actual samples.

   Downloads several hundred megabytes of model weights, so it is not part of
   `npm test`. Run it whenever a profile's dtype or device changes. */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DIST = path.resolve("dist");
const PORT = 9622;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SENTENCE = "The kettle refused to boil, humming faintly to itself, so I gave up and read the paper instead.";

const profile = process.env.VOX_QUALITY_PROFILE || (await mkdtemp(path.join(os.tmpdir(), "vox-quality-")));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--load-extension=${DIST}`, "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: ["ignore", "ignore", "ignore"] });

let ws, nextId = 1;
const pending = new Map();
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

let failures = 0;
const step = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

try {
  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(250); }
  }
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const slot = pending.get(m.id);
    if (!slot) return;
    pending.delete(m.id);
    m.error ? slot.reject(new Error(m.error.message)) : slot.resolve(m.result);
  };

  const id = [...createHash("sha256").update(DIST, "utf8").digest("hex").slice(0, 32)]
    .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
  const { targetId } = await cdp("Target.createTarget", { url: `chrome-extension://${id}/ui/popup.html` });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Runtime.enable", {}, sessionId);
  await sleep(900);

  const ev = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 900000 }, sessionId);
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || "").slice(0, 300));
    return r.result.value;
  };

  await ev(`(async () => {
    const base = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/";
    const cache = await caches.open("kokoro-voices");
    const url = base + "af_heart.bin";
    if (!(await cache.match(url))) {
      const r = await fetch(chrome.runtime.getURL("voices/af_heart.bin"));
      await cache.put(url, new Response(await r.arrayBuffer()));
    }
  })()`);

  const measure = (name) => ev(`(async () => {
    const w = new Worker(chrome.runtime.getURL("tts-worker.js"), { type: "module" });
    let seq = 0;
    const call = (msg) => new Promise((res, rej) => {
      const id = ++seq;
      const on = (e) => {
        if (e.data.type === "fatal") return rej(new Error(e.data.error));
        if (e.data.id !== id) return;
        w.removeEventListener("message", on);
        e.data.ok ? res(e.data.result) : rej(new Error(e.data.error));
      };
      w.addEventListener("message", on);
      w.postMessage({ id, ...msg });
    });
    const info = await call({ type: "load", profile: "${name}", voice: "af_heart" });
    const r = await call({ type: "generate", text: ${JSON.stringify(SENTENCE)}, voice: "af_heart", speed: 1 });
    w.terminate();
    const pcm = r.pcm;
    let peak = 0, sum = 0, zc = 0, bad = 0;
    for (let i = 0; i < pcm.length; i++) {
      const x = pcm[i];
      if (!Number.isFinite(x)) { bad++; continue; }
      const a = Math.abs(x);
      if (a > peak) peak = a;
      sum += x * x;
      if (i && ((pcm[i - 1] < 0) !== (x < 0))) zc++;
    }
    return JSON.stringify({
      device: info.device, dtype: info.dtype, seconds: pcm.length / r.sampleRate,
      peak, rms: Math.sqrt(sum / pcm.length), zcr: zc / (pcm.length / r.sampleRate), bad,
    });
  })()`).then(JSON.parse);

  const reference = await measure("balanced");
  console.log(`  reference: ${reference.device}/${reference.dtype}  ${reference.seconds.toFixed(2)}s  ` +
    `rms ${reference.rms.toFixed(4)}  zcr ${Math.round(reference.zcr)}/s\n`);
  step("the reference profile produces finite audio", reference.bad === 0 && reference.rms > 0.02);

  const gpu = await measure("best");
  const zcrRatio = gpu.zcr / reference.zcr;
  const rmsRatio = gpu.rms / reference.rms;
  const durRatio = gpu.seconds / reference.seconds;
  console.log(`  candidate: ${gpu.device}/${gpu.dtype}  ${gpu.seconds.toFixed(2)}s  ` +
    `rms ${gpu.rms.toFixed(4)}  zcr ${Math.round(gpu.zcr)}/s\n`);

  step("no non-finite samples", gpu.bad === 0, `${gpu.bad} bad samples`);
  step("length matches the reference", Math.abs(durRatio - 1) < 0.06, `x${durRatio.toFixed(2)}`);
  step("loudness matches the reference", rmsRatio > 0.8 && rmsRatio < 1.25, `x${rmsRatio.toFixed(2)}`);
  // The one that matters: high-frequency energy carries the consonants, and an
  // f16 GPU path drops roughly two thirds of it while sounding "fast and fine"
  // on every speed benchmark.
  step("high-frequency detail survives (consonants intact)",
    zcrRatio > 0.85 && zcrRatio < 1.2, `zcr x${zcrRatio.toFixed(2)} — below 0.85 it sounds like noise`);
  step("it is not silence", gpu.peak > 0.05, `peak ${gpu.peak.toFixed(3)}`);

  console.log(`\n  ${failures ? `${failures} failed` : "all checks passed"}\n`);
} catch (err) {
  console.error("  ERROR:", err.message);
  failures++;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill("SIGKILL");
  if (!process.env.VOX_QUALITY_PROFILE) await rm(profile, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
