/* Scrolling behaviour, measured in a real browser on a tall page:
   does the follow glide rather than jump, settle in the right place under a
   sticky header, and get out of the way when the reader scrolls? */
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9566;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTENT = await readFile(new URL("../src/content.js", import.meta.url), "utf8");

const paragraphs = Array.from({ length: 60 }, (_, i) =>
  `<p id="p${i}">Paragraph number ${i} explains something at moderate length. ` +
  `It continues for a second sentence so the reader has somewhere to go.</p>`).join("\n");

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Long Read</title>
<style>
  body{font:16px/1.7 Georgia,serif;margin:0}
  header{position:sticky;top:0;height:60px;background:#eee;display:flex;align-items:center;padding:0 16px}
  main{max-width:34em;margin:0 auto;padding:0 20px}
</style></head><body>
<header>Sticky masthead</header>
<main><article><h1>Long Read</h1>${paragraphs}</article></main>
</body></html>`;

const profile = await mkdtemp(path.join(os.tmpdir(), "vox-scroll-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "about:blank",
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

  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Page.enable", {}, sessionId);
  await cdp("Runtime.enable", {}, sessionId);
  await cdp("Emulation.setDeviceMetricsOverride", { width: 900, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(FIXTURE)}` }, sessionId);
  await sleep(900);

  const ev = async (expr) => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
    return r.result.value;
  };

  await ev(`
    window.chrome = { runtime: { onMessage: { addListener() {} } } };
    window.__A__ = null;
    globalThis.__VOX_TEST_HOOK__ = (api) => { window.__A__ = api; };
    (0, eval)(${JSON.stringify(CONTENT)});
    window.__A__.extract();
    !!window.__A__
  `);

  step("sticky header is measured as an inset", (await ev(`window.__A__.topInset()`)) >= 55,
    `${await ev(`window.__A__.topInset()`)}px`);

  // Aim at a sentence roughly a screen and a half down: far enough to need
  // real scrolling, close enough that it should glide rather than snap.
  const targetIndex = await ev(`(() => {
    const chunks = window.__A__.index().chunks;
    for (let i = 0; i < chunks.length; i++) {
      const r = window.__A__.rangeFor(chunks[i].start, chunks[i].end);
      if (r && r.getBoundingClientRect().top > window.innerHeight * 1.4) return i;
    }
    return chunks.length - 1;
  })()`);

  const samples = await ev(`(async () => {
    window.scrollTo(0, 0);
    const out = [];
    window.__A__.highlight(${targetIndex});
    for (let i = 0; i < 40; i++) {
      out.push(Math.round(window.scrollY));
      await new Promise(r => setTimeout(r, 40));
    }
    return JSON.stringify(out);
  })()`).then(JSON.parse);

  const distinct = new Set(samples).size;
  const monotonic = samples.every((v, i) => i === 0 || v >= samples[i - 1]);
  step("the page glides instead of jumping", distinct >= 6 && monotonic,
    `${distinct} distinct positions, ${monotonic ? "monotonic" : "NOT monotonic"}`);
  step("scrolling comes to rest", samples.at(-1) === samples.at(-3),
    `settled at ${samples.at(-1)}px`);

  const resting = await ev(`(() => {
    const c = window.__A__.index().chunks[${targetIndex}];
    const r = window.__A__.rangeFor(c.start, c.end);
    const rect = r.getBoundingClientRect();
    const inset = window.__A__.topInset();
    return JSON.stringify({ top: Math.round(rect.top), inset: Math.round(inset), h: window.innerHeight });
  })()`).then(JSON.parse);
  const restFraction = (resting.top - resting.inset) / (resting.h - resting.inset);
  step("the spoken line rests below the sticky header, around a third down",
    resting.top > resting.inset && restFraction > 0.2 && restFraction < 0.55,
    `top ${resting.top}px, ${(restFraction * 100).toFixed(0)}% into the usable viewport`);

  // Scrolling away by hand must hand control back to the reader.
  const afterUser = await ev(`(async () => {
    window.scrollTo(0, 0);
    window.__A__.highlight(${targetIndex});
    await new Promise(r => setTimeout(r, 120));
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, bubbles: true }));
    const at = Math.round(window.scrollY);
    await new Promise(r => setTimeout(r, 900));
    return JSON.stringify({ at, later: Math.round(window.scrollY) });
  })()`).then(JSON.parse);
  step("a manual scroll stops the follow", Math.abs(afterUser.later - afterUser.at) <= 2,
    `${afterUser.at}px then ${afterUser.later}px`);

  const resumes = await ev(`(async () => {
    window.__A__.highlight(${targetIndex + 1});
    await new Promise(r => setTimeout(r, 900));
    return Math.round(window.scrollY);
  })()`);
  step("moving to the next sentence resumes following", resumes > afterUser.later + 20,
    `${afterUser.later}px then ${resumes}px`);

  // A distant seek should not crawl for ten seconds.
  const seek = await ev(`(async () => {
    window.scrollTo(0, 0);
    const chunks = window.__A__.index().chunks;
    const far = chunks.length - 2;
    const t0 = performance.now();
    window.__A__.highlight(far);
    await new Promise(r => setTimeout(r, 700));
    return JSON.stringify({ ms: Math.round(performance.now() - t0), y: Math.round(window.scrollY) });
  })()`).then(JSON.parse);
  step("a long seek arrives quickly instead of crawling", seek.y > 2000, `${seek.y}px within ${seek.ms}ms`);

  // And the loop must not spin once nothing is happening.
  const idle = await ev(`(async () => {
    window.__A__.speakChunk({ index: ${targetIndex}, words: [[0, 0.05]], duration: 0.05, paused: true });
    await new Promise(r => setTimeout(r, 400));
    return window.__A__.follow.raf;
  })()`);
  step("no animation frames are queued while paused", idle === 0, `raf handle ${idle}`);

  console.log(`\n  ${failures ? `${failures} failed` : "all checks passed"}\n`);
} catch (err) {
  console.error("  ERROR:", err.message);
  failures++;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill("SIGKILL");
  await rm(profile, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
