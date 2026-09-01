# Privacy policy — Vox: Natural Read Aloud

_Last updated: 1 September 2026_

**Vox does not collect, store, transmit, sell or share any user data.**

There is no account, no analytics, no telemetry, no advertising, and no server belonging to
this extension. Nothing you read is sent anywhere.

## What Vox does with the pages you read

When you ask Vox to read a page — by keyboard shortcut, toolbar button or right-click menu —
it reads the text of that page into memory, turns it into speech on your own machine, and
plays it back. The text and the generated audio are held in your browser's local storage so
that re-reading a page does not have to repeat the work.

That data never leaves your computer. It is not readable by us or by anyone else, and
removing the extension removes it.

## The one network request Vox makes

The first time you use it, Vox downloads the Kokoro-82M speech model from Hugging Face
(`huggingface.co` and its content delivery hosts). This is a one-time download of model
weights. It sends no information about you, and no page content is included in the request.
After it completes, Vox works entirely offline.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab`, `scripting` | To read the text of the page you explicitly asked Vox to read, and to draw the reading highlight on it. |
| `storage`, `unlimitedStorage` | To remember your voice, speed and reading position, and to cache the downloaded model and generated audio locally. |
| `offscreen` | The speech model and audio playback run in an offscreen document, because a Manifest V3 service worker cannot play audio. |
| `contextMenus` | To add the right-click reading options. |
| Host access to Hugging Face | To download the speech model once, as described above. |
| Optional access to all sites | **Off by default.** Only requested if you switch on "Right-click → start reading from here", which needs to know where you right-clicked. It records one pair of screen coordinates and nothing else. |

## Children

Vox collects no data from anyone, including children.

## Changes

Any change to this policy will be published in this file, and its history is visible in the
repository.

## Contact

Open an issue in the source repository.
