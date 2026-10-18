# FIX39 P4 implementation report

Package P4: item 4, TypeScript shape system, editor and preview. No Rust changes, commits, installed-app operations or live-daemon calls.

## Item 4: changes and evidence

- **Eight shapes:** `apps/desktop/src/blob/look/forms.ts:13` defines Circle, Pebble, Squircle, Capsule, Triangle, Hexagon, Cloud and Droplet, in that order. `forms.ts:181` fixes each silhouette's geometry independently of its seed, including matching cloud lobes and an upright polygon orientation. `forms.ts:242` resolves every body with rotation zero. Existing canvas shading is retained; the geometry still derives from blobatar, and its credit is retained.
- **Mirrored pill-style eyes:** `forms.ts:225` fits two equal, vertical, unrotated eyes mirrored around the face centre. Size, height, spacing, roundness and vertical placement remain tunable. Old body, lean, horizontal-gaze and asymmetry pins no longer distort the silhouette or make the resting eyes asymmetric. `apps/desktop/src/blob/look/index.ts:139` exposes only the applicable eye controls.
- **Stored-name migration:** `index.ts:45` and `index.ts:55` migrate `round` and `sun` to `circle`, `organic` and `cat` to `pebble`, and `boxy` to `squircle`. The other five old names remain canonical. Seed, valid traits and explicit robot styling survive normalization. Unknown names, including inherited object-property names, are rejected. Default agent looks use Circle (`index.ts:75`).
- **Shape-preserving Shuffle:** `index.ts:121` replaces the eye seed and drops pinned tuning, retaining both the classic shape and alternate robot styling. It also avoids reusing the immediately previous seed if the random value collides.
- **Shape-preserving Surprise me:** `apps/desktop/src/ui/LookEditor.tsx:57` gives classic looks new eye tuning and a palette colour different from the current swatch, including when that swatch was supplied as hex. In Bitbots mode it passes the currently resolved robot outline to `randomBot`, which now randomizes colours only (`apps/desktop/src/blob/look/bot.ts:119`). The new names also have robot mappings (`bot.ts:92`).
- **Atomic appearance draft:** `LookEditor.tsx:49` can send the new colour with the look in one callback. Both callers consume it in one draft update (`apps/desktop/src/ui/BlobSettings.tsx:240`, `apps/desktop/src/ui/FirstRunOnboarding.tsx:137`). Calling the old separate callbacks for one click overwrote the newly shuffled eyes with the previous draft; a failing-first mounted regression demonstrated this.
- **Chooser, defaults and gallery:** the chooser uses four columns and matching arrow-key movement (`LookEditor.tsx:127`, `apps/desktop/src/ui/blobPage.css:156`). Templates use the new names (`apps/desktop/src/ui/botTemplates.ts:34`, `:91`, `:148`). The character sheet uses the eight-name list (`apps/desktop/src/preview/main.tsx:35`), defaults explicitly to classic rendering, and accepts `?style=bitbots` and `?theme=light` (`main.tsx:12`). Draft, duplicate and legacy-import defaults use Circle. The renderer's completion-spin table recognizes Squircle.

## Tests

Failing-first evidence, before the corresponding production fixes:

- The revised `look.test.ts` initially had **9 failures**: chooser vocabulary, symmetry, migration, robot outline preservation, mascot/defaults, shuffle preservation and obsolete controls.
- The revised `LookEditor.mounted.test.tsx` initially had **5 failures**: eight-tile chooser, obsolete tilt control, classic Surprise me, and inferred/explicit robot outline preservation.
- The parent-draft regression then failed independently: after Surprise me the seed was still `original`, proving the separate appearance callbacks lost the new eyes.

Final coverage:

- `apps/desktop/src/blob/look/look.test.ts:33`: exact eight-shape vocabulary.
- `look.test.ts:37`: full outlines, extras and petals are mirror symmetric and identical across twelve seeds per shape; both eyes match, are upright and vertical. Existing sixty-seed-per-shape checks also cover face containment, clockwise winding and canvas bounds.
- `look.test.ts:64`: every legacy-name migration, preserved tuning/style, new-name acceptance and invalid-name rejection.
- `look.test.ts:74`: legacy silhouette/asymmetry pins at both extremes cannot change the resolved body or face; tunable eye extremes remain inside the face.
- `look.test.ts:91`: each explicit robot outline survives randomization, with mappings for the three new names.
- `look.test.ts:145`: Shuffle keeps every shape and alternate robot style, changes the resolved eyes and removes pinned tuning.
- `apps/desktop/src/ui/LookEditor.mounted.test.tsx:30`: chooser order, selection and four-column keyboard movement.
- `LookEditor.mounted.test.tsx:72`: Surprise me keeps the selected classic tile and emits a new colour and seed.
- `LookEditor.mounted.test.tsx:87`: a real parent draft retains both the new eyes and colour after one click.
- `LookEditor.mounted.test.tsx:107`: both inferred and explicit Bitbots outlines remain selected after Surprise me.
- Existing renderer, motion, duplicate, template and share tests were updated for canonical names; the share test still imports an old `sun` look and verifies its migrated export.

