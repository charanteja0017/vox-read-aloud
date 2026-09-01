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
onnx-community. Apache-2.0 is declared on the original release and carried through both ONNX
exports, including `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped`, which is what Vox
downloads. The voice embeddings under `voices/` come from the same release and are the only
part bundled; the network weights are fetched at runtime.

Kokoro's model card lists `yl4579/StyleTTS2-LJSpeech` as a base model, and that checkpoint
declares no licence of its own. Vox relies on the licence Kokoro itself grants.

## kokoro-js — Apache-2.0

<https://github.com/hexgrad/kokoro> · tokenisation and inference wrapper.

## Transformers.js — Apache-2.0

<https://github.com/huggingface/transformers.js> · model loading and the ONNX bridge.

## ONNX Runtime Web — MIT

<https://github.com/microsoft/onnxruntime> · Copyright (c) Microsoft Corporation. Ships as
`ort/ort-wasm-simd-threaded.jsep.{mjs,wasm}` and inside the bundled worker.

## phonemizer — Apache-2.0

<https://github.com/xenova/phonemizer.js> · the wrapper around eSpeak NG noted above.

## How these fit together

Only eSpeak NG is copyleft. Apache-2.0 and MIT are both one-way compatible with the GPLv3,
so combining them into a GPL-3.0 work is exactly what those licences permit — the result is
coherent, and the obligation runs one way: the whole is GPL-3.0, while each component keeps
its own terms. Note the compatibility is with GPL **v3** specifically; Apache-2.0 is not
compatible with GPLv2, which is one reason this project is v3.

**The speech model is not what makes Vox copyleft.** It is Apache-2.0 and is downloaded
rather than bundled. The GPL comes from the phonemiser alone.

---

Full licence texts: [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0),
[MIT](https://opensource.org/licenses/MIT), and `LICENSE` in this repository for the GPL-3.0.
