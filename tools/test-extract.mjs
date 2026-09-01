/* Runs content.js against real pages in a real browser: does it find the
   article, skip the furniture, and map character offsets back onto DOM ranges? */
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9488;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTENT = await readFile(new URL("../src/content.js", import.meta.url), "utf8");

const FIXTURE = `<!doctype html><html><head><title>The Kettle Problem</title></head><body>
  <nav><a href="/">Home</a> <a href="/x">Archive</a> <a href="/y">About us</a></nav>
  <header><h1>The Kettle Problem</h1><p class="byline">By A Writer</p></header>
  <main>
    <article>
      <p>Every morning the kettle refuses to boil. It sits there, humming faintly, doing nothing at all.</p>
      <p>Dr. Alvarez studied kettles for years. She concluded that they are simply stubborn.</p>
      <pre><code>const kettle = new Kettle(); kettle.boil();</code></pre>
      <p>The fix, it turns out, was descaling. Nothing more exotic than that was ever required.</p>
      <p>Double  spaced   text&nbsp;with   odd&#9;whitespace still highlights correctly here.</p>
      <ul><li>Fill with vinegar.</li><li>Wait twenty minutes.</li><li>Rinse thoroughly.</li></ul>
    </article>
    <aside class="related"><h3>Related</h3><p>Seventeen other appliances that hate you.</p></aside>
  </main>
  <footer><p>Copyright 2026 Kettle Weekly. All rights reserved worldwide.</p></footer>
  <div style="display:none"><p>Hidden promotional text that should never be read aloud.</p></div>
  <div aria-hidden="true"><p>Decorative text for screen reader avoidance.</p></div>
  <script>window.junk = "script contents must not be spoken";</script>
</body></html>`;

