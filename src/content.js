/* Vox content script — text extraction, sentence indexing, live highlighting.
   Injected on demand via chrome.scripting.executeScript, so it must be
   idempotent: a second injection into the same page must be a no-op. */
(() => {
  if (window.__VOX_CONTENT_LOADED__) return;
  window.__VOX_CONTENT_LOADED__ = true;

  const MAX_CHUNK = 240;   // chars; Kokoro's context is ~510 phoneme tokens
  const MIN_CHUNK = 8;     // stray tokens shorter than this get absorbed by their neighbour

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CANVAS", "IFRAME", "OBJECT", "EMBED",
    "VIDEO", "AUDIO", "SELECT", "TEXTAREA", "BUTTON", "INPUT", "LABEL",
    "NAV", "FOOTER", "ASIDE", "FORM", "PRE", "CODE", "KBD", "SAMP", "MATH",
    "FIGCAPTION", "TEMPLATE", "DIALOG",
  ]);

  const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

  const BLOCK_TAGS = new Set([
    "P", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "BR", "HR", "LI", "UL",
    "OL", "DL", "DT", "DD", "TABLE", "TR", "TD", "TH", "BLOCKQUOTE", "FIGURE",
    "H1", "H2", "H3", "H4", "H5", "H6", "ADDRESS", "DETAILS", "SUMMARY",
  ]);

  // Words that end in "." without ending a sentence. Split in two tiers because
  // many short abbreviations are also ordinary words: "the cat sat." must break,
  // "Sat. 12 June" must not. Weak entries only count when actually capitalised.
  const ABBREV_STRONG = new Set([
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "rev", "hon", "sgt", "col",
    "gen", "lt", "capt", "cmdr", "maj", "rep", "sen", "gov", "etc", "eg", "ie",
    "vs", "cf", "viz", "approx", "dept", "inc", "ltd", "corp", "univ", "fig",
    "phd", "md", "bsc", "msc", "al", "esp", "incl", "apt", "ave", "blvd", "vol",
    "pp", "e.g", "i.e",
  ]);

  const ABBREV_WEAK = new Set([
    "st", "mt", "no", "co", "ed", "p", "pg", "op", "ch", "sec", "art",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
    "nov", "dec", "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri",
    "sat", "sun", "us", "uk", "eu", "usa",
  ]);

  /* ---------------------------------------------------------------- index */

  // Flat text of the page plus the text-node map needed to turn a character
  // offset back into a DOM Range.
  let INDEX = { text: "", nodes: [], chunks: [] };

  const styleCache = new WeakMap();
  function isVisible(el) {
    if (styleCache.has(el)) return styleCache.get(el);
    let ok = true;
    try {
      const cs = getComputedStyle(el);
      ok = cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
    } catch { /* detached node */ }
    styleCache.set(el, ok);
    return ok;
  }

  function shouldSkip(el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    if (el.hasAttribute("hidden")) return true;
    const cls = typeof el.className === "string" ? el.className.toLowerCase() : "";
    if (/(^|\s)(sr-only|visually-hidden|screen-reader|skip-link|advertisement)(\s|$)/.test(cls)) return true;
    if (el.closest && el.closest("[data-vox-ui]")) return true;
    return !isVisible(el);
  }

  function collect(roots, filterRange) {
    const nodes = [];
    const headings = [];
    let text = "";
    let pendingBreak = false;

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (filterRange && !filterRange.intersectsNode(node)) return;
        let raw = node.nodeValue;
        if (!raw || !raw.trim()) {
          if (raw && /\s/.test(raw)) pendingBreak = pendingBreak || false;
          return;
        }
        // Clip to the selection when only part of the node is selected.
        let nodeStart = 0, nodeEnd = raw.length;
        if (filterRange) {
          if (node === filterRange.startContainer) nodeStart = filterRange.startOffset;
          if (node === filterRange.endContainer) nodeEnd = filterRange.endOffset;
          if (nodeEnd <= nodeStart) return;
        }
        const slice = raw.slice(nodeStart, nodeEnd);
        if (!slice.trim()) return;

        if (pendingBreak && text && !text.endsWith("\n")) text += "\n";
        pendingBreak = false;
        // Inline elements need a space between them, but not when what follows
        // opens with punctuation: "<b>Candidate</b>: yes" must not become
        // "Candidate : yes", which reads oddly aloud and breaks speaker
        // detection.
        if (text && !/[\s\n]$/.test(text) && /^\S/.test(slice) && !/^[,.;:!?%)\]}…’”»]/.test(slice)) {
          text += " ";
        }

        const start = text.length;
        text += slice;
        nodes.push({ node, nodeStart, start, end: text.length });
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (shouldSkip(node)) return;
      const isBlock = BLOCK_TAGS.has(node.tagName);
      if (isBlock) pendingBreak = true;

      const headingFrom = HEADING_TAGS.has(node.tagName) ? text.length : -1;

      if (node.shadowRoot) {
        for (const child of node.shadowRoot.childNodes) walk(child);
      }
      for (const child of node.childNodes) walk(child);

      if (headingFrom >= 0 && text.length > headingFrom) headings.push([headingFrom, text.length]);
      if (isBlock) pendingBreak = true;
    };

    for (const root of Array.isArray(roots) ? roots : [roots]) {
      walk(root);
      pendingBreak = true;
    }
    return { text, nodes, headings };
  }

  /* ------------------------------------------------------ main-content pick */

  function linkDensity(el) {
    const total = el.textContent.length || 1;
    let linked = 0;
    for (const a of el.querySelectorAll("a")) linked += a.textContent.length;
    return linked / total;
  }

  function pickRoot() {
    for (const sel of ["article", "main", '[role="main"]']) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 400 && linkDensity(el) < 0.5) return el;
    }

    // Group readable blocks by their container and take the densest container.
    const blocks = document.querySelectorAll("p, li, blockquote, h1, h2, h3, h4");
    const scores = new Map();
    for (const b of blocks) {
      const len = b.textContent.trim().length;
      if (len < 40) continue;
      let parent = b.parentElement;
      for (let depth = 0; parent && depth < 3; depth++, parent = parent.parentElement) {
        scores.set(parent, (scores.get(parent) || 0) + len / (depth + 1));
      }
    }
    let best = null, bestScore = 0;
    for (const [el, score] of scores) {
      const adjusted = score * (1 - Math.min(linkDensity(el), 0.9));
      if (adjusted > bestScore) { bestScore = adjusted; best = el; }
    }
    return best && bestScore > 300 ? best : document.body;
  }

  /* ------------------------------------------------------------- splitting */

  function isSentenceEnd(text, i) {
    const ch = text[i];
    if (!".!?…".includes(ch)) return false;

    // "3.14" / "v1.2"
    if (ch === "." && /\d/.test(text[i - 1] || "") && /\d/.test(text[i + 1] || "")) return false;

    // The break must be followed by whitespace or end of text.
    let j = i + 1;
    while (j < text.length && "\"')]}»”’".includes(text[j])) j++;
    if (j < text.length && !/\s/.test(text[j])) return false;

    // What follows the break, ignoring whitespace.
    let n = j;
    while (n < text.length && /\s/.test(text[n])) n++;
    const nextChar = n < text.length ? text[n] : "";

    if (ch === ".") {
      // A following lowercase letter almost always means this was not a break.
      if (nextChar && /[a-z]/.test(nextChar)) return false;

      // Never break inside a URL or an email address.
      if (/(https?:\/\/|www\.)\S*$|\S+@\S*$/.test(text.slice(Math.max(0, i - 80), i))) return false;

      let k = i - 1;
      while (k >= 0 && /\S/.test(text[k])) k--;
      const token = text.slice(k + 1, i);
      const word = token.replace(/[^A-Za-z]/g, "").toLowerCase();

      // Single initials: "J. R. R. Tolkien".
      if (word.length === 1) return false;
      if (ABBREV_STRONG.has(word)) return false;
      if (ABBREV_WEAK.has(word) && /^[A-Z]/.test(token)) return false;

      // Dotted initialisms: "p.m.", "U.S.", "e.g." — only when more follows.
      if (/^([A-Za-z]\.)+[A-Za-z]$/.test(token) && nextChar && /[A-Z0-9]/.test(nextChar)) return false;
    }

    return true;
  }

  function rawSentences(text) {
    const out = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\n") {
        if (text.slice(start, i).trim()) out.push([start, i]);
        start = i + 1;
        continue;
      }
      if (isSentenceEnd(text, i)) {
        let end = i + 1;
        while (end < text.length && "\"')]}»”’".includes(text[end])) end++;
        if (text.slice(start, end).trim()) out.push([start, end]);
        start = end;
      }
    }
    if (text.slice(start).trim()) out.push([start, text.length]);
    return out;
  }

  // Kokoro degrades past its context window, so long sentences are cut at the
  // most natural pause available.
  function subdivide(text, start, end) {
    if (end - start <= MAX_CHUNK) return [[start, end]];
    const out = [];
    let cursor = start;
    while (end - cursor > MAX_CHUNK) {
      const window = text.slice(cursor, cursor + MAX_CHUNK);
      let cut = -1;
      for (const re of [/[;:—](?=\s)/g, /,(?=\s)/g, /\s(?=and\s|but\s|or\s|because\s|which\s|that\s)/g, /\s/g]) {
        let m, last = -1;
        while ((m = re.exec(window))) if (m.index > MAX_CHUNK * 0.35) last = m.index + m[0].length;
        if (last > 0) { cut = last; break; }
      }
      if (cut <= 0) cut = MAX_CHUNK;
      out.push([cursor, cursor + cut]);
      cursor += cut;
    }
    if (text.slice(cursor, end).trim()) out.push([cursor, end]);
    return out;
  }

  function buildChunks(text, headings = []) {
    const inHeading = (from, to) => headings.some(([a, b]) => from >= a && to <= b);

    const raw = [];
    for (const [s, e] of rawSentences(text)) {
      // Trim surrounding whitespace so highlights hug the words.
      let a = s, b = e;
      while (a < b && /\s/.test(text[a])) a++;
      while (b > a && /\s/.test(text[b - 1])) b--;
      if (b <= a) continue;
      if (!/[A-Za-z0-9]/.test(text.slice(a, b))) continue;   // rules, bullets, noise
      for (const piece of subdivide(text, a, b)) raw.push(piece);
    }

    // Some pages break one sentence across many block elements — a line each,
    // occasionally a word each. Left alone every fragment becomes its own
    // utterance and the voice stops dead between them. A fragment that does not
    // end a sentence, and is followed by something that reads as a
    // continuation, belongs with what comes next.
    const stitched = [];
    for (let i = 0; i < raw.length; i++) {
      let [start, end] = raw[i];
      while (i + 1 < raw.length) {
        const body = text.slice(start, end);
        const next = raw[i + 1];
        const finished = /[.!?…:;"”’)\]]$/.test(body);
        const words = body.split(/\s+/).filter(Boolean).length;
        const continues = /^[a-z0-9,;)]/.test(text.slice(next[0], next[1]));
        const fits = next[1] - start <= MAX_CHUNK;
        // A heading is its own utterance, however short it is.
        const crossesHeading = inHeading(start, end) || inHeading(next[0], next[1]);
        if (finished || !fits || crossesHeading || !(continues || words <= 2)) break;
        end = next[1];
        i++;
      }
      stitched.push([start, end]);
    }

    // A bare list marker ("1.", "iv.") belongs to the item after it; any other
    // too-short scrap joins the chunk before it.
    const merged = [];
    let marker = null;
    for (const [s, e] of stitched) {
      const body = text.slice(s, e);

      let start = s;
      if (marker !== null) {
        if (e - marker <= MAX_CHUNK) start = marker;
        marker = null;
      }

      const short = e - start < MIN_CHUNK;
      if (short && !/[A-Za-z]{2}/.test(body)) { marker = start; continue; }

      const prev = merged[merged.length - 1];
      const scrap = short && !/[.!?…:;"”’)]$/.test(body);
      if (prev && scrap && e - prev[0] <= MAX_CHUNK) prev[1] = e;
      else merged.push([start, e]);
    }

    return merged.map(([s, e], i) => ({ i, start: s, end: e, text: text.slice(s, e).replace(/\s+/g, " ") }));
  }

  /* ------------------------------------------------- speakers and headings */

  // "Candidate: Should we rank the results?" — a dialogue reads far better when
  // each speaker gets their own voice. The label is left in the spoken text on
  // purpose: stripping it would desynchronise the word timings from the word
  // ranges on the page, and the highlight would drift.
  const SPEAKER_RE = /^([\p{Lu}][\p{L}.'’-]*(?:\s[\p{L}.'’-]+){0,2})\s*[:：]\s+\S/u;

  function speakerOf(text) {
    const match = SPEAKER_RE.exec(text);
    if (!match) return null;
    const label = match[1].trim();
    if (label.length < 2 || label.length > 24) return null;
    // "Note:", "Warning:", "Example:" are labels, not people — they are ruled
    // out below by requiring at least two distinct labels that recur.
    return label;
  }

  // Only treat it as a conversation when at least two labels each recur and
  // between them they cover a real share of the text. One stray "Tip:" should
  // not repaint an article in two voices.
  function detectSpeakers(chunks) {
    const counts = new Map();
    const labels = chunks.map((c) => speakerOf(c.text));
    labels.forEach((label) => {
      if (label) counts.set(label, (counts.get(label) || 0) + 1);
    });

    const recurring = [...counts.entries()].filter(([, n]) => n >= 2).map(([label]) => label);
    if (recurring.length < 2) return { speakers: [], labels: labels.map(() => null) };

    const covered = labels.filter((l) => l && recurring.includes(l)).length;
    if (covered / chunks.length < 0.25) return { speakers: [], labels: labels.map(() => null) };

    const order = [];
    const resolved = labels.map((label) => {
      if (!label || !recurring.includes(label)) return null;
      if (!order.includes(label)) order.push(label);
      return label;
    });
    return { speakers: order, labels: resolved };
  }

  function markStructure(chunks, headings) {
    const { speakers, labels } = detectSpeakers(chunks);
    chunks.forEach((chunk, i) => {
      chunk.speaker = labels[i];
      chunk.heading = headings.some(([a, b]) => chunk.start >= a && chunk.end <= b);
    });
    return speakers;
  }

  /* ------------------------------------------------------------ highlight */

  // Translucent amber over a light page reads as highlighter ink; over a dark
  // one — Dark Reader, or any dark theme — the same colour turns to olive
  // sludge. So the palette is chosen from the page's actual background, and the
  // sentence wash is kept far lighter than the word marker.
  function pageIsDark() {
    const sample = (el) => {
      if (!el) return null;
      const colour = getComputedStyle(el).backgroundColor;
      const m = /rgba?\(([^)]+)\)/.exec(colour || "");
      if (!m) return null;
      const [r, g, b, alpha = "1"] = m[1].split(",").map((v) => parseFloat(v));
      if (parseFloat(alpha) < 0.5) return null;
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    const luminance = sample(document.body) ?? sample(document.documentElement) ?? 1;
    return luminance < 0.5;
  }

  const PALETTES = {
    light: { sentence: "rgba(255, 213, 74, .30)", marker: "rgba(255, 199, 40, .46)", glow: "rgba(214, 154, 0, .30)" },
    dark:  { sentence: "rgba(255, 213, 74, .11)", marker: "rgba(255, 214, 92, .30)", glow: "rgba(255, 206, 74, .34)" },
  };

  let palette = PALETTES.light;

  function highlightCss() {
    return `
      ::highlight(vox-current) { background: ${palette.sentence}; }
      #__vox_marker__ {
        /* top/left pin the origin to the document; without them "absolute"
           starts from wherever the element would have flowed, and every
           translate() lands somewhere below the article. */
        position: absolute; top: 0; left: 0;
        z-index: 2147483646; pointer-events: none;
        border-radius: 5px; background: ${palette.marker};
        box-shadow: 0 0 0 1px ${palette.glow}, 0 2px 10px ${palette.glow};
        opacity: 0; transition: opacity .16s ease;
        will-change: transform, width, height;
      }
      #__vox_marker__.on { opacity: 1; }
    `;
  }

  function ensureStyle() {
    palette = pageIsDark() ? PALETTES.dark : PALETTES.light;
    let style = document.getElementById("__vox_style__");
    if (!style) {
      style = document.createElement("style");
      style.id = "__vox_style__";
      style.setAttribute("data-vox-ui", "");
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = highlightCss();
    ensureMarker();
  }

  /* --------------------------------------------------------- word marker */

  // The spoken word is drawn as a rounded marker that glides between words
  // rather than a rectangle that blinks from one to the next. It lives in
  // document coordinates, so it stays glued to the text while the page scrolls
  // without needing to be repositioned on every scroll event.
  const marker = { el: null, x: 0, y: 0, w: 0, h: 0, shown: false };

  function ensureMarker() {
    if (marker.el && marker.el.isConnected) return marker.el;
    const el = document.createElement("div");
    el.id = "__vox_marker__";
    el.setAttribute("data-vox-ui", "");
    el.setAttribute("aria-hidden", "true");
    (document.body || document.documentElement).appendChild(el);
    marker.el = el;
    marker.shown = false;
    return el;
  }

  function hideMarker() {
    if (marker.el) marker.el.classList.remove("on");
    marker.shown = false;
  }

  function placeMarker(range, animate) {
    const el = ensureMarker();
    const rects = range.getClientRects();
    const rect = rects.length ? rects[0] : range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;

    const pad = 2;
    const target = {
      x: rect.left + window.scrollX - pad,
      y: rect.top + window.scrollY - pad,
      w: rect.width + pad * 2,
      h: rect.height + pad * 2,
    };

    // Sliding sideways along a line looks alive; sliding diagonally across a
    // paragraph looks broken, so a change of line is a cut, not a move.
    const sameLine = marker.shown && Math.abs(target.y - marker.y) < rect.height * 0.6;
    const ease = animate && sameLine ? 0.34 : 1;

    marker.x += (target.x - marker.x) * ease;
    marker.y += (target.y - marker.y) * ease;
    marker.w += (target.w - marker.w) * ease;
    marker.h += (target.h - marker.h) * ease;

    el.style.transform = `translate(${marker.x}px, ${marker.y}px)`;
    el.style.width = `${marker.w}px`;
    el.style.height = `${marker.h}px`;
    if (!marker.shown) {
      marker.shown = true;
      requestAnimationFrame(() => el.classList.add("on"));
    }
    return Math.abs(target.x - marker.x) > 0.5 || Math.abs(target.w - marker.w) > 0.5;
  }

  function rangeFor(start, end) {
    const { nodes } = INDEX;
    if (!nodes.length) return null;
    const find = (offset, isEnd) => {
      let lo = 0, hi = nodes.length - 1, hit = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const n = nodes[mid];
        if (offset < n.start) hi = mid - 1;
        else if (offset > n.end) lo = mid + 1;
        else { hit = n; break; }
      }
      if (!hit) hit = isEnd ? nodes[nodes.length - 1] : nodes[0];
      const local = Math.min(Math.max(offset - hit.start, 0), hit.end - hit.start);
      return [hit.node, hit.nodeStart + local];
    };
    try {
      const range = document.createRange();
      const [sn, so] = find(start, false);
      const [en, eo] = find(end, true);
      range.setStart(sn, so);
      range.setEnd(en, eo);
      return range;
    } catch {
      return null;
    }
  }

  const supportsHighlight = typeof CSS !== "undefined" && CSS.highlights;

  function paint(name, range, priority) {
    if (!supportsHighlight) return;
    const highlight = new Highlight();
    if (range) highlight.add(range);
    highlight.priority = priority;
    CSS.highlights.set(name, highlight);
  }

  /* ------------------------------------------------------ smooth following */

  // Jumping the page whenever a sentence left a band is what made this feel
  // lurchy. Instead a single rAF loop eases the page toward the spoken line,
  // and yields immediately whenever the reader scrolls for themselves.
  const REST_FRACTION = 0.38;    // where a followed line settles in the viewport
  const ENTER_TOP = 0.12;        // outside this band, start following
  const ENTER_BOTTOM = 0.78;
  const MAX_STEP = 24;           // px per frame, so a long jump still glides
  const EASE = 0.14;
  const USER_GRACE = 1800;       // ms of hands-off after a manual scroll

  const follow = {
    raf: 0,
    range: null,
    engaged: false,
    suppressUntil: 0,
    scroller: undefined,
    override: false,
    inset: 0,
    insetAt: 0,
  };

  function scrollerFor(node) {
    let el = node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4) return el;
      el = el.parentElement;
    }
    return null;   // the document itself
  }

  // Sticky headers cover the top of the viewport; parking a line underneath one
  // looks like the reader lost its place.
  function topInset() {
    const now = Date.now();
    if (now - follow.insetAt < 700) return follow.inset;
    follow.insetAt = now;
    let inset = 0;
    try {
      const probes = document.elementsFromPoint(Math.round(window.innerWidth / 2), 3);
      for (const el of probes) {
        if (el === document.documentElement || el === document.body) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== "fixed" && cs.position !== "sticky") continue;
        const rect = el.getBoundingClientRect();
        if (rect.top <= 2 && rect.bottom > inset && rect.bottom < window.innerHeight * 0.4) {
          inset = rect.bottom;
        }
      }
    } catch { /* elementsFromPoint can throw on detached documents */ }
    follow.inset = inset;
    return inset;
  }

  function scrollBy(amount) {
    if (follow.scroller) follow.scroller.scrollTop += amount;
    else window.scrollBy({ top: amount, left: 0, behavior: "instant" });
  }

  function followStep() {
    if (!follow.range) return false;
    if (follow.override || Date.now() < follow.suppressUntil) {
      follow.engaged = false;
      return false;
    }

    let rect;
    try { rect = follow.range.getBoundingClientRect(); } catch { return false; }
    if (!rect || (!rect.height && !rect.width)) return false;

    const inset = topInset();
    const viewHeight = window.innerHeight - inset;
    if (viewHeight <= 0) return false;

    const comfortable = rect.top >= inset + viewHeight * ENTER_TOP
      && rect.bottom <= inset + viewHeight * ENTER_BOTTOM;
    if (!follow.engaged) {
      if (comfortable) return false;
      follow.engaged = true;
    }

    const delta = rect.top - (inset + viewHeight * REST_FRACTION);
    if (Math.abs(delta) < 1.5) { follow.engaged = false; return false; }

    // A seek across the article is a jump, not a scroll; gliding through three
    // screens of text would take many seconds and read as a bug.
    if (Math.abs(delta) > window.innerHeight * 2.5) {
      scrollBy(delta);
      follow.engaged = false;
      return false;
    }

    const cap = Math.max(MAX_STEP, viewHeight * 0.05);
    const step = Math.sign(delta) * Math.min(Math.abs(delta) * EASE, cap);
    const before = follow.scroller ? follow.scroller.scrollTop : window.scrollY;
    scrollBy(step);
    const after = follow.scroller ? follow.scroller.scrollTop : window.scrollY;
    // Hit the end of the document: nothing more to do.
    if (Math.abs(after - before) < 0.5) { follow.engaged = false; return false; }
    return true;
  }

  // Scrolling away is a deliberate act. Hand control back until the reader
  // moves on to the next sentence, rather than dragging them back after a
  // couple of seconds.
  function noteUserScroll() {
    follow.suppressUntil = Date.now() + USER_GRACE;
    follow.override = true;
    follow.engaged = false;
  }

  for (const type of ["wheel", "touchmove"]) {
    window.addEventListener(type, noteUserScroll, { passive: true, capture: true });
  }
  window.addEventListener("keydown", (event) => {
    if (/^(Arrow|Page)|^(Home|End|Space)$/.test(event.key) || event.key === " ") noteUserScroll();
  }, true);

  function aimAt(range) {
    follow.range = range || null;
    follow.engaged = false;
    // Moving to a new sentence means the reading has moved on, so following
    // resumes. If they are still scrolling, the next wheel event suppresses it
    // again immediately.
    follow.override = false;
    follow.suppressUntil = 0;
    if (range) {
      const node = range.startContainer;
      follow.scroller = scrollerFor(node);
      // A fresh target overrides an old hands-off grace period only if the
      // reader has not touched anything for a moment.
      run();
    }
  }

  /* --------------------------------------------------- word-level animation */

  const anim = { ranges: [], times: [], startedAt: 0, pausedAt: 0, at: -1, active: false, range: null };

  function stopAnimation() {
    anim.active = false;
    anim.at = -1;
    anim.times = [];
    anim.range = null;
  }

  function run() {
    if (follow.raf) return;
    follow.raf = requestAnimationFrame(loop);
  }

  function loop() {
    follow.raf = 0;
    let busy = false;

    if (anim.active && !anim.pausedAt && anim.times.length) {
      const elapsed = (performance.now() - anim.startedAt) / 1000;
      let next = anim.at;
      while (next + 1 < anim.times.length && elapsed >= anim.times[next + 1][0]) next++;
      if (next < 0 && elapsed >= anim.times[0][0]) next = 0;

      if (next !== anim.at && next >= 0) {
        anim.at = next;
        const [from, to] = anim.ranges[next];
        anim.range = rangeFor(from, to);
      }
      const last = anim.times[anim.times.length - 1];
      if (anim.at < anim.times.length - 1 || elapsed <= (last ? last[1] : 0)) busy = true;
      else anim.active = false;
    }

    // Re-placed every frame so the marker stays welded to its word while the
    // page eases along underneath it.
    if (anim.range && placeMarker(anim.range, true)) busy = true;

    if (followStep()) busy = true;

    // Nothing to do while paused — spinning at 60fps for a paused reader is
    // pure battery burn.
    if (busy || (anim.active && !anim.pausedAt)) follow.raf = requestAnimationFrame(loop);
  }

  function highlight(index) {
    if (!supportsHighlight) return;
    const chunk = INDEX.chunks[index];
    if (!chunk) return;
    ensureStyle();
    stopAnimation();

    // The read-so-far wash was dropped deliberately: over a dark page it tinted
    // half the article olive, and the popup's scrubber already shows progress.
    const current = rangeFor(chunk.start, chunk.end);
    paint("vox-current", current, 1);
    anim.range = null;
    hideMarker();

    aimAt(current);
  }

  // Word boundaries inside a chunk, in the same order the engine phonemised
  // them, so timing index i lines up with word i.
  function wordRanges(chunk) {
    const text = INDEX.text;
    const out = [];
    let i = chunk.start;
    while (i < chunk.end) {
      while (i < chunk.end && /\s/.test(text[i])) i++;
      if (i >= chunk.end) break;
      const from = i;
      while (i < chunk.end && !/\s/.test(text[i])) i++;
      out.push([from, i]);
    }
    return out;
  }

  // Kokoro normalises text before phonemising ("$5" becomes "five dollars"),
  // so word counts can drift. When they do, fall back to spreading the clip
  // across the words by length — the highlight still tracks, just less exactly.
  function alignTimes(ranges, times, duration) {
    if (times && times.length === ranges.length) return times;
    if (!ranges.length || !duration) return null;
    const weights = ranges.map(([a, b]) => b - a + 1);
    const total = weights.reduce((x, y) => x + y, 0);
    let at = 0;
    return ranges.map((_, i) => {
      const span = [at, at + (duration * weights[i]) / total];
      at = span[1];
      return span;
    });
  }

  function speakChunk({ index, words, duration, paused }) {
    if (!supportsHighlight) return;
    const chunk = INDEX.chunks[index];
    if (!chunk) return;
    ensureStyle();
    stopAnimation();

    const ranges = wordRanges(chunk);
    const times = alignTimes(ranges, words, duration);
    if (!times) return;

    anim.ranges = ranges;
    anim.times = times;
    anim.startedAt = performance.now();
    anim.pausedAt = paused ? anim.startedAt : 0;
    anim.at = -1;
    anim.active = true;
    run();
  }

  function pauseAnimation() {
    if (!anim.pausedAt) anim.pausedAt = performance.now();
  }

  function resumeAnimation() {
    if (!anim.pausedAt || !anim.times.length) return;
    anim.startedAt += performance.now() - anim.pausedAt;
    anim.pausedAt = 0;
    anim.active = true;
    run();
  }

  function clearHighlight() {
    stopAnimation();
    follow.range = null;
    follow.engaged = false;
    hideMarker();
    if (marker.el) { marker.el.remove(); marker.el = null; }
    if (!supportsHighlight) return;
    CSS.highlights.delete("vox-current");
  }

  /* --------------------------------------------------------------- anchor */

  // Turn the recorded right-click point into a sentence index.
  function pointToNode(x, y) {
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos && pos.offsetNode) return { node: pos.offsetNode, offset: pos.offset };
    }
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y);
      if (range) return { node: range.startContainer, offset: range.startOffset };
    }
    const el = document.elementFromPoint(x, y);
    return el ? { node: el, offset: 0 } : null;
  }

  function offsetForNode(node, offset) {
    for (const entry of INDEX.nodes) {
      if (entry.node === node) {
        const local = Math.min(Math.max(offset - entry.nodeStart, 0), entry.end - entry.start);
        return entry.start + local;
      }
    }
    // Clicked something that isn't spoken (a heading's padding, an image, a
    // skipped block). Start at the first spoken text after that point instead.
    for (const entry of INDEX.nodes) {
      const rel = node.compareDocumentPosition(entry.node);
      if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return entry.start;
    }
    return null;
  }

  function chunkContaining(offset) {
    const chunks = INDEX.chunks;
    for (let i = 0; i < chunks.length; i++) if (offset < chunks[i].end) return i;
    return Math.max(0, chunks.length - 1);
  }

  function anchorIndex() {
    const anchor = window.__VOX_ANCHOR__;
    if (!anchor || Date.now() - anchor.at > 30000) return { index: 0, found: false };
    const hit = pointToNode(anchor.x, anchor.y);
    if (!hit) return { index: 0, found: false };
    const offset = offsetForNode(hit.node, hit.offset);
    return { index: offset == null ? 0 : chunkContaining(offset), found: true };
  }

  /* -------------------------------------------------------------- extract */

  function extract(options = {}) {
    const sel = window.getSelection();
    // "Start reading from here" always means the whole article from that point,
    // so an incidental selection must not shrink it down to a few words.
    const hasSelection = !options.anchor
      && sel && !sel.isCollapsed && sel.toString().trim().length > 1;

    let source = "selection";
    let result;
    if (hasSelection) {
      const range = sel.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const root = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
      result = collect([root], range);
    } else {
      source = "page";
      const root = pickRoot();
      // Article containers usually start below the headline. A read-aloud that
      // skips the headline sounds like it started mid-thought.
      const heading = document.querySelector("h1");
      const roots = heading
        && !root.contains(heading)
        && heading.textContent.trim().length > 2
        && isVisible(heading)
        ? [heading, root]
        : [root];
      result = collect(roots, null);
    }

    // Only same-length substitutions are allowed here: result.nodes holds
    // offsets into this exact string, so collapsing runs of whitespace would
    // shift every highlight off the words it is meant to cover.
    const text = result.text.replace(/\u00a0/g, " ");
    INDEX = { text, nodes: result.nodes, chunks: buildChunks(text, result.headings || []) };

    const speakers = markStructure(INDEX.chunks, result.headings || []);

    const anchor = options.anchor ? anchorIndex() : { index: 0, found: false };

    return {
      source: options.anchor ? "point" : source,
      title: document.title || location.hostname,
      startIndex: anchor.index,
      anchorFound: anchor.found,
      speakers,
      chunks: INDEX.chunks.map(({ i, text, speaker, heading }) => ({ i, text, speaker, heading })),
    };
  }

  /* -------------------------------------------------------------- routing */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.to !== "content") return false;
    switch (msg.type) {
      case "PING":
        sendResponse({ ok: true });
        return false;
      case "EXTRACT":
        try {
          sendResponse({ ok: true, data: extract({ anchor: msg.anchor }) });
        } catch (err) {
          sendResponse({ ok: false, error: String(err && err.message || err) });
        }
        return false;
      case "HIGHLIGHT":
        highlight(msg.index);
        return false;
      case "SPEAK_CHUNK":
        speakChunk(msg);
        return false;
      case "PAUSE":
        pauseAnimation();
        return false;
      case "RESUME":
        resumeAnimation();
        return false;
      case "CLEAR":
        clearHighlight();
        return false;
      default:
        return false;
    }
  });

  window.addEventListener("pagehide", clearHighlight);

  // Test hook: the splitting logic is pure and worth exercising outside Chrome.
  if (typeof globalThis.__VOX_TEST_HOOK__ === "function") {
    globalThis.__VOX_TEST_HOOK__({
      isSentenceEnd, rawSentences, buildChunks, extract, highlight, rangeFor,
      wordRanges, alignTimes, speakChunk,
      pauseAnimation, resumeAnimation, anchorIndex, chunkContaining, offsetForNode,
      follow, followStep, topInset, scrollerFor, noteUserScroll,
      marker, placeMarker, pageIsDark, ensureStyle,
      __word: () => (anim.range ? anim.range.toString() : null),
      speakerOf, detectSpeakers, markStructure,
      index: () => INDEX,
    });
  }
})();
