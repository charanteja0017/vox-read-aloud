/* Generates the 1280x800 screenshots the Chrome Web Store listing needs. */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_BIN;
const DIST = path.resolve("dist");
const OUT = path.resolve("docs/store");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONTENT = await readFile("src/content.js", "utf8");
await mkdir(OUT, { recursive: true });

const ARTICLE = (dark) => `<!doctype html><html><head><meta charset="utf-8"><title>a</title><style>
 body{font:19px/1.85 Georgia,serif;margin:0;padding:56px 72px;
   background:${dark ? "#151515" : "#fdfcfa"};color:${dark ? "#d9d5ce" : "#1b1b1b"}}
 h1{font:600 34px/1.25 Georgia,serif;margin:0 0 8px}
 .by{font-size:14px;color:${dark ? "#8b8880" : "#8a8580"};margin:0 0 28px}
 p{margin:0 0 22px;max-width:40em}</style></head><body>
 <h1>The quiet return of the reading voice</h1>
 <p class="by">Essays · nine minute read</p>
 <p>For twenty years synthetic speech sounded like a machine reading a phone book, and everyone simply learned to live with it. The voices were serviceable and nobody liked them.</p>
 <p>What changed was not the amount of computing power available but where it sits. A model small enough to run inside a browser tab can now produce speech that a listener will mistake for a recording, and it never has to leave the machine it runs on.</p>
 <p>That matters more than it sounds. Reading aloud is something people do with things they care about, and sending every page you read to a server has always been the quiet cost of it.</p>
 <p>What is left is the ordinary work of making it pleasant: following the voice with your eyes, starting from the paragraph you actually care about, and not having the machine grow hot in your lap while it happens.</p>
 <p>None of that is glamorous. All of it is the difference between a feature people try once and one they keep.</p>
 </body></html>`;

const profile = await mkdtemp(path.join(os.tmpdir(), "vox-store-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9677",
  `--user-data-dir=${profile}`, `--load-extension=${DIST}`, "--no-first-run",
  "--no-default-browser-check", "--force-device-scale-factor=2", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });

let ws, nextId = 1;
const pending = new Map();
const cdp = (m, p = {}, s) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, { resolve: res, reject: rej });
  ws.send(JSON.stringify({ id, method: m, params: p, ...(s ? { sessionId: s } : {}) }));
});

await sleep(3200);
const v = await (await fetch("http://127.0.0.1:9677/json/version")).json();
ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  const slot = pending.get(m.id);
  if (!slot) return;
  pending.delete(m.id);
  m.error ? slot.reject(new Error(m.error.message)) : slot.resolve(m.result);
};

const id = [...createHash("sha256").update(DIST, "utf8").digest("hex").slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

async function page(url, w, h, scale = 2) {
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Page.enable", {}, sessionId);
  await cdp("Runtime.enable", {}, sessionId);
  await cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: scale, mobile: false }, sessionId);
  await cdp("Page.navigate", { url }, sessionId);
  await sleep(900);
  return sessionId;
}
const evalIn = async (sid, expr) => {
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 60000 }, sid);
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || "").slice(0, 200));
  return r.result.value;
};
const shot = async (sid) => (await cdp("Page.captureScreenshot", { format: "png" }, sid)).data;

/* ---- the article, mid-read, in both themes ---------------------------- */

const articleShots = {};
for (const dark of [false, true]) {
  const sid = await page(`data:text/html;charset=utf-8,${encodeURIComponent(ARTICLE(dark))}`, 1280, 900);
  await evalIn(sid, `window.chrome={runtime:{onMessage:{addListener(){}}}};window.__A__=null;
    globalThis.__VOX_TEST_HOOK__=(a)=>{window.__A__=a;};(0,eval)(${JSON.stringify(CONTENT)});!!window.__A__`);
  await evalIn(sid, `(async()=>{const a=window.__A__;a.extract();
    const ch=a.index().chunks;let i=ch.findIndex(c=>c.text.startsWith("A model small"));if(i<0)i=3;
    a.highlight(i);const rs=a.wordRanges(ch[i]);const per=0.3;
    a.speakChunk({index:i,words:rs.map((_,k)=>[k*per,(k+1)*per]),duration:rs.length*per,paused:false});
    await new Promise(r=>setTimeout(r,2100));return a.__word();})()`);
  await sleep(250);
  articleShots[dark ? "dark" : "light"] = await shot(sid);
}

/* ---- the popup, showing a real reading state -------------------------- */

const popupSid = await page(`chrome-extension://${id}/ui/popup.html`, 820, 660);
await sleep(2000);

const CHUNKS = [
  "The quiet return of the reading voice",
  "For twenty years synthetic speech sounded like a machine reading a phone book, and everyone simply learned to live with it.",
  "The voices were serviceable and nobody liked them.",
  "What changed was not the amount of computing power available but where it sits.",
  "A model small enough to run inside a browser tab can now produce speech that a listener will mistake for a recording.",
  "It never has to leave the machine it runs on.",
  "Reading aloud is something people do with things they care about.",
  "Sending every page you read to a server has always been the quiet cost of it.",
];

// Answer the popup's queries locally instead of driving the real engine: asking
// the engine to speak would start a 310 MB model download and the screenshot
// would show a progress bar. Every pixel here is still the real UI rendering
// real state, just supplied directly.
await evalIn(popupSid, `(() => {
  const chunks = ${JSON.stringify(CHUNKS)};
  chrome.runtime.sendMessage = (msg) => {
    const type = msg && msg.payload && msg.payload.type;
    if (type === "GET_CHUNKS") return Promise.resolve({ ok: true, value: chunks });
    if (type === "CACHE_STATS") return Promise.resolve({ ok: true, value: { bytes: 18 * 1048576 } });
    return Promise.resolve(null);
  };
  return true;
})()`);