## Gates

- `npx tsc -b --pretty false`: **passed**.
- Full Vitest run, `--maxWorkers=3`: **163 files passed, 1 file failed; 1,165 tests passed, 1 timed out**. The only failure was the existing `App.agent.mounted.test.tsx` test `restores a cancelled edit and discards only after confirmation`, at its default five-second timeout (5,243 ms). All P4 tests passed, including the twelve look tests and eight editor tests.
- Isolated retry of the complete app-agent file with one worker: **passed, all 59 tests**, including the test that timed out in the parallel run. No code or timeout change was needed for the retry.
- `npm run build -- --configLoader runner`: **passed** (includes a fresh `tsc -b`; Vite built 1,856 modules). Vite reported mixed static/dynamic import and large-chunk warnings; the build exited zero.
- `git diff --check`: **passed**.
- Rust and native gates: not applicable; no Rust or native code changed. Remote build: not required by the brief; no remote-app files changed.

Full-suite logs and the validation-only config are under `.local/fix39-p4/` (ignored). The final suite uses the normal Vite config merged only with a worktree-local cache path and disabled Vitest result caching, with Vite's `runner` config loader. This avoids writing config bundles through the existing shared `node_modules` junctions. Early focused checks used the default tooling before those junctions were identified, so transient tooling caches may have been written through them; no outside source files were edited or cleaned up. Subsequent npm cache and temporary paths are also worktree-local. `CARGO_TARGET_DIR` was set to `C:/fxt/a1`; no Cargo build was needed.

## Files outside P4's explicit list

Small production changes needed by the new names or atomic appearance operation:

- `apps/desktop/src/ui/BlobSettings.tsx` and `FirstRunOnboarding.tsx`: consume colour and look atomically; one callback line each.
- `apps/desktop/src/ui/agentForm.ts`: canonical Circle defaults for new drafts and duplicates; two lines.
- `apps/desktop/src/ui/blobShare.ts`: canonical Circle default for imports without a look; one line.
- `apps/desktop/src/blob/blobEngine.ts`: rename the Boxy entry in the completion-spin table to Squircle and remove the retired Sun entry; one line.
- `apps/desktop/src/preview/fixtureBridge.ts`: replace retired shape names in two fixtures so previews use valid typed looks.

Additional existing tests updated for renamed shapes or changed API:

