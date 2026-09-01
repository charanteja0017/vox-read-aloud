# Third-party notices

Vox bundles the following components. Their licences govern those components.

## eSpeak NG — GPL-3.0-or-later

<https://github.com/espeak-ng/espeak-ng>

Reached through the [`phonemizer`](https://github.com/xenova/phonemizer.js) package, which
embeds eSpeak NG compiled to WebAssembly together with its pronunciation data (`phondata`,
`phontab`, `en_dict`). Vox uses it to turn written text into the phonemes Kokoro speaks.

**This is why Vox as a whole is distributed under the GPL-3.0.** eSpeak NG is copyleft, and a
program that ships it is a combined work. The complete corresponding source for this
extension — every file under `src/`, plus `build.mjs` and the `tools/` test harnesses — is
published alongside it, which is what the licence requires.

## Kokoro-82M — Apache-2.0

<https://huggingface.co/hexgrad/Kokoro-82M> · model weights by hexgrad, ONNX export by
onnx-community. The voice embeddings under `voices/` are part of this release. The model
weights themselves are downloaded at runtime rather than bundled.

## kokoro-js — Apache-2.0

<https://github.com/hexgrad/kokoro> · tokenisation and inference wrapper.

## Transformers.js — Apache-2.0

<https://github.com/huggingface/transformers.js> · model loading and the ONNX bridge.

## ONNX Runtime Web — MIT

<https://github.com/microsoft/onnxruntime> · Copyright (c) Microsoft Corporation. Ships as
`ort/ort-wasm-simd-threaded.jsep.{mjs,wasm}` and inside the bundled worker.

## phonemizer — Apache-2.0

<https://github.com/xenova/phonemizer.js> · the wrapper around eSpeak NG noted above.

---

Full licence texts: [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0),
[MIT](https://opensource.org/licenses/MIT), and `LICENSE` in this repository for the GPL-3.0.
