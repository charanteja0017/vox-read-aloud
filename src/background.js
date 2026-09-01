/* Vox service worker — a thin router. It owns nothing that matters, because
   MV3 can evict it at any time; the offscreen document holds the real state. */

const OFFSCREEN_PATH = "offscreen.html";
let creating = null;
let readingTabId = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creating) return creating;
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      // AUDIO_PLAYBACK alone gets the document closed after 30s of silence,
      // which would kill long model downloads and lose the reading position on
      // a pause. WORKERS is equally true: synthesis runs in tts-worker.js.
      reasons: ["AUDIO_PLAYBACK", "WORKERS"],
      justification:
        "Spawns a worker that runs the on-device neural text-to-speech model, and plays the resulting audio.",
    })
    .catch((err) => {
      // Another call won the race; that is fine.
      if (!/single offscreen/i.test(String(err))) throw err;
    })
    .finally(() => { creating = null; });
  return creating;
}

// Only for commands that should bring the engine up if it is not running.
async function toEngine(type, extra = {}) {
  await ensureOffscreen();
  try {
    return await chrome.runtime.sendMessage({ to: "off", type, ...extra });
  } catch (err) {
    console.warn("[vox] engine message failed", type, err);
    return null;
  }
}

// For housekeeping: never spin the engine up just to ask it a question.
async function toEngineIfAlive(type, extra = {}) {
  if (!(await hasOffscreen())) return null;
  try {
    return await chrome.runtime.sendMessage({ to: "off", type, ...extra });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ page reading */

const RESTRICTED = /^(chrome|edge|about|devtools|view-source|chrome-extension):|^https:\/\/chromewebstore\.google\.com|^https:\/\/chrome\.google\.com\/webstore/;

function toast(message, isError = true, tabId = null) {
  chrome.runtime.sendMessage({ to: "ui", type: "TOAST", message, isError }).catch(() => {});
  // Right-click actions happen with the popup closed, so anything important has
  // to be said on the page itself or it is never seen.
  if (tabId != null) pageToast(tabId, message);
  if (isError) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
  }
}

async function pageToast(tabId, message) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [message],
      func: (text) => {
        document.getElementById("__vox_toast__")?.remove();
        const el = document.createElement("div");
        el.id = "__vox_toast__";
        el.setAttribute("data-vox-ui", "");
        el.textContent = text;
        el.style.cssText = [
          "position:fixed", "z-index:2147483647", "left:50%", "bottom:28px",
          "transform:translateX(-50%)", "max-width:min(520px,86vw)",
          "padding:11px 15px", "border-radius:11px",
          "background:#161b23", "color:#e8ecf2", "border:1px solid #38414f",
          "box-shadow:0 8px 28px rgba(0,0,0,.38)",
          "font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
          "pointer-events:none", "opacity:0", "transition:opacity .18s ease",
        ].join(";");
        (document.body || document.documentElement).appendChild(el);
        requestAnimationFrame(() => { el.style.opacity = "1"; });
        setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 4200);
      },
    });
  } catch { /* restricted page — nothing we can do */ }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function readTab(tab, options = {}) {
  if (!tab || tab.id == null) return;
  if (tab.url && RESTRICTED.test(tab.url)) {
    const reason = "Vox can't read the browser's own pages. Open a normal web page and try again.";
    toast(reason, true, tab.id);
    return { started: false, reason };
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  } catch (err) {
    const reason = "Vox needs permission for this page. Click the Vox icon once, then try again.";
    toast(reason, true, tab.id);
    console.warn("[vox] injection failed", err);
    return { started: false, reason };
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, {
      to: "content",
      type: "EXTRACT",
      anchor: !!options.fromAnchor,
    });
  } catch (err) {
    const reason = "Couldn't read this page.";
    toast(reason, true, tab.id);
    console.warn("[vox] extract failed", err);
    return { started: false, reason };
  }

  if (!response || !response.ok) {
    const reason = response?.error || "Couldn't read this page.";
    toast(reason, true, tab.id);
    return { started: false, reason };
  }

  const { chunks, title, source, startIndex, anchorFound, speakers } = response.data;

  // The listener was registered after this page loaded, so this right-click was
  // never recorded. Install it now so the next one works, and say so.
  if (options.fromAnchor && !anchorFound) {
    chrome.scripting
      .executeScript({ target: { tabId: tab.id }, files: ["anchor.js"] })
      .catch(() => {});
    toast("Vox wasn't watching this page yet — reading from the top. Right-click again to start from a specific spot.", false, tab.id);
  }
  if (!chunks.length) {
    const reason = "No readable text found here. Try selecting some text first.";
    toast(reason, true, tab.id);
    return { started: false, reason };
  }

  const sent = await toEngine("SPEAK", { chunks, title, source, tabId: tab.id, startIndex, speakers });
  if (!sent) {
    const reason = "The speech engine didn't respond. Try again.";
    toast(reason, true, tab.id);
    return { started: false, reason };
  }
  return { started: true };
}

