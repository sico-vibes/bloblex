# FIX39 P4 audit (Claude Sonnet 5.5)

> **What this is:** Audit of FIX39 package P4 by Claude Sonnet 5.5.
> **Status:** historical
> **Last updated:** 2026-10-18

**Verdict: PASS WITH FIXES.** Item 4 is implemented as specified and the diff is sound. Three small fixes are listed below. None blocks the merge. Finding 1 should be fixed before the Director's visual check, because it is a user-visible control.

I read the diff and the changed code and did not re-run the gates. The report's results are plausible and nothing in the code contradicts them. The Director still runs the full gates after the merge.

## Checklist against the package

| Requirement | Result |
|---|---|
| Eight shapes in the owner's order | Done. `forms.ts:13`, `index.ts:26`, and a test of the exact list. |
| Symmetric by default, not just `body.rot` | Done. The body is built from constants (`forms.ts:176-224`, `layoutForm` at `:242`). The seed no longer reaches the outline, petals or extras. The test checks that outline, extras and petals are identical across 12 seeds and mirror-symmetric about x=50. |
| Mirrored pill eyes at rest | Done. `faceFit` (`forms.ts:225-238`) gives two equal, upright eyes mirrored about the face centre. The old `eye.lean`, `eye.scale`, `eye.stretch`, `eye.dy`, `gaze.x` and `eye.lean2` pins are ignored. The test pins them at both extremes. |
| Old stored names migrate | Done. `index.ts:45,58` maps round and sun to circle, organic and cat to pebble, boxy to squircle. `Object.hasOwn` plus a frozen map rejects `constructor` and `__proto__`, and the test covers that. Seed, traits and `bot` survive. |
| Shuffle never changes the shape | Done. `index.ts:121` keeps the shape and `bot` and drops the pins. The `anyShape` parameter and `shapeForPosition` are gone, and no caller still passes `true`. |
| Surprise me never changes the shape; changes eyes and colour | Done in classic mode. `LookEditor.tsx:57-65` picks a new swatch different from the current one, and it works when the current colour is a hex. In Bitbots mode `randomBot(shape)` keeps the resolved outline, inferred or explicit. |
| Chooser and preview gallery | Done. Four columns, with the CSS (`blobPage.css:156`, plus the mobile rule), arrow-key step and test all agreeing. The gallery uses the eight names. |
| Templates and defaults | Done. `botTemplates.ts`, `agentForm.ts`, `blobShare.ts`, `agentLook` and `MASCOT_LOOK` all use the new names. |
| Blobatar credit kept | Done. The header comment in `forms.ts` is updated and still credits blobatar. |

## Correctness

- **Atomic colour and look update.** The old two-callback pattern did lose the new eyes, because the second `onDraftChange` spread the stale draft. The optional second argument (`LookEditor.tsx:48`, `BlobSettings.tsx:240`, `FirstRunOnboarding.tsx:137`) fixes it. The parent-draft test exercises the real failure.
- **Geometry.**
  - Triangle and hexagon start at −90°, so their apex is upright and the shape is symmetric.
  - Capsule, cloud and droplet decorations are built from ±x pairs around cx=50, so the test passes.
  - `SPINNING_SHAPES` (`blobEngine.ts:67`) drops sun and renames boxy. Pebble and cloud stay "spherical", as organic and cloud were before.
- **Windows-specific.** Nothing path-related changed.
- **Persisted data.**
  - Legacy looks are migrated on every read through `normalizeLook`. The saved value is only rewritten on the next save.
  - `resolveForm` receives normalized looks. I found no remaining raw-shape consumer: `App.tsx:2665` goes through `agentLook`/`SHAPE_LABELS`.
  - Until P2 lands, saving `circle`, `pebble` or `squircle` fails in the daemon. This is the documented merge dependency, not a defect in P4.

## Findings

1. **The "Roundness" slider is inverted and nearly invisible.** `index.ts:145` labels `eye.n` "Roundness". `forms.ts:238` maps the slider position linearly to the superellipse exponent 2.6–3.0, and a higher exponent is squarer, so moving the slider right makes the eyes less round. The old label, "Squareness", was correct. The range is also so narrow that the control barely changes the picture.
   - **Fix:** rename the label back to "Squareness". If the control should actually matter, widen the range (for example 2.4–3.6) and update the `left.n <= 3` assertion in `look.test.ts` (the "keeps the complete silhouette fixed" test).

2. **The Fine-tune count includes pins no control can reset.** `LookEditor.tsx:56` computes `pinned` as every key in `look.traits`. Existing bots that pinned `eye.lean`, `eye.scale`, `body.rot`, `sun.n` and the like now show a badge such as "3" with no slider to reset. "Reset tweaks" does clear them, but the badge is confusing. Previously fewer keys were dead.
   - **Fix:** count only the keys that some visible control for the current shape reads, using `controlsFor(look.shape)`. Alternatively, leave the pins alone and say so in the report. Do not strip them in `normalizeLook`, because an existing test deliberately keeps `sun.n`.

3. **One new assertion cannot fail on the old code.** `BlobCanvas.mounted.test.tsx` (around line 250) asserts at least 3 `arc` calls for a cloud. The old cloud drew 4–6 petals, so the test passes either way. The symmetric-petal check in `look.test.ts` does cover cloud behaviour, so this is cosmetic.
   - **Fix:** assert exactly three arcs, plus the main outline if the harness allows.

## Tests

- The new `look.test.ts` cases check behaviour and would fail on the old code: fixed symmetric geometry, migration, ignored legacy pins at both extremes, robot outline preserved, Shuffle keeping shape and `bot`.
- The `LookEditor` mounted tests are behavioural. The parent-draft test and the explicit-versus-inferred outline test are the strongest.
- No test was weakened. The edits to other tests only rename shapes.

## Scope

- Everything outside the P4 file list is listed in the report and is a one-line change to a new name or to the atomic callback. `App.agent.mounted.test.tsx` is shared with P1, so keep P1's unrelated changes when merging. `bitbots.css`, Rust, `tiers.json` and the hot files (`App.tsx`, `TeamSidebar.tsx`, `main.rs`, `team.rs`, `storage/lib.rs`) are untouched.
- Dead types remain in `forms.ts` (`CatFeatures`, `glint`, `features`). The engine still reads them (`blobEngine.ts:647,736`), so leave them.

## Security and visual rules

- No daemon method, event, log or payload changed, so no `tiers.json` row is needed. No credentials or conversation text are touched.
- No sparkle or star icon was added. The editor keeps `Dices` and `Shuffle`.
- Classic and Bitbots modes both work in the editor, and the gallery takes `?style=bitbots&theme=light|dark`. This is unverified by eye (see the report), so the Director's screenshot check against the reference stays open.
