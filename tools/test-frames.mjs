/* Reading text that lives in an iframe, end to end in a real browser. Mirrors
   how claude.ai shows artifacts: a thin top page, a cross-origin frame, and
   the actual content in a sandboxed srcdoc frame inside that. The top page has
   almost no text of its own, so a reader that only looks there reads the
   page chrome and nothing else. */
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, realpath, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

// Branded Chrome refuses --load-extension; point CHROME_BIN at Chrome for Testing.
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// A throwaway build that holds <all_urls> (standing in for the
// claudeusercontent.com grant) and exposes readTab to the test.
const DIST = await (async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "vox-frames-dist-"));
  await new Promise((resolve, reject) => {
    const build = spawn(process.execPath, ["build.mjs"], { env: { ...process.env, VOX_OUT: out }, stdio: "ignore" });
    build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build exited ${code}`))));
  });
  const manifestPath = path.join(out, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), "<all_urls>"])];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await appendFile(path.join(out, "background.js"), "\nglobalThis.__voxReadTab = readTab;\n");
  return realpath(out);
})();

const TOP_PORT = 8978;
const FRAME_PORT = 8979;
const CDP_PORT = 9545;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ARTICLE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<main><article><h1>The Kettle Problem</h1>
<p id="p1">Every morning the kettle refuses to boil. It sits there humming faintly, and the whole kitchen waits for it.</p>
<p id="p2">Alvarez studied kettles for years. She concluded they are simply stubborn, and wrote a long paper to prove it.</p>
<p id="p3">The fix, it turns out, was descaling. Nothing more exotic was ever required, though many exotic things were tried.</p>
<p id="p4">Afterwards the kitchen was quiet again. Nobody mentioned the kettle, and the kettle did not mention anybody.</p>
<p id="p5">Some say it still hums on cold mornings. Most people think that is just the fridge, which has opinions of its own.</p>
</article></main></body></html>`;

const escapeAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

const TOP = `<!doctype html><html><head><meta charset="utf-8"><title>Artifact</title></head><body style="margin:0">
<header>Content is user-generated and unverified.</header>
<iframe id="outer" src="http://localhost:${FRAME_PORT}/" style="width:100%;height:90vh;border:0"
  sandbox="allow-scripts allow-same-origin allow-forms"></iframe></body></html>`;

const OUTER = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<iframe id="inner" sandbox="allow-scripts" style="width:100%;height:85vh;border:0"
  srcdoc="${escapeAttr(ARTICLE)}"></iframe></body></html>`;

const serve = (html, port) => createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}).listen(port);
const servers = [serve(TOP, TOP_PORT), serve(OUTER, FRAME_PORT)];

const profile = await mkdtemp(path.join(os.tmpdir(), "vox-frames-"));
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

  await cdp("Target.createTarget", { url: `chrome-extension://${id}/ui/popup.html` });
  await sleep(1500);
  await cdp("Target.createTarget", { url: `http://127.0.0.1:${TOP_PORT}/` });
  await sleep(1500);

  let sw = null;
  for (let i = 0; i < 120 && !sw; i++) {
    const targets = (await cdp("Target.getTargets")).targetInfos;
    sw = targets.find((t) => t.type === "service_worker" && t.url.includes(id));
    if (!sw) await sleep(400);
  }
  step("service worker is running", !!sw);
  if (!sw) throw new Error("extension service worker never started");
  const swSession = (await cdp("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).sessionId;
  await cdp("Runtime.enable", {}, swSession);
  const evalSW = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, swSession);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
    return r.result.value;
  };

  const TAB = `(await chrome.tabs.query({ url: "http://127.0.0.1:${TOP_PORT}/*" }))[0]`;

  // Reads with the real readTab, then reports what the engine was handed.
  const read = (options = "{}") => evalSW(`(async () => {
    await chrome.storage.session.remove("session");
    const tab = ${TAB};
    const res = await globalThis.__voxReadTab(tab, ${options});
    let session = null;
    for (let i = 0; i < 30 && !session?.chunks; i++) {
      await new Promise((r) => setTimeout(r, 200));
      session = (await chrome.storage.session.get("session")).session;
    }
    return JSON.stringify({ res, frameId: session?.frameId, text: (session?.chunks || []).map((c) => c.text).join(" ") });
  })()`).then(JSON.parse);

  const frames = await evalSW(`(async () => {
    const tab = ${TAB};
    const r = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => location.href });
    return JSON.stringify(r.map((f) => ({ frameId: f.frameId, url: f.result })));
  })()`).then(JSON.parse);
  const srcdoc = frames.find((f) => f.url === "about:srcdoc");
  step("the sandboxed srcdoc frame accepts injection", !!srcdoc, JSON.stringify(frames));

  const page = await read();
  step("whole-page read picks the srcdoc frame", page.frameId === srcdoc?.frameId, `frame ${page.frameId}`);
  step("whole-page read gets the article, not the page chrome",
    page.text.includes("The fix, it turns out") && !page.text.includes("user-generated"), page.text.slice(0, 80));

  // Select one paragraph inside the srcdoc frame, as a reader would.
  await evalSW(`(async () => {
    const tab = ${TAB};
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => {
      const p = document.getElementById("p3");
      if (!p) return;
      const range = document.createRange();
      range.selectNodeContents(p);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    } });
  })()`);
  const sel = await read();
  step("selection read picks the frame holding the selection", sel.frameId === srcdoc?.frameId, `frame ${sel.frameId}`);
  step("selection read gets only the selected paragraph",
    sel.text.startsWith("The fix, it turns out") && !sel.text.includes("Alvarez"), sel.text.slice(0, 80));

  // A right-click menu reports its frame; that must win over guessing.
  const menu = await read(`{ frameId: ${srcdoc?.frameId} }`);
  step("an explicit frameId from the context menu is honoured", menu.frameId === srcdoc?.frameId);

  // Highlights must land in the frame being read.
  await sleep(500);
  const marked = await evalSW(`(async () => {
    const tab = ${TAB};
    const r = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true },
      func: () => ({ url: location.href, marked: !!document.querySelector("[data-vox-ui], style#__vox_style__") || (CSS.highlights?.size || 0) > 0 }) });
    return JSON.stringify(r.map((f) => f.result));
  })()`).then(JSON.parse);
  const markedFrames = marked.filter((f) => f.marked).map((f) => f.url);
  step("highlighting happens in the srcdoc frame only",
    markedFrames.length === 1 && markedFrames[0] === "about:srcdoc", JSON.stringify(markedFrames));

  console.log(`\n  ${failures ? `${failures} failed` : "all checks passed"}\n`);
} catch (err) {
  console.error("  ERROR:", err.message);
  failures++;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill("SIGKILL");
  for (const s of servers) s.close();
  await rm(profile, { recursive: true, force: true });
  await rm(DIST, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