- `apps/desktop/src/blob/BitbotCanvas.mounted.test.tsx`
- `apps/desktop/src/blob/BlobCanvas.mounted.test.tsx` (Cloud's three lobes replace the removed Sun-petal assertion)
- `apps/desktop/src/blob/bitbots.test.ts`
- `apps/desktop/src/blob/characterMotion.test.ts` (Cloud remains a shape distinct from the Circle default for the squash check)
- `apps/desktop/src/ui/agentForm.test.ts`
- `apps/desktop/src/ui/App.agent.mounted.test.tsx` (three shape-name lines only; P1 also owns this file, so retain its unrelated changes when merging)
- `apps/desktop/src/ui/blobShare.test.ts`
- `apps/desktop/src/ui/botTemplates.test.ts`

No `bitbots.css`, Rust, policy, design or product documents were changed. This report is the only changed documentation file. No new daemon method/event was added.

## Remaining verification and merge dependency

- **Merge P2 before shipping P4.** This worktree's Rust shape validator is intentionally untouched. P2 must accept `circle`, `pebble` and `squircle`, alongside all old names, before these looks can be saved to the daemon.
- The reference at `https://grokbots.ai/studio` was fetched successfully as HTML/text. The browser tool had no available browsers (the in-app-browser open failed; browser inventory was empty), so neither the reference nor this implementation was inspected visually. No reference pictures or SVGs were supplied. Geometry follows the owner's named set and the audited design; visual equivalence is not claimed.
- The Director still needs to compare the gallery and editor with the reference in both themes and both looks. Useful gallery variants are `/preview.html?theme=dark`, `?theme=light`, and the same URLs with `&style=bitbots`; classic is the gallery default.
- No live installed Bitbots, user data, native windows, tailnet or phone were exercised. No processes were ended. Independent diff audit remains the Director's next pipeline step.

## Follow-up (P4 audit findings)

`docs/FIX39_P4_AUDIT.md` raised three fixes. All three were already present in the working tree when this session took over (the previous implementer applied them before running out of usage); I verified each against the audit, confirmed the tests, reran the full UI gates (the full suite and build had not been rerun after the fixes) and wrote this section. **I changed no production code for these findings.**

### Finding 1 — the eye slider is "Squareness" and its range is wider

- Label: `apps/desktop/src/blob/look/index.ts:145` is `{ keys: 'eye.n', label: 'Squareness' }` (the retired "Roundness" name is gone).
- Range: `apps/desktop/src/blob/look/forms.ts:238` maps the slider to `t.num('eye.n', 2.4, 3.6)`; the pre-P4 mapping was `3.5–6` and the intermediate P4 value the audit saw was `2.6–3.0`, so the control now moves the eye superellipse exponent by ~1.2 across its travel.
- Test: `apps/desktop/src/blob/look/look.test.ts:59-60` bound the resolved exponent to `>= 2.4` and `<= 3.6`, and the new `look.test.ts:65` ("makes the eyes visibly squarer across the full Squareness range") pins the endpoints at exactly `2.4` and `3.6` with a span greater than `1.19`. On the `2.6–3.0` code this test fails at `2.4`.
- UI guard: `apps/desktop/src/ui/LookEditor.mounted.test.tsx:56-57` asserts the visible label list contains `Squareness` and not `Roundness`.

### Finding 2 — the Fine-tune count reads only controls visible for the current shape

- `apps/desktop/src/ui/LookEditor.tsx:56-57` builds `visibleKeys` from `controlsFor(look.shape)` and counts `pinned` as the trait keys inside that set, instead of every key in `look.traits`.
- Test: `apps/desktop/src/ui/LookEditor.mounted.test.tsx:74` ("counts only pins read by visible controls and still lets Reset tweaks clear legacy pins"). A cloud carrying dead pins `{ eye.lean, eye.scale, body.rot, sun.n }` plus visible `{ eye.rx, eye.n }` shows `2 adjusted` (the old expression would show `6`) and two `.look-slider.pinned`; "Reset tweaks" still clears all six and re-enables. The pins are not stripped in `normalizeLook`, so `sun.n` survives in stored looks as before.

### Finding 3 — the cloud test asserts exactly three arcs

- `apps/desktop/src/blob/BlobCanvas.mounted.test.tsx:250-266` wraps `lookPaint.traceForm` and, for every shading pass over a cloud look, asserts `arcs` is exactly `3` and the main outline contributes more than `40` `lineTo` segments. The removed pre-P4 assertion counted `context.arc >= 6` for the retired sun and would have passed on any petal count; the new one fails if the cloud draws a different number of lobes.

### Gates rerun

- `cd apps/desktop && npx tsc -b` — **exit 0**, no output.
- Full UI suite, `npx vitest run --maxWorkers=3` — **164 files passed, 1,168 tests passed, exit 0**. No timeout this run; the `App.agent.mounted.test.tsx` test that timed out at five seconds in the first full run passed here.
- Focused run of the three affected files (`look.test.ts`, `BlobCanvas.mounted.test.tsx`, `LookEditor.mounted.test.tsx`), verbose reporter — **3 files passed, 32 tests passed, exit 0**, including the three named follow-up tests above.
- `npm run build -- --configLoader runner` — **exit 0** (runs `tsc -b` then Vite; only the existing large-chunk warning).
- Rust and native gates: not applicable; no Rust or native code changed. Remote build: not required; no remote-app files changed.

The suite and build were run with a worktree-local Vitest config (`.local/fix39-p4/vitest.config.ts`: worktree-local `cacheDir`, caching disabled) and Vite's `runner` config loader, matching the first report, so nothing was written through the shared `node_modules` junction. Logs are under `.local/fix39-p4/` (ignored). `node_modules` in this worktree is a junction to the main checkout; no outside source files were edited.
