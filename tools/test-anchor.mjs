/* "Start reading from here", end to end in a real browser: the registered
   listener must record a real right-click, and the reader must resolve it to
   the paragraph under the pointer. */
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Build a throwaway copy that already holds <all_urls>, so the test exercises
// the real registered listener without stopping at a permission dialog.
// realpath matters: macOS temp dirs live under /var, which is a symlink to
// /private/var, and Chrome derives an unpacked extension's id from the resolved
// path — so the un-resolved string yields the wrong id.
const DIST = process.env.ANCHOR_DIST
  ? await realpath(path.resolve(process.env.ANCHOR_DIST))
  : await (async () => {
      const out = await mkdtemp(path.join(os.tmpdir(), "vox-anchor-dist-"));
      await new Promise((resolve, reject) => {
        const build = spawn(process.execPath, ["build.mjs"], {
          env: { ...process.env, VOX_OUT: out },
          stdio: "ignore",
        });
        build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build exited ${code}`))));
      });
      const manifestPath = path.join(out, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), "<all_urls>"])];
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      return realpath(out);
    })();
const PORT = 8977;
const CDP_PORT = 9544;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ARTICLE = `<!doctype html><html><head><meta charset="utf-8"><title>The Kettle Problem</title>
<style>body{font:17px/1.7 Georgia,serif;max-width:34em;margin:40px auto;padding:0 20px}</style></head><body>
<nav>Home · Archive</nav><header><h1>The Kettle Problem</h1></header>
<main><article>
<p id="p1">Every morning the kettle refuses to boil. It sits there humming faintly.</p>
<p id="p2">Alvarez studied kettles for years. She concluded they are simply stubborn.</p>
<p id="p3">The fix, it turns out, was descaling. Nothing more exotic was ever required.</p>
<p id="p4">Afterwards the kitchen was quiet again. Nobody mentioned the kettle.</p>
</article></main><footer>Copyright 2026</footer></body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(ARTICLE);
}).listen(PORT);

const profile = await mkdtemp(path.join(os.tmpdir(), "vox-anchor-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
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
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl; }
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

  // Wake the service worker so its target exists.
  const popup = await cdp("Target.createTarget", { url: `chrome-extension://${id}/ui/popup.html` });
  await sleep(1500);

  // Open the article AFTER the extension registered its listener.
  const page = await cdp("Target.createTarget", { url: `http://127.0.0.1:${PORT}/` });
  const pageSession = (await cdp("Target.attachToTarget", { targetId: page.targetId, flatten: true })).sessionId;
  await cdp("Runtime.enable", {}, pageSession);
  await sleep(1200);

  const evalPage = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, pageSession);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
    return r.result.value;
  };

  const rect = await evalPage(`JSON.stringify((() => { const r = document.getElementById("p3").getBoundingClientRect(); return { x: Math.round(r.left + 12), y: Math.round(r.top + 10) }; })())`).then(JSON.parse);

  // A genuine right-click, not a synthetic event.
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp("Input.dispatchMouseEvent", {
      type, x: rect.x, y: rect.y, button: "right", buttons: 2, clickCount: 1,
    }, pageSession);
  }
  await sleep(400);

  // The service worker is what actually reads the anchor.
  // The worker can take a moment to spin up, especially right after a build.
  let sw = null;
  for (let i = 0; i < 120 && !sw; i++) {
    const targets = (await cdp("Target.getTargets")).targetInfos;
    sw = targets.find((t) => t.type === "service_worker" && t.url.includes(id));
    if (!sw) {
      // Under load the worker can take a while; nudge it awake periodically.
      if (i % 25 === 24) await cdp("Target.createTarget", { url: `chrome-extension://${id}/ui/popup.html` });
      await sleep(400);
    }
  }
  step("service worker is running", !!sw, sw ? "" : `no worker for ${id}`);
  if (!sw) throw new Error("extension service worker never started");
  const swSession = (await cdp("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).sessionId;
  await cdp("Runtime.enable", {}, swSession);

  const evalSW = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, swSession);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
    return r.result.value;
  };

  const registered = await evalSW(`chrome.scripting.getRegisteredContentScripts({ids:["vox-anchor"]}).then(r=>r.length,()=>-1)`);
  step("anchor listener is registered", registered === 1, `${registered} script(s)`);

  const result = await evalSW(`(async () => {
    const [tab] = await chrome.tabs.query({ url: "http://127.0.0.1:${PORT}/*" });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const res = await chrome.tabs.sendMessage(tab.id, { to: "content", type: "EXTRACT", anchor: true });
    if (!res || !res.ok) return JSON.stringify({ raw: res });
    const d = res.data;
    return JSON.stringify({
      found: d.anchorFound,
      startIndex: d.startIndex,
      startsAt: d.chunks[d.startIndex]?.text,
      total: d.chunks.length,
    });
  })()`).then(JSON.parse);

  if (result.raw !== undefined) console.log("    raw response:", JSON.stringify(result.raw));
  step("right-click position was recorded", result.found === true);
  step("reading starts at the clicked paragraph",
    (result.startsAt || "").startsWith("The fix, it turns out"), result.startsAt);
  step("the rest of the article is still queued",
    result.startIndex > 0 && result.total > result.startIndex + 1,
    `index ${result.startIndex} of ${result.total}`);

  // Clicking a different paragraph must land somewhere different.
  const rect2 = await evalPage(`JSON.stringify((() => { const r = document.getElementById("p1").getBoundingClientRect(); return { x: Math.round(r.left + 12), y: Math.round(r.top + 10) }; })())`).then(JSON.parse);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp("Input.dispatchMouseEvent", { type, x: rect2.x, y: rect2.y, button: "right", buttons: 2, clickCount: 1 }, pageSession);
  }
  await sleep(300);
  const second = await evalSW(`(async () => {
    const [tab] = await chrome.tabs.query({ url: "http://127.0.0.1:${PORT}/*" });
    const res = await chrome.tabs.sendMessage(tab.id, { to: "content", type: "EXTRACT", anchor: true });
    return JSON.stringify({ i: res.data.startIndex, t: res.data.chunks[res.data.startIndex]?.text });
  })()`).then(JSON.parse);
  step("a different right-click starts somewhere else",
    (second.t || "").startsWith("Every morning"), `index ${second.i}: ${second.t}`);

  console.log(`\n  ${failures ? `${failures} failed` : "all checks passed"}\n`);
} catch (err) {
  console.error("  ERROR:", err.message);
  failures++;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill("SIGKILL");
  server.close();
  await rm(profile, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
