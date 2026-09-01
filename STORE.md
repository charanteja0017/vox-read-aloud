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

## The two URLs the form asks for

| Field | Value |
| --- | --- |
| Homepage URL | `https://github.com/charanteja0017/vox-read-aloud` |
| Privacy policy URL | `https://github.com/charanteja0017/vox-read-aloud/blob/main/PRIVACY.md` |

The homepage doubles as the GPL's source-availability requirement, and it is also declared
as `homepage_url` in the manifest so the source is findable from the extension itself.

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

Chrome's policy is explicit that disclosure is required **even for data that never leaves the
device**: *"Extensions are required to disclose how they handle user data, even when data is
processed or stored locally on a user's device and is not transmitted to external servers or
third parties."* "Handle" is defined as *"collecting, transmitting, using, or sharing."*

So this is not a "tick nothing" listing, even though nothing is transmitted.

| Checkbox | Tick? | Why |
| --- | --- | --- |
| **Website content** | **Yes** | Vox reads the page's text to speak it, keeps the sentences in session storage to resume a paused article, and caches the generated audio locally. |
| **User activity** | **Yes** | Only with the optional right-click feature enabled, but the form's own examples list "clicks, mouse position", and that is exactly what `anchor.js` records. |
| Personally identifiable information | No | Never read or derived. |
| Health, financial, authentication | No | Form fields and inputs are skipped during extraction. |
| Personal communications | No | Vox has no special handling of mail or chat; whatever page you point it at is covered by "website content". |
| Location | No | Never requested. |
| Web history | No | No list of visited pages is built. One article title lives in session storage while it is being read, and is discarded on browser restart. |

Then tick **all three** certifications: not sold or transferred to third parties, not used
for anything unrelated to the single purpose, not used for creditworthiness or lending. All
three are true.

The disclosures must agree with the privacy policy, which is why `PRIVACY.md` describes this
handling explicitly rather than claiming none occurs.

**Privacy policy URL** — `https://github.com/charanteja0017/vox-read-aloud/blob/main/PRIVACY.md`

## Assets

| Asset | Requirement | Status |
| --- | --- | --- |
| Store icon | 128×128 PNG | in package, `icons/icon128.png` |
| Screenshots | 1280×800 or 640×400, PNG with **no alpha channel**, 1–5 | three in `docs/store/`, all verified 1280×800 8-bit RGB |
| Small promo tile | 440×280 | `docs/store/promo-small-440x280.png` |
| Marquee promo tile | 1400×560 | `docs/store/promo-marquee-1400x560.png` |
| Support URL | any public page | `…/vox-read-aloud/issues` |

## Filling the forms

Two prompts for a browser agent, if you want the typing done for you. Neither submits, and
neither touches file uploads — an agent cannot drive a file picker.

- [`docs/browser-agent-prompt.txt`](docs/browser-agent-prompt.txt) — the Store listing tab
- [`docs/browser-agent-prompt-privacy.txt`](docs/browser-agent-prompt-privacy.txt) — the
  Privacy practices tab, including every permission justification verbatim

Check the remote-code answer yourself before saving. It must be **No**, and it is the field
most likely to cause trouble if it is ever wrong.

## Pre-submission checklist

- [x] Source repository published — <https://github.com/charanteja0017/vox-read-aloud>
- [x] Privacy policy published — `PRIVACY.md` in that repository
- [ ] `npm test` and `npm run test:quality` pass
- [ ] `npm run package` produces the archive without complaint
- [ ] Loaded the unpacked archive once and confirmed it reads a page
- [ ] Publisher contact email added **and verified** on the Settings page
- [ ] Bumped `version` in `src/manifest.json` if resubmitting
