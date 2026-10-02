# Third-party notices

## Coucou interaction and motion code

Bloblex includes MIT-licensed code from Coucou for Windows, pinned to commit `8e12bed56134d2ee7165e73f132646b143ce56e4`: vendored files under `apps/desktop/src/blob/coucou/`, and adapted ports of `windows/src/mochi/engine.ts` (`apps/desktop/src/blob/blobEngine.ts`), `windows/src/mochi/greeting.ts` (`apps/desktop/src/blob/greetingScene.ts`) and `windows/src/style.css` (`apps/desktop/src/ui/companion.css`). The adaptation boundaries are recorded in `docs/companion-motion.md`. Bloblex draws its own spherical character in its provider palette with its own name and icons. No protected Coucou/Mochi artwork, sounds or other media is included.

Copyright (c) 2026 Louis Raillé

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## OpenMausBot (design reference)

The main window layout and its "Midnight" colour tokens (sidebar roster, slim header with a model pill, centred chat column, pill composer) follow [OpenMausBot](https://github.com/milind-soni/OpenMausBot), Apache-2.0, Copyright Milind Soni. No OpenMausBot source files are included; `apps/desktop/src/ui/shell.css` is Bloblex's own stylesheet using those layout dimensions and colour values.

## Character reference

The character's proportions (capsule eyes, ring badge, spherical body, state tints) were measured from Novra's public Grok Bot case study images for personal use. No images or Rive files from that study are included.

## Multica (adapted provider-runtime and analytics logic)

Copyright 2025-2026 Index Labs (Hong Kong) Limited. Multica is licensed under the Multica License (Apache License 2.0 plus additional conditions): https://github.com/multica-ai/multica

Since 2 October 2026 Bloblex deliberately adapts hardened logic from Multica's provider runtime layer (`server/pkg/agent`) and its usage/analytics implementation, re-implemented in Rust/TypeScript. Bloblex is built in part on Multica. The adapted files carry a header naming Multica and the change made, and are listed in [docs/MULTICA_DERIVED.md](docs/MULTICA_DERIVED.md). No Multica logo, product name, copyright text or brand assets are used in Bloblex's UI.

Licence conditions that apply to this use (summarised from the Multica LICENSE; read the original): Bloblex is for the owner's personal, non-commercial use; Multica's conditions forbid offering a hosted service to third parties and embedding the covered code in a commercially distributed product, and require retained notices, a statement that the product is built on Multica with a link, and unmodified Multica branding in any UI derived from its application code. If Bloblex is ever distributed, sold or hosted, the derived parts listed in docs/MULTICA_DERIVED.md need a commercial licence from Index Labs or a rewrite.