/* -------------------------------------------------------------- commands */

const SIMPLE = {
  "play-pause": () => toEngine("TOGGLE"),
  "stop": () => toEngine("STOP"),
  "next-sentence": () => toEngine("NEXT"),
  "prev-sentence": () => toEngine("PREV"),
  "speed-up": () => toEngine("SPEED_STEP", { delta: 1 }),
  "speed-down": () => toEngine("SPEED_STEP", { delta: -1 }),
};

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "read-aloud") {
    await readTab(tab || (await activeTab()));
    return;
  }
  const handler = SIMPLE[command];
  if (handler) await handler();
});

/* ------------------------------------------------------------ context menu */

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "vox-read-from-here",
      title: "Start reading from here",
      contexts: ["page", "selection"],
    });
    chrome.contextMenus.create({
      id: "vox-read-selection",
      title: "Read selection aloud",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "vox-read-page",
      title: "Read this page from the top",
      contexts: ["page"],
    });
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  buildMenus();
  await syncAnchorScript();
  await primeOpenTabs();
});
chrome.runtime.onStartup.addListener(async () => {
  buildMenus();
  await syncAnchorScript();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "vox-read-from-here") {
    if (!(await hasAnchorAccess())) {
      toast(
        "Open the Vox popup and switch on \u201cRight-click \u2192 start reading from here\u201d, then try again.",
        true, tab?.id,
      );
      return;
    }
    readTab(tab, { fromAnchor: true });
    return;
  }
  if (info.menuItemId === "vox-read-selection" || info.menuItemId === "vox-read-page") {
    readTab(tab);
  }
});

/* ------------------------------------------------------- right-click anchor */

// The only thing this content script does is remember where the pointer was,
// because chrome.contextMenus.onClicked does not report coordinates. It is
// registered only while the optional host permission is granted.
const ANCHOR_SCRIPT = {
  id: "vox-anchor",
  js: ["anchor.js"],
  matches: ["<all_urls>"],
  runAt: "document_start",
  allFrames: false,
  persistAcrossSessions: true,
};

function hasAnchorAccess() {
  return chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => false);
}

async function syncAnchorScript() {
  const granted = await hasAnchorAccess();
  let registered = [];
  try {
    registered = await chrome.scripting.getRegisteredContentScripts({ ids: ["vox-anchor"] });
  } catch { /* none registered yet */ }

  try {
    if (granted && !registered.length) await chrome.scripting.registerContentScripts([ANCHOR_SCRIPT]);
    else if (!granted && registered.length) await chrome.scripting.unregisterContentScripts({ ids: ["vox-anchor"] });
  } catch (err) {
    console.warn("[vox] could not sync the anchor script", err);
  }
}

// registerContentScripts only affects pages loaded from now on, so every tab
// that is already open would silently have no recorded click position.
async function primeOpenTabs() {
  if (!(await hasAnchorAccess())) return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return; }
  await Promise.all(tabs.map((tab) => {
    if (tab.id == null || !tab.url || RESTRICTED.test(tab.url)) return null;
    return chrome.scripting
      .executeScript({ target: { tabId: tab.id }, files: ["anchor.js"] })
      .catch(() => {});
  }));
}

chrome.permissions.onAdded.addListener(async () => {
  await syncAnchorScript();
  await primeOpenTabs();
});
chrome.permissions.onRemoved.addListener(syncAnchorScript);

/* ------------------------------------------------------------- ui feedback */

const BADGE = {
  playing: { text: "▶", color: "#2e9e5b" },
  paused: { text: "II", color: "#8a8f98" },
  buffering: { text: "…", color: "#d98324" },
  loading: { text: "…", color: "#d98324" },
  error: { text: "!", color: "#c0392b" },
};

