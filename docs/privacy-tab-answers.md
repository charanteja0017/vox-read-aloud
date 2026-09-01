# Privacy practices tab — answers to paste

One box at a time. Nothing here is checked; every data-type checkbox stays empty.

## Single purpose

```
Vox reads the text of a web page aloud using a neural text-to-speech model that runs locally in the user's browser. It has no other function.
```

## activeTab

```
Reads the text of the page the user has explicitly asked Vox to read. It is only ever granted when the user invokes the extension deliberately, by pressing the keyboard shortcut, clicking the toolbar icon, or choosing a Vox item from the right-click menu.
```

## scripting

```
Injects the content script that extracts the article text and draws the reading highlight that follows the voice. It is injected only into the tab the user invoked Vox on, and only at that moment.
```

## storage

```
Stores the user's chosen voice, reading speed and model, and the current sentence position so that a paused article resumes in the right place. All of it stays in local browser storage.
```

## unlimitedStorage

```
Caches the downloaded speech model and the speech audio Vox generates. The model is 88-310 MB depending on the chosen quality, and caching generated audio is what stops the extension re-running the model, and re-heating the machine, every time the user re-reads a page.
```

## offscreen

```
The speech model and audio playback run in an offscreen document. A Manifest V3 service worker cannot play audio and is evicted long before a long article finishes, so the offscreen document is the only place this work can live.
```

## contextMenus

```
Adds three right-click items: "Start reading from here", "Read selection aloud", and "Read this page from the top".
```

## Host permission

```
Downloads the Kokoro-82M text-to-speech model and its voice files from Hugging Face, once, the first time the user reads a page. These are neural network weights. No page content and no user information is ever sent in the request, and after the download the extension works entirely offline. This is the only host the extension ever contacts.
```

## Remote code (if asked)

```
All executable code, including the ONNX Runtime WebAssembly, is contained in the extension package. What is downloaded at runtime is neural network weights in ONNX format: data that the bundled runtime reads, never code that is executed. The content security policy is script-src 'self' 'wasm-unsafe-eval', which permits no remote script.
```

## Data usage

Leave every data-type checkbox UNCHECKED, then tick all three certification boxes.

## Privacy policy URL

```
https://github.com/charanteja0017/vox-read-aloud/blob/main/PRIVACY.md
```