const profile = await mkdtemp(path.join(os.tmpdir(), "vox-extract-"));
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
function step(name, ok, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

try {
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(250); }
  }
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result);
  };

  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Page.enable", {}, sessionId);
  await cdp("Runtime.enable", {}, sessionId);
  await cdp("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(FIXTURE)}` }, sessionId);
  await sleep(900);

  const evaluate = async (expression) => {
    const res = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || "eval failed");
    return res.result.value;
  };

  // Load content.js with a chrome stub, capturing its internals via the hook.
  await evaluate(`
    window.chrome = { runtime: { onMessage: { addListener() {} } } };
    window.__VOX_API__ = null;
    globalThis.__VOX_TEST_HOOK__ = (api) => { window.__VOX_API__ = api; };
    ${JSON.stringify(CONTENT)};
  `);
  await evaluate(`(0, eval)(${JSON.stringify(CONTENT)}); !!window.__VOX_API__`);

  const data = await evaluate(`JSON.stringify(window.__VOX_API__.extract())`).then(JSON.parse);
  const spoken = data.chunks.map((c) => c.text).join(" ");

  step("reads the page title", data.title === "The Kettle Problem", data.title);
  step("starts at the headline", data.chunks[0]?.text === "The Kettle Problem", data.chunks[0]?.text);
  step("the headline is marked as a heading", data.chunks[0]?.heading === true);
  step("body sentences are not headings", data.chunks[1]?.heading === false);
  step("plain prose has no speakers", (data.speakers || []).length === 0);
  step("reports page source", data.source === "page", data.source);
  step("finds the article body", spoken.includes("Every morning the kettle refuses to boil"));
  step("keeps list items", spoken.includes("Wait twenty minutes"));
  step("skips navigation", !spoken.includes("Archive"), spoken.includes("Archive") ? "nav leaked" : "");
  step("skips the footer", !spoken.includes("Copyright"), spoken.includes("Copyright") ? "footer leaked" : "");
  step("skips asides", !spoken.includes("Seventeen other appliances"));
  step("skips code blocks", !spoken.includes("new Kettle"));
  step("skips display:none content", !spoken.includes("Hidden promotional"));
  step("skips aria-hidden content", !spoken.includes("Decorative text"));
  step("skips script contents", !spoken.includes("script contents must not be spoken"));
  step("keeps honorifics intact", spoken.includes("Dr. Alvarez studied kettles"));

  // The offset→Range mapping is what drives on-page highlighting.
  const mapped = await evaluate(`
    (() => {
      const api = window.__VOX_API__;
      const chunks = api.index().chunks;
      const out = [];
      for (const c of chunks) {
        const r = api.rangeFor(c.start, c.end);
        out.push({ want: c.text, got: r ? r.toString().replace(/\\s+/g, " ").trim() : null });
      }
      return JSON.stringify(out);
    })()
  `).then(JSON.parse);

  const mismatched = mapped.filter((m) => m.got !== m.want);
  step("every chunk maps back to its DOM range", mismatched.length === 0,
    mismatched.length ? `${mismatched.length}/${mapped.length} off, e.g. ${JSON.stringify(mismatched[0])}` : `${mapped.length} chunks`);

  const highlighted = await evaluate(`
    (() => {
      window.__VOX_API__.highlight(1);
      const hl = CSS.highlights.get("vox-current");
      if (!hl) return "no highlight";
      const ranges = [...hl];
      return ranges.length ? ranges[0].toString().replace(/\\s+/g, " ").trim() : "empty";
    })()
  `);
  step("highlight targets the right sentence", highlighted === mapped[1]?.want, highlighted);

  // ---- moving word highlight -------------------------------------------

  const wordCheck = await evaluate(`
    (() => {
      const api = window.__VOX_API__;
      const chunk = api.index().chunks[1];
      const text = api.index().text;
      const ranges = api.wordRanges(chunk);
      return JSON.stringify({
        joined: ranges.map(([a,b]) => text.slice(a,b)).join(" "),
        expected: chunk.text,
        count: ranges.length,
        expectedCount: chunk.text.split(/\\s+/).filter(Boolean).length,
      });
    })()
  `).then(JSON.parse);
  step("word ranges reconstruct the sentence", wordCheck.joined === wordCheck.expected,
    wordCheck.joined.slice(0, 60));
  step("word count matches the engine's view", wordCheck.count === wordCheck.expectedCount,
    `${wordCheck.count} words`);

  const align = await evaluate(`
    (() => {
      const api = window.__VOX_API__;
      const ranges = [[0,3],[4,9],[10,12]];
      const exact = api.alignTimes(ranges, [[0,1],[1,2],[2,3]], 3);
      const drift = api.alignTimes(ranges, [[0,1],[1,2]], 3);   // count mismatch
      return JSON.stringify({
        exactPassthrough: JSON.stringify(exact) === JSON.stringify([[0,1],[1,2],[2,3]]),
        driftLen: drift.length,
        driftCoversClip: Math.abs(drift[drift.length-1][1] - 3) < 1e-6,
        driftMonotonic: drift.every((w,i) => i === 0 || w[0] >= drift[i-1][1] - 1e-9),
      });
    })()
  `).then(JSON.parse);
  step("exact timings pass through untouched", align.exactPassthrough);
  step("mismatched counts fall back to a full-clip spread",
    align.driftLen === 3 && align.driftCoversClip && align.driftMonotonic);

  const moving = await evaluate(`
    (async () => {
      const api = window.__VOX_API__;
      const chunk = api.index().chunks[1];
      const text = api.index().text;
      const ranges = api.wordRanges(chunk);
      const per = 0.1;
      const times = ranges.map((_, i) => [i * per, (i + 1) * per]);
      const read = () => {
        const api = window.__VOX_API__;
        return api.__word ? api.__word() : null;
      };
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      api.speakChunk({ index: 1, words: times, duration: ranges.length * per, paused: false });
      await wait(50);
      const first = read();
      // Poll rather than sleeping a fixed amount: under load these frames are
      // scheduled late and a single sleep makes the test flaky, not the code.
      const want = text.slice(ranges[ranges.length - 1][0], ranges[ranges.length - 1][1]);
      let last = null;
      for (let i = 0; i < 60; i++) {
        last = read();
        if (last === want) break;
        await wait(100);
      }
      return JSON.stringify({
        first, last,
        wantFirst: text.slice(ranges[0][0], ranges[0][1]),
        wantLast: text.slice(ranges[ranges.length-1][0], ranges[ranges.length-1][1]),
      });
    })()
  `).then(JSON.parse);
  step("highlight starts on the first word", moving.first === moving.wantFirst,
    `got ${JSON.stringify(moving.first)} want ${JSON.stringify(moving.wantFirst)}`);
  step("highlight advances to the last word", moving.last === moving.wantLast,
    `got ${JSON.stringify(moving.last)} want ${JSON.stringify(moving.wantLast)}`);

  // The marker is positioned by hand, so assert it actually sits on the word
  // rather than merely existing somewhere on the page.
  const markerFit = await evaluate(`
    (async () => {
      const api = window.__VOX_API__;
      const chunk = api.index().chunks[1];
      const ranges = api.wordRanges(chunk);
      const per = 0.12;
      api.speakChunk({ index: 1, words: ranges.map((_, i) => [i * per, (i + 1) * per]),
        duration: ranges.length * per, paused: false });
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      await wait(80);
      let best = null;
      for (let i = 0; i < 40; i++) {
        const el = document.getElementById("__vox_marker__");
        const word = api.__word();
        if (el && word) {
          const m = el.getBoundingClientRect();
          const idx = api.index().chunks[1] && ranges.findIndex(([a, b]) => api.index().text.slice(a, b) === word);
          if (idx >= 0) {
            const r = api.rangeFor(ranges[idx][0], ranges[idx][1]).getBoundingClientRect();
            const mx = m.left + m.width / 2, my = m.top + m.height / 2;
            best = {
              word,
              inside: mx >= r.left - 4 && mx <= r.right + 4 && my >= r.top - 6 && my <= r.bottom + 6,
              dx: Math.round(mx - (r.left + r.width / 2)),
              dy: Math.round(my - (r.top + r.height / 2)),
              w: Math.round(m.width), rw: Math.round(r.width),
            };
            // The marker glides, so wait for it to actually arrive rather than
            // accepting it anywhere in the neighbourhood.
            if (best.inside && Math.abs(best.dx) <= 6) break;
          }
        }
        await wait(60);
      }
      return JSON.stringify(best);
    })()
  `).then(JSON.parse);
  step("the marker settles on the word it is reading",
    markerFit && markerFit.inside && Math.abs(markerFit.dx) <= 6,
    markerFit ? `"${markerFit.word}" off by ${markerFit.dx}px, ${markerFit.dy}px` : "no marker");
  step("the marker is sized to the word", markerFit && Math.abs(markerFit.w - markerFit.rw) < 12,
    markerFit ? `${markerFit.w}px vs word ${markerFit.rw}px` : "");

  const palettes = await evaluate(`
    (() => {
      const api = window.__VOX_API__;
      const original = document.body.style.background;
      document.body.style.background = "#141414";
      api.ensureStyle();
      const dark = document.getElementById("__vox_style__").textContent;
      const darkIsDark = api.pageIsDark();
      document.body.style.background = "#ffffff";
      api.ensureStyle();
      const light = document.getElementById("__vox_style__").textContent;
      const lightIsDark = api.pageIsDark();
      document.body.style.background = original;
      api.ensureStyle();
      return JSON.stringify({ darkIsDark, lightIsDark, differs: dark !== light });
    })()
  `).then(JSON.parse);
  step("a dark page is detected as dark", palettes.darkIsDark === true);
  step("a light page is detected as light", palettes.lightIsDark === false);
  step("the palette actually changes with the page", palettes.differs === true);

  const paused = await evaluate(`
    (async () => {
      const api = window.__VOX_API__;
      const chunk = api.index().chunks[1];
      const ranges = api.wordRanges(chunk);
      const per = 0.1;
      const times = ranges.map((_, i) => [i * per, (i + 1) * per]);
      const read = () => (window.__VOX_API__.__word ? window.__VOX_API__.__word() : null);
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      api.speakChunk({ index: 1, words: times, duration: ranges.length * per, paused: false });
      let atPause = null;
      for (let i = 0; i < 40; i++) {
        atPause = read();
        if (atPause) break;
        await wait(50);
      }
      api.pauseAnimation();
      atPause = read();
      await wait(400);
      const afterWait = read();
      api.resumeAnimation();
      let afterResume = afterWait;
      for (let i = 0; i < 40; i++) {
        afterResume = read();
        if (afterResume !== afterWait) break;
        await wait(50);
      }
      return JSON.stringify({ heldStill: atPause === afterWait, movedAfterResume: afterResume !== afterWait });
    })()
  `).then(JSON.parse);
  step("pause freezes the moving highlight", paused.heldStill);
  step("resume restarts it where it stopped", paused.movedAfterResume);

  // ---- "start reading from here" ---------------------------------------

  const anchored = await evaluate(`
    (() => {
      const api = window.__VOX_API__;
      api.extract();
      const chunks = api.index().chunks;
      // Aim at the third paragraph the way a right-click would.
      const p = document.querySelectorAll("article p")[2];
      const r = p.getBoundingClientRect();
      window.__VOX_ANCHOR__ = { x: r.left + 5, y: r.top + 5, at: Date.now() };
      const data = api.extract({ anchor: true });
      return JSON.stringify({
        startIndex: data.startIndex,
        source: data.source,
        startsAt: data.chunks[data.startIndex]?.text,
        total: data.chunks.length,
        allChunks: data.chunks.length === chunks.length,
      });
    })()
  `).then(JSON.parse);
  step("anchored read starts at the right sentence",
    (anchored.startsAt || "").startsWith("The fix, it turns out"), anchored.startsAt);
  step("anchored read still covers the whole article",
    anchored.allChunks && anchored.startIndex > 0, `index ${anchored.startIndex} of ${anchored.total}`);

  const stale = await evaluate(`
    (() => {
      const api = window.__VOX_API__;
      window.__VOX_ANCHOR__ = { x: 10, y: 10, at: Date.now() - 60000 };
      return api.extract({ anchor: true }).startIndex;
    })()
  `);
  step("a stale right-click falls back to the top", stale === 0, `index ${stale}`);

  const offPage = await evaluate(`
    (() => {
      const api = window.__VOX_API__;
      api.extract();
      const nav = document.querySelector("nav").getBoundingClientRect();
      window.__VOX_ANCHOR__ = { x: nav.left + 2, y: nav.top + 2, at: Date.now() };
      const d = api.extract({ anchor: true });
      return JSON.stringify({ i: d.startIndex, text: d.chunks[d.startIndex]?.text });
    })()
  `).then(JSON.parse);
  step("clicking skipped furniture starts at the next spoken text",
    offPage.i === 0, `index ${offPage.i}: ${JSON.stringify(offPage.text)}`);

  // Selections should win over whole-page extraction.
  const selected = await evaluate(`
    (() => {
      const p = document.querySelectorAll("article p")[2];
      const r = document.createRange();
      r.selectNodeContents(p);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      const d = window.__VOX_API__.extract();
      return JSON.stringify({ source: d.source, text: d.chunks.map(c => c.text).join(" ") });
    })()
  `).then(JSON.parse);
  step("a selection is read instead of the page", selected.source === "selection", selected.source);
  step("selection contains only the selected text",
    selected.text.includes("The fix, it turns out, was descaling") && !selected.text.includes("Every morning"),
    selected.text.slice(0, 70));

  // ---- a real dialogue page ---------------------------------------------

  const DIALOGUE = `<!doctype html><html><head><meta charset="utf-8"><title>Clarifying Requirements</title></head><body>
    <main><article>
    <h1>Clarifying Requirements</h1>
    <p>Here's a typical interaction between a candidate and an interviewer.</p>
    <p><strong>Candidate</strong>: Should we rank the results from most similar to least similar?</p>
    <p><strong>Interviewer</strong>: Images that appear first in the list should be more similar to the query image.</p>
    <p><strong>Candidate</strong>: Should the system support videos, too?</p>
    <p><strong>Interviewer</strong>: Let's focus only on images.</p>
    <p><strong>Candidate</strong>: Are the displayed images personalized to the user?</p>
    <p><strong>Interviewer</strong>: For simplicity, let's not focus on personalization.</p>
    </article></main></body></html>`;

  await cdp("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(DIALOGUE)}` }, sessionId);
  await sleep(800);
  await evaluate(`
    window.chrome = { runtime: { onMessage: { addListener() {} } } };
    window.__VOX_API__ = null;
    globalThis.__VOX_TEST_HOOK__ = (api) => { window.__VOX_API__ = api; };
    (0, eval)(${JSON.stringify(CONTENT)});
    !!window.__VOX_API__
  `);
  const talk = await evaluate(`JSON.stringify(window.__VOX_API__.extract())`).then(JSON.parse);

  step("the dialogue is recognised", (talk.speakers || []).join("+") === "Candidate+Interviewer",
    JSON.stringify(talk.speakers));
  step("its heading is marked", talk.chunks[0]?.heading === true, talk.chunks[0]?.text);
  step("the narration line has no speaker", talk.chunks[1]?.speaker == null, talk.chunks[1]?.text?.slice(0, 40));

  const turns = talk.chunks.filter((c) => c.speaker);
  step("every turn is attributed to someone", turns.length === 6, `${turns.length} turns`);
  step("turns alternate between the two speakers",
    turns.map((c) => c.speaker).join(",") === "Candidate,Interviewer,Candidate,Interviewer,Candidate,Interviewer",
    turns.map((c) => c.speaker).join(","));
  step("the speaker label stays in the spoken text",
    turns[0].text.startsWith("Candidate:"), turns[0].text.slice(0, 30));

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