function paintBadge(state) {
  const badge = BADGE[state.status];
  chrome.action.setBadgeText({ text: badge ? badge.text : "" });
  if (badge) chrome.action.setBadgeBackgroundColor({ color: badge.color });
}

/* --------------------------------------------------------------- routing */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.to !== "bg") return false;

  switch (msg.type) {
    case "STATE":
      readingTabId = msg.state.tabId ?? null;
      paintBadge(msg.state);
      return false;

    case "HIGHLIGHT":
      chrome.tabs
        .sendMessage(msg.tabId, { to: "content", type: "HIGHLIGHT", index: msg.index })
        .catch(() => {});
      return false;

    case "CLEAR":
      chrome.tabs
        .sendMessage(msg.tabId, { to: "content", type: "CLEAR" })
        .catch(() => {});
      return false;

    case "SPEAK_CHUNK":
      chrome.tabs
        .sendMessage(msg.tabId, {
          to: "content",
          type: "SPEAK_CHUNK",
          index: msg.index,
          words: msg.words,
          duration: msg.duration,
          paused: msg.paused,
        })
        .catch(() => {});
      return false;

    case "PAGE":
      chrome.tabs
        .sendMessage(msg.tabId, { to: "content", type: msg.action })
        .catch(() => {});
      return false;

    case "READ_ACTIVE_TAB":
      (async () => {
        try {
          const result = await readTab(await activeTab(), { fromAnchor: msg.fromAnchor });
          sendResponse({ ok: true, ...(result || { started: false, reason: "Nothing to read." }) });
        } catch (err) {
          sendResponse({ ok: false, started: false, reason: String(err?.message || err) });
        }
      })();
      return true;

    case "LOAD_SETTINGS":
      chrome.storage.local
        .get(["voice", "speed", "profile", "autoload"])
        .then((settings) => sendResponse({ ok: true, settings }), () => sendResponse({ ok: false, settings: {} }));
      return true;

    case "SAVE_SETTINGS":
      chrome.storage.local
        .set(msg.settings || {})
        .then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
      return true;

    case "LOAD_SESSION":
      chrome.storage.session
        .get("session")
        .then((data) => sendResponse({ ok: true, session: data.session }), () => sendResponse({ ok: false }));
      return true;

    case "SAVE_SESSION":
      (async () => {
        try {
          // A position-only update merges into what is already stored, so the
          // article text is not re-serialised once per sentence.
          const next = msg.merge
            ? { ...(await chrome.storage.session.get("session")).session, ...msg.session }
            : msg.session;
          await chrome.storage.session.set({ session: next });
          sendResponse({ ok: true });
        } catch {
          sendResponse({ ok: false });
        }
      })();
      return true;

    // Every UI command goes through here so that a document Chrome has closed
    // gets recreated before the message is delivered.
    case "ENGINE":
      toEngine(msg.payload.type, msg.payload).then(
        (res) => sendResponse(res),
        () => sendResponse(null),
      );
      return true;

    case "ANCHOR_STATE":
      hasAnchorAccess().then((granted) => sendResponse({ ok: true, granted }));
      return true;

    case "SET_ANCHOR":
      (async () => {
        try {
        // permissions.request must run from the popup's user gesture, so the
        // popup grants it and only tells us to re-sync afterwards.
          if (!msg.enabled) await chrome.permissions.remove({ origins: ["<all_urls>"] }).catch(() => {});
          await syncAnchorScript();
          if (msg.enabled) await primeOpenTabs();
          sendResponse({ ok: true, granted: await hasAnchorAccess() });
        } catch (err) {
          sendResponse({ ok: false, granted: false, error: String(err?.message || err) });
        }
      })();
      return true;

    case "ENSURE_ENGINE":
      ensureOffscreen().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
      return true;

    default:
      return false;
  }
});

/* Stop reading when the page being read goes away. These fire for every tab in
   the browser, so they must stay cheap and must never wake the engine. */

async function isReadingTab(tabId) {
  if (readingTabId != null) return readingTabId === tabId;
  const res = await toEngineIfAlive("GET_STATE");
  if (!res) return false;
  readingTabId = res.state?.tabId ?? null;
  return readingTabId === tabId;
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (!(await isReadingTab(tabId))) return;
  readingTabId = null;
  toEngineIfAlive("STOP");
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  if (await isReadingTab(tabId)) toEngineIfAlive("STOP");
});
