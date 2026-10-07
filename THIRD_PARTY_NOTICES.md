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

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
