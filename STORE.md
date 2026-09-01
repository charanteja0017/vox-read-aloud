# Chrome Web Store submission

Everything the listing form asks for. Build the archive with `npm run package`; it lands in
`~/Downloads` and refuses to produce anything the store would reject.

---

## Before you submit — read this first

**Vox must be published under the GPL-3.0, and its source must be public.**

Vox converts text to phonemes with [eSpeak NG](https://github.com/espeak-ng/espeak-ng),
reached through the `phonemizer` package. `phonemizer` is Apache-2.0, but what it embeds —
eSpeak NG compiled to WebAssembly, plus its `phondata`, `phontab` and `en_dict` pronunciation
files — is **GPL-3.0-or-later**. Shipping it makes this extension a combined work, so:

1. `LICENSE` (GPL-3.0) and `THIRD-PARTY-NOTICES.md` ship inside the package. Done.
2. The corresponding source must be available to anyone who has the extension. Publish this
   repository and put its URL in the listing's homepage field.

The store is fine with GPL extensions; plenty are listed. But it is a real obligation, and
the only way out of it would be replacing eSpeak NG with a permissively licensed
grapheme-to-phoneme stage — a significant change that would cost pronunciation accuracy on
unusual words.

---

## Listing

**Name** — `Vox — Natural Read Aloud`

**Summary (132 max)**

> Reads any page aloud with a natural AI voice that runs entirely on your device. No cloud,
> no robotic speech.

**Category** — Accessibility (alternative: Productivity/Tools)

**Language** — English

### Description

> Vox reads web pages aloud in a voice that sounds like a person, not a phone menu.
>
> The voice is a neural text-to-speech model — Kokoro-82M — that runs entirely on your own
> machine. Nothing you read is uploaded, and after the one-time model download it works
> offline.
>
> • A moving highlight follows the voice word by word, timed from the model itself rather
>   than estimated, so your eye can run ahead or drop back in without losing the place.
> • Right-click anywhere in an article to start reading from that paragraph.
> • Dialogue and interview transcripts are read in more than one voice, with each speaker
>   cast separately, and headings are read as section breaks.
> • Every sentence is synthesised once and cached, so seeking back or reopening an article
>   later costs nothing and the laptop stays cool.
> • Twelve voices, American and British. Adjustable speed. Keyboard shortcuts for play,
>   pause, skip and stop.
> • A draggable scrubber and a clickable transcript for moving around a long piece.
>
> Vox has no account, no telemetry and no server. The only network request it ever makes is
> downloading the voice model from Hugging Face the first time you use it.

---

## Permission justifications

Copy these into the "Privacy practices" tab.

| Permission | Justification |
| --- | --- |
| `activeTab` | Reads the text of the page the user explicitly asks Vox to read, when they press the shortcut, click the toolbar icon, or use the context menu. |
| `scripting` | Injects the content script that extracts the article text and draws the reading highlight, only into the tab the user invoked Vox on. |
| `storage` | Stores the chosen voice, speed and model, and the current reading position so a paused article resumes in the right place. |
| `unlimitedStorage` | Caches the downloaded voice model (88–310 MB) and generated speech audio so that re-reading a page does no work and needs no network. |
| `offscreen` | The speech model and audio playback run in an offscreen document, because a Manifest V3 service worker cannot play audio or stay alive long enough to synthesise. |
| `contextMenus` | Adds "Start reading from here", "Read selection aloud" and "Read this page from the top" to the right-click menu. |
| `host_permissions` on `huggingface.co`, `*.huggingface.co`, `*.hf.co` | Downloads the Kokoro-82M voice model and its voice files once, from Hugging Face. No other host is contacted, and nothing is ever uploaded. |
| `optional_host_permissions` on `<all_urls>` | **Off by default.** Only requested if the user turns on "Right-click → start reading from here", which needs a small listener on the page to record where the pointer was — `chrome.contextMenus.onClicked` does not report coordinates. The listener stores one pair of viewport coordinates and nothing else. See `src/anchor.js`. |

**Single purpose**

> Vox reads the text of a web page aloud using a speech model that runs locally in the
> browser.

**Remote code** — Select **No, I am not using remote code.** Every executable file —
including the ONNX Runtime WebAssembly — is bundled in the package. What is fetched at
runtime is neural network *weights*: data consumed by the bundled runtime, never executed as
code. The CSP is `script-src 'self' 'wasm-unsafe-eval'`, which permits no remote script.

---

## Data usage disclosure

Tick **nothing**. Vox collects no data of any kind.

| Question | Answer |
| --- | --- |
| Personally identifiable information | Not collected |
| Health, financial, authentication, personal communications, location | Not collected |
| Web history / user activity | Not collected. Page text is read into memory to be spoken and cached only in the user's own browser storage. It is never transmitted. |
| Website content | Not collected in the store's sense — processed locally, never sent anywhere |

Then certify all three: data is not sold, not used for unrelated purposes, and not used to
determine creditworthiness.

**Privacy policy URL** — required by the store even when nothing is collected. A short page
stating "Vox collects, stores and transmits no user data. All speech synthesis happens on the
user's device." is enough.

---

## Assets

| Asset | Requirement | Status |
| --- | --- | --- |
| Store icon | 128×128 PNG | in package, `icons/icon128.png` |
| Screenshots | 1280×800 or 640×400, 1–5 | `docs/store/` |
| Small promo tile | 440×280 | optional |

## Pre-submission checklist

- [ ] Source repository published, URL in the listing (required by the GPL)
- [ ] Privacy policy page published, URL in the listing
- [ ] `npm test` and `npm run test:quality` pass
- [ ] `npm run package` produces the archive without complaint
- [ ] Loaded the unpacked archive once and confirmed it reads a page
- [ ] Bumped `version` in `src/manifest.json` if resubmitting