const seed = () => `(() => {
  let mask = ""; for (let i = 0; i < 8; i++) mask += i < 6 ? "1" : "0";
  chrome.runtime.onMessage.dispatch({ to: "ui", type: "STATE", state: {
    status: "playing", ready: true, downloaded: true, index: 4, total: 8,
    title: "The quiet return of the reading voice", source: "page",
    voice: "af_heart", speed: 1.1, profile: "best", device: "webgpu", threads: 6,
    rendered: 6, renderedMask: mask, rtf: 0.17, keepingUp: true,
    error: null, errorDetail: null, download: null, hasContent: true, speakers: [],
    chunkPreview: ${JSON.stringify(CHUNKS[4])},
  }});
  return true;
})()`;
await evalIn(popupSid, seed());
await sleep(600);
await evalIn(popupSid, seed());
await sleep(200);

// Clip to the popup itself so the frame has no dead space around it.
const box = await evalIn(popupSid, `JSON.stringify({ w: document.body.offsetWidth, h: Math.ceil(document.body.scrollHeight) })`).then(JSON.parse);
const popupShot = (await cdp("Page.captureScreenshot", {
  format: "png",
  clip: { x: 0, y: 0, width: box.w, height: box.h, scale: 2 },
}, popupSid)).data;

/* ---- compose 1280x800 store frames ------------------------------------ */

const CARD_W = 1152, CARD_H = 566;
const SHOT_H = 900 * (CARD_W / 1280);   // the page capture, scaled to card width

async function compose(name, bg, overlay, caption, focusY, cardBg) {
  // Clamp so the card is never taller than what remains of the image below the
  // offset — otherwise the card's own background shows as a bar.
  focusY = Math.max(0, Math.min(focusY, Math.floor(SHOT_H - CARD_H)));
  const sid = await page("about:blank", 1280, 800, 1);
  // The article sits in its own framed card rather than full-bleed, so the
  // caption can never collide with the headline inside the screenshot.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:1280px;height:800px;overflow:hidden;
      font:400 15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
    .wrap{position:relative;width:1280px;height:800px;
      background:radial-gradient(120% 90% at 20% 0%,#1b2130 0%,#0b0d11 62%)}
    .cap{position:absolute;left:64px;top:52px;color:#fff;max-width:900px}
    .cap h2{margin:0;font-size:38px;line-height:1.14;font-weight:650;letter-spacing:-.5px}
    .cap p{margin:11px 0 0;font-size:18px;color:#aab3c2}
    .card{position:absolute;left:64px;top:182px;width:${CARD_W}px;height:${CARD_H}px;
      border-radius:14px;overflow:hidden;background:${cardBg};
      box-shadow:0 26px 70px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08)}
    .card img{position:absolute;left:0;top:${-focusY}px;width:${CARD_W}px;display:block}
    .pop{position:absolute;right:44px;bottom:34px;width:600px;border-radius:13px;
      box-shadow:0 26px 66px rgba(0,0,0,.66),0 0 0 1px rgba(255,255,255,.10)}
  </style></head><body><div class="wrap">
    <div class="cap"><h2>${caption.title}</h2><p>${caption.sub}</p></div>
    <div class="card"><img src="data:image/png;base64,${bg}"></div>
    ${overlay ? `<img class="pop" src="data:image/png;base64,${overlay}">` : ""}
  </div></body></html>`;
  await cdp("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` }, sid);
  await sleep(1300);
  await writeFile(path.join(OUT, name), Buffer.from(await shot(sid), "base64"));
  console.log(`  ${name}`);
}

// The article capture is 1280 wide and displayed at 1152, so 0.9 of its pixels;
// these offsets bring the highlighted sentence into the card.
await compose("01-reads-any-page.png", articleShots.light, popupShot,
  { title: "A voice that runs on your own machine",
    sub: "Neural speech, no cloud, no account — and fully offline after the first download." },
  170, "#fdfcfa");
await compose("02-follows-every-word.png", articleShots.dark, null,
  { title: "The highlight follows the voice, word by word",
    sub: "Timing comes from the model itself, not a stopwatch — on light pages and dark." },
  230, "#151515");

// A third frame for the popup on its own. The raw capture is 1560px wide and
// therefore not a legal store size, so it gets composed like the others.
async function composePopup(name, shotB64, caption) {
  const sid = await page("about:blank", 1280, 800, 1);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:1280px;height:800px;overflow:hidden;
      font:400 15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
    .wrap{position:relative;width:1280px;height:800px;
      background:radial-gradient(120% 90% at 78% 8%,#1d2434 0%,#0b0d11 60%)}
    .cap{position:absolute;left:64px;top:52px;color:#fff;max-width:900px}
    .cap h2{margin:0;font-size:38px;line-height:1.14;font-weight:650;letter-spacing:-.5px}
    .cap p{margin:11px 0 0;font-size:18px;color:#aab3c2}
    .pop{position:absolute;left:50%;top:196px;transform:translateX(-50%);width:900px;
      border-radius:15px;box-shadow:0 30px 78px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.09)}
  </style></head><body><div class="wrap">
    <div class="cap"><h2>${caption.title}</h2><p>${caption.sub}</p></div>
    <img class="pop" src="data:image/png;base64,${shotB64}">
  </div></body></html>`;
  await cdp("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` }, sid);
  await sleep(1200);
  await writeFile(path.join(OUT, name), Buffer.from(await shot(sid), "base64"));
  console.log(`  ${name}`);
}

await composePopup("03-move-around-the-page.png", popupShot,
  { title: "Scrub, skip, or jump to any sentence",
    sub: "A draggable position bar, the full transcript, and shortcuts for play, pause and skip." });
ws.close();
chrome.kill("SIGKILL");
