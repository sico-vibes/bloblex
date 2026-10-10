# Third-party notices

The effort meter, message outline and hold-to-complete dialog port selected interaction and animation mechanics from the following MIT-licensed reference projects into independent React and CSS components. No reference component files, demo copy, assets, fixed demo tiers or provider branding are included. Bloblex supplies the actual runtime catalog, tier count, labels, theme and asynchronous delete result.

Reference provenance (source checkouts reviewed on 7 October 2026):

- [claude-model-selector](https://github.com/zanwei/claude-model-selector/tree/0195947c904a64b54ed2d406e10c54fa4381c3cb) — `0195947c904a64b54ed2d406e10c54fa4381c3cb`
- [chatgpt-model-selector](https://github.com/zanwei/chatgpt-model-selector/tree/134a9ec932b54de52f2923942d2893a8f753ec6a) — `134a9ec932b54de52f2923942d2893a8f753ec6a`
- [table-of-content-component](https://github.com/zanwei/table-of-content-component/tree/584b4bec9abfa25db738e53cb061677366a2f38b) — `584b4bec9abfa25db738e53cb061677366a2f38b`
- [dialog-web-component](https://github.com/zanwei/dialog-web-component/tree/27ed33a7e41fbb29306d7fdf2280b7453ec8982d) — `27ed33a7e41fbb29306d7fdf2280b7453ec8982d`

## Claude model selector and ChatGPT model selector

Copyright (c) 2026 Zanwei Guo

## Table of Content component

Copyright (c) 2026 Table of Content contributors

## Shared Element Transition Dialog Web Component

Copyright (c) 2026 Shared Element Transition Dialog contributors

## Adapted source mechanisms

- `claude-model-selector.js`: `_applyMagnet`, `_snapToNearest`, `_springTo`, `_setValue`, `_swapLabel`, `_setUltra`, `_resizeCanvas`, `_ensureCanvasLoop` and `_drawPixelField` are represented in `meterMotion.ts`, `SessionExecutionControls.tsx` and `SessionEffortMeter.tsx`. The original magnetic drag, sampled velocity spring and pixel-field reveal/flow constants and equations are retained; catalog values supply the dynamic stops.
- `chatgpt-model-selector.js`: `#metrics`, `#positionKnob`, `#stopSnap`, `#dragTo`, `#renderState`, `#sizeCanvas`, `#seedParticles`, `#drawSparkles`, `#fireConfetti` and `#confettiTick` are represented in `meterMotion.ts`, `SessionExecutionControls.tsx`, `SessionEffortMeter.tsx` and `shell.css`. The fixed five demo tiers and brand-specific presentation are omitted.
- The Codex meter adapts the reference solid blue and final gradient colors across the runtime's advertised effort stops. This normalized color interpolation is Bloblex presentation behavior; it does not define or infer provider capabilities.
- `table-of-content-model.js` and `table-of-content.js`: `tickInfluence`, `stepSpring`, `_updateMagnification`, `_animate` and `_renderTickFrame` are represented in `meterMotion.ts` and `ConversationOutline.tsx`. The rail samples long conversations for display while preserving the full selectable message range.
- `delete-confirm-dialog.js`: `_startSuccessMorph`, `_startMatchedGeometry` and the geometry-pair capture/animation flow are represented in `BlobPage.tsx` with Web Animations API FLIP. Bloblex waits for its real asynchronous delete result; pending RPC cancellation is unavailable, so the dialog prevents dismissal until it resolves.

## On-device dictation

The dictation engine in `crates/bloblex-speech` and `apps/desktop/src-tauri/src/speech.rs` is an independent Rust implementation. It reuses the *approach* and the pinned model metadata (file names, sizes and SHA-256 hashes) of the MIT-licensed reference project [stablyai/orca](https://github.com/stablyai/orca) (`src/main/speech/model-download-catalog.ts`), and does not include that project's Node/Electron source.

- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) — Apache-2.0. Native speech inference (offline and streaming ASR).
- [sherpa-onnx Rust bindings](https://crates.io/crates/sherpa-onnx) — Apache-2.0.
- [cpal](https://github.com/RustAudio/cpal) — Apache-2.0.

### Model weights

Speech model weights are downloaded at runtime from Hugging Face at pinned revisions and are **not** distributed with Bloblex. Each model carries its own license; verify before commercial use. The default model, NVIDIA Parakeet TDT 0.6B, is distributed under CC-BY-4.0 and requires attribution.

## Blob looks (blobatar)

Copyright (c) 2026 Alain

Blob silhouettes and faces are adapted from the MIT-licensed [blobatar](https://github.com/Alain00/blobatar/tree/a7fd546ebede49d0a9fa638945b9e534489782a2) (`a7fd546ebede49d0a9fa638945b9e534489782a2`, reviewed on 10 October 2026). `apps/desktop/src/blob/look/seed.ts` ports `src/hash.ts` and `src/traits.ts`, and `apps/desktop/src/blob/look/forms.ts` ports the primitives in `src/shape.ts`, nine of the ten silhouettes in `src/styles/shapes.ts` (`nub` is not used), the eye fitting in `src/styles/compose.ts` and the seed bands in `src/styles/blob.ts`. The trait keys, ranges and silhouette parameters are kept as published. Bloblex samples the outlines into canvas point lists instead of SVG path strings, centres the body, and draws and animates the figure with its own engine (states, blinking, gaze, roll, squash and the mailbox morph). The cat silhouette, its features and its glossy eyes are Bloblex's own. blobatar's palette, motion stylesheet, expressions, framework adapters, site and assets are not included. The editor credits blobatar under the shape picker.

## Companion sounds

The moments the companion plays a sound for (peek, open, close, switching, sending, a new reply, pokes, and agent work, finish, error, approval and question) follow the desktop companion [Coucou](https://github.com/Louis-CFM/coucou) (reviewed at `dd344853dc36e1edbce098d28c4e63a4ed2433c1`). Coucou's sound files are not licensed for reuse and none are included: every Bloblex cue in `apps/desktop/src/blob/soundCues.ts` is an original tone synthesized with Web Audio oscillators.

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
