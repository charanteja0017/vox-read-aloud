/* The popup's scrubber, driven with real pointer input against a real engine. */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DIST = path.resolve("dist");
const PORT = 9588;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = process.env.VOX_E2E_PROFILE || (await mkdtemp(path.join(os.tmpdir(), "vox-popup-")));
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

const popupErrors = [];
let failures = 0;
const step = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

const CHUNKS = Array.from({ length: 12 }, (_, i) => ({
  i, text: `Sentence number ${i + 1} exists so the scrubber has somewhere to go.`,
}));

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
  // A ReferenceError in the popup leaves a UI that looks fine and does nothing,
  // so an empty exception log is itself an assertion.
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      const text = (d.exception?.description || d.text || "").split("\n").slice(0, 2).join(" | ");
      popupErrors.push(text);
      console.log("    [popup exception]", text);
    }
    if (m.method === "Runtime.consoleAPICalled" && /error|warn/.test(m.params.type)) {
      console.log("    [popup]", m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
    }
  });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 720, height: 600, deviceScaleFactor: 1, mobile: false }, sessionId);
  await sleep(2000);

  const ev = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
    return r.result.value;
  };

  step("popup is 720px wide and fits Chrome's 600px limit",
    (await ev(`JSON.stringify([document.body.offsetWidth, document.body.scrollHeight])`)) !== null);
  const box = await ev(`JSON.stringify([document.body.offsetWidth, Math.ceil(document.body.scrollHeight)])`).then(JSON.parse);
  step("popup dimensions are within Chrome's limits", box[0] <= 800 && box[1] <= 600, `${box[0]}×${box[1]}`);

  // Pin the profile so the test uses the model this profile already has cached
  // rather than starting a fresh multi-hundred-megabyte download.
  await ev(`chrome.runtime.sendMessage({to:"bg",type:"ENGINE",payload:{type:"SET",patch:{profile:"balanced"}}})`);
  await sleep(500);
  await ev(`chrome.runtime.sendMessage({to:"bg",type:"ENGINE",payload:{type:"PRELOAD"}})`);
  await sleep(1500);

  await ev(`chrome.runtime.sendMessage({to:"bg",type:"ENGINE",payload:{type:"SPEAK",title:"Scrubber test",source:"page",tabId:null,chunks:${JSON.stringify(CHUNKS)}}})`);
  await sleep(2500);
  await ev(`chrome.runtime.sendMessage({to:"bg",type:"ENGINE",payload:{type:"TOGGLE"}})`);  // pause, keep it quiet
  await sleep(600);

  const total = await ev(`chrome.runtime.sendMessage({to:"bg",type:"ENGINE",payload:{type:"GET_STATE"}}).then(r=>r.state.total)`);
  step("engine has the document", total === CHUNKS.length, `${total} sentences`);

  const rect = await ev(`JSON.stringify((() => { const r = document.querySelector(".scrub-hit").getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2, w: r.width }; })())`).then(JSON.parse);

  const dragTo = async (fraction) => {
    const x = Math.round(rect.x + rect.w * fraction);
    const y = Math.round(rect.y);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(rect.x + 2), y, button: "left", buttons: 1, clickCount: 1 }, sessionId);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 }, sessionId);
    await sleep(120);
    const preview = await ev(`JSON.stringify({ tip: !document.getElementById("scrubTip").classList.contains("hidden"),
      tipText: document.getElementById("scrubTipText").textContent,
      knob: document.getElementById("scrubKnob").style.left })`).then(JSON.parse);
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, sessionId);
    await sleep(700);
    const index = await ev(`chrome.runtime.sendMessage({to:"bg",type:"ENGINE",payload:{type:"GET_STATE"}}).then(r=>r.state.index)`);
    return { preview, index };
  };

  const drag = await dragTo(0.75);
  const expected = Math.round(0.75 * (CHUNKS.length - 1));
  step("dragging the knob seeks to that sentence", Math.abs(drag.index - expected) <= 1,
    `landed on ${drag.index}, expected about ${expected}`);
  step("a preview appears while dragging", drag.preview.tip === true);
  step("the preview shows the sentence under the pointer",
    drag.preview.tipText.includes(String(expected + 1)) || drag.preview.tipText.length > 10,
    JSON.stringify(drag.preview.tipText.slice(0, 50)));
  step("the knob tracks the pointer during the drag",
    parseFloat(drag.preview.knob) > 60, `knob at ${drag.preview.knob}`);

  const back = await dragTo(0.1);
  step("dragging backwards works too", back.index <= 2, `landed on ${back.index}`);

  // Keyboard access, since a knob you can only drag is not accessible.
  await ev(`document.getElementById("scrub").focus()`);
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 }, sessionId);
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 }, sessionId);
  await sleep(700);
  const afterKey = await ev(`chrome.runtime.sendMessage({to:"bg",type:"ENGINE",payload:{type:"GET_STATE"}}).then(r=>r.state.index)`);
  step("arrow keys move the scrubber", afterKey === back.index + 1, `${back.index} then ${afterKey}`);

  const aria = await ev(`JSON.stringify({
    role: document.getElementById("scrub").getAttribute("role"),
    now: document.getElementById("scrub").getAttribute("aria-valuenow"),
    max: document.getElementById("scrub").getAttribute("aria-valuemax") })`).then(JSON.parse);
  step("the scrubber reports itself to assistive tech",
    aria.role === "slider" && aria.max === String(CHUNKS.length), JSON.stringify(aria));

  // The background render runs at its own pace; give it a moment to produce
  // something, then check the track actually reflects it.
  let prepared = null;
  for (let i = 0; i < 60; i++) {
    prepared = await ev(`JSON.stringify({
      mask: (window.__voxLastState && window.__voxLastState.renderedMask) || "",
      css: document.getElementById("scrubPrepared").style.background })`).then(JSON.parse);
    if (prepared.mask.includes("1")) break;
    if (i % 5 === 0) {
      const st = await ev(`chrome.runtime.sendMessage({to:"bg",type:"ENGINE",payload:{type:"GET_STATE"}}).then(r=>JSON.stringify({s:r.state.status,idx:r.state.index,rend:r.state.rendered,tot:r.state.total,err:r.state.error,rtf:r.state.rtf}))`);
      console.log("    engine:", st);
    }
    await sleep(1000);
  }
  step("engine reports which sentences are prepared", prepared.mask.includes("1"),
    `mask "${prepared.mask.slice(0, 20)}"`);
  step("prepared sentences are painted on the track", prepared.css.includes("gradient"),
    prepared.css.slice(0, 60));

  await ev(`chrome.runtime.sendMessage({to:"bg",type:"ENGINE",payload:{type:"STOP"}})`);

  step("the popup threw no uncaught exceptions", popupErrors.length === 0,
    popupErrors[0] || "clean");

  console.log(`\n  ${failures ? `${failures} failed` : "all checks passed"}\n`);
} catch (err) {
  console.error("  ERROR:", err.message);
  failures++;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill("SIGKILL");
  if (!process.env.VOX_E2E_PROFILE) await rm(profile, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
