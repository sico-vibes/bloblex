# Composer controls — 7 October 2026

Status: source implementation and browser-fixture verification complete. Native and live-provider verification remain open.

## Scope

- Separate session model and effort controls. Model changes require an explicit continuity/performance warning; effort changes use the selected model's advertised levels.
- Claude-style pixel field and spring motion, Codex-style gradient/particles and snapping, and a neutral presentation for other model families. Provider defaults remain distinct from explicit effort choices.
- A compact context ring with used-token and capacity details. Missing or invalid fields stay unknown; percentages require both fields. Account quota is separate.
- A conversation outline with real prompt/reply previews, scroll tracking, pointer navigation, and keyboard navigation.
- Shared hold-to-confirm deletion for conversations and custom launcher profiles. A completed hold arms the action; release submits it. The success panel waits for the request to resolve, failures allow retry, and Done dismisses the panel.

## Backend corrections

The session-creation path previously passed an agent record with `id` to a helper expecting `agentId`, so the initial provider launch could ignore the blob's configured options. The corrected path passes the session-shaped lookup and captures model/effort in the session lock.

Model/effort updates accept `completed` as a between-turn state. Session gates and a prompt-admission lock comparison prevent a turn from using an outdated selection. Resume installation also compares the finalized lock before accepting a provider handle.

Changing the model resets persisted context before constructing the RPC response or emitting the updated session snapshot. Fresh provider contexts, including resume-expiry fallback, reset old context fields. Resuming the same provider context preserves them.

## Evidence and limits

- Independent OpenCode reviews checked the backend diff and regression-test bodies, then compared the final motion helpers/renderers/morph code with the pinned reference sources. The final verdict identifies original equations and engine mechanics, with declared integration differences. Source review is not a live-provider result.
- The Director's backend gate passed: `cargo test --workspace --exclude bloblex-desktop --offline`, using a short output directory and `BLOBLEX_RUN_PROVIDER_SMOKE=0`. This includes in-memory and fake-process coverage. The registered installed-provider smoke returns without running when that flag is disabled; its aggregate test result is not live-provider evidence.
- The Director independently ran desktop typecheck, the production build, and all 361 Vitest tests across 63 files; they passed. Older tests that queried an exact dropdown label were updated to recognize the label plus selected value, without changing the production dropdown or loosening behavioral assertions.
- The backend suite reported 238 aggregate registered passes. One is the installed-provider smoke registration returning without execution because its opt-in flag is disabled; it is not live evidence. The unchanged native desktop Rust crate was excluded from this gate.
- Browser inspection uses the fixture bridge, never the user's database. Final captures verify Codex keyboard End/Home saves, the model warning/confirmed Claude model switch, Claude/Codex meters in light/dark themes, static reduced-motion rendering, and the 1,000 px native minimum with the inspector open. A complete keyboard hold/release reached the actual fixture deletion result, awaited the shared-element morph, and dismissed with Done. Context and paired outline previews were inspected earlier in the same bounded review. A 760 px preview clips because the existing shell has a minimum width, so that unsupported width is not native acceptance evidence.
- The preview bridge now mirrors session lock changes, confirmation, busy rejection, and context reset. Fixture values are sample data and do not establish installed model capabilities or actual context usage.
- Native-window behavior, installed builds, and real CLI turns remain unverified for this follow-up. No release or signing claim is made.

The mechanical design detector reported four layout-animation warnings. They were reviewed: width transitions belong to the existing inspector, the reference-derived meter fill, and the short hold progress. They were retained for the requested behavior; this review did not redesign unrelated layout. The preview console's favicon 404 is a preview artifact; no additional console errors were observed during the final flow.

## Source-port boundaries

The initial implementation was a React adaptation, not an exact copy. After the user's fidelity question, the approximate effects were replaced with source-derived Claude magnet/spring/pixel/label logic, Codex geometry/snap/palette/particles/burst logic, outline tick/card springs and timers, and the dialog's effective 300/150/80 ms shared-element geometry transition. Equations and deterministic vectors are tested in `meterMotion.test.ts`; mounted tests cover lifecycle and the actual application contract.

This remains an application-specific port, not a verbatim clone: provider metadata supplies dynamic stops and real labels; the compact knob is 32 px; Bloblex supplies theme/content; pointer cancellation aborts, provider updates commit once on release, and celebrations wait for a successful update. A delivered delete RPC is not cancelable, so dismissal is guarded while it is pending. These differences are intentional and should not be described as literal parity with every demo behavior.

Provider defaults can be pinned to a concrete model/effort only when validated metadata reports them. Otherwise explicit null remains the provider-default choice, without guessing an actual model identity. Older sessions without a lock pin daemon-resolved options when resumed.

## Release verification

The source is committed as `146db44`, versioned in `4aa48f4`, pushed to `main`, and published as manual-only `v0.1.0-beta.10`. A separate short-path checkout (`D:\b10`) passed all 361 frontend tests, the production build, full offline Rust workspace tests with installed-provider smoke disabled, and the unsigned NSIS bundle. The installer is 7,383,216 bytes and GitHub's uploaded SHA-256 matches `f418d1799f2aa3200d992500cf74a1f02b076731588782c40936c114d02727fc`. The signed `channel-beta` tag/feed is unchanged. This packaging pass does not establish native UI, live-provider, or clean-machine install acceptance.

## Reference artifacts

The reference components are recorded with their commit provenance and MIT notices in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). Browser artifacts are in the local, untracked `output/playwright/composer-20261007/` directory.
