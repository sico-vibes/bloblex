# FIX39 P2 implementation report

> **What this is:** Implementation report for FIX39 package P2 (readable activity and shape validation).
> **Status:** historical
> **Last updated:** 2026-10-18

Scope: item 17 (readable activity) and the Rust validation half of item 4. Worktree: `C:/fx82`. Cargo target: `C:/fxt/c2`. No commit was made in this worktree.

## Item 17 — readable activity

- `crates/bloblex-agent-core/src/lib.rs:28`: added presentation-only `tool_activity`, with category, verb, target and a bounded label. It handles Claude tool arguments, Codex commands/search actions, and ACP raw input/locations. Commands use the first line, capped at 80 characters plus an ellipsis. Fetch labels show the host. Useful provider titles survive when structured targets are absent. Permission classification is separate and unchanged.
- `crates/bloblex-adapter-claude/src/lib.rs:570`, `crates/bloblex-adapter-codex/src/lib.rs:932`, `crates/bloblex-adapter-acp/src/lib.rs:917`: normalize new activity titles while retaining original provider payloads for local detail extraction. Codex MCP/dynamic-tool naming remains intact.
- `crates/bloblex-storage/src/lib.rs:5240`: extract `pattern`, `url`, and a short command `label`; accept target/query/command fields from `input`, `arguments`, and `rawInput`. The existing `path` field also accepts `filePath`. Original command detail retains the existing 4,000-character safety bound, and start/completion merging retains the new label. No schema migration.
- `apps/desktop/src/ui/conversation.ts:19`, `apps/desktop/src/ui/ActivityDetails.tsx:39`: derive readable titles from old stored input JSON, direct detail fields and existing titles. Clipped/unparseable JSON falls back to a stored path or an honest generic label. File reads and edits have separate categories. Glob/Grep appear under Searches when expanded, while remaining in the existing collapsed summary's tool count, so they are not described as web searches.
- `apps/desktop/src/ui/ActivityDetails.tsx:147`: expanded activity uses Commands, Files, Searches, Edits, Other, in that order, with original order preserved inside each group. Empty groups are omitted. Conversation and companion share these groups. Commands, input, output and diffs are rendered only after expanding an individual step. Existing skill/team tool labels remain.
- `apps/desktop/src/ui/ActivityDetails.css:1`: minimal heading styles using existing semantic color/type tokens.

### Evidence

Failing-first checks were run before the corresponding implementation:

- New mounted UI suite: all 3 tests failed on old code (bare Glob title, Read classified as tool, missing headings).
- New storage suite: both tests failed on old code (missing pattern, rejected circle).
- New provider tests: Claude, Codex and ACP each failed on old code (bare/raw titles).
- Core helper test initially failed to compile because `tool_activity` did not yet exist.

Tests:

- `crates/bloblex-agent-core/src/lib.rs:1283`: Claude Bash/Glob/Grep/Read/Edit, Codex command/web search, ACP read/execute, fetch host, bounded labels and provider-title fallback.
- Adapter `activity_titles_*` tests: verify provider event mapping and raw-input preservation; Codex's existing notification assertions and `crates/bloblex-adapter-codex/tests/app_server.rs:194` were updated for the normalized titles.
- `crates/bloblex-storage/src/lib.rs:6493`: existing bounded-detail/start-completion test now asserts the command label survives completion.
- `crates/bloblex-storage/src/lib.rs:7542`: new extraction test covers pattern/path, URL, retained multiline command, short label, ACP `filePath`.
- `apps/desktop/src/ui/ActivityDetails.mounted.test.tsx:14`: old JSON input, malformed/clipped JSON, stored paths, fetch host, categories, collapsed summary, three group headings, and full multiline command absent until step expansion.
- `apps/desktop/src/ui/sessionActions.mounted.test.tsx:61`: existing expanded-activity regression now expects the readable labels and group order; command output, exit code and teammate result checks are retained.
- `apps/desktop/src/remote/fixtures/policy-goldens.json:1060` and `:1587`: four shared result/snapshot cases prove `label`, `pattern`, `url`, `path`, and `command` disappear by default and return only with `includeToolOutput`. Both Rust and TypeScript consume the same fixtures. No production Remote policy change, method, event or tier row was needed. (Corrected in the follow-up: the first version covered `tools[].detail` only, not `tools[].title`, so the title still carried command/path/pattern/URL text over Remote. See **Follow-up (audit)** F1.)

## Item 4 — daemon shape acceptance

`crates/bloblex-storage/src/lib.rs:5184` accepts `circle`, `pebble`, and `squircle` alongside all ten legacy names. Validation of the other look fields is unchanged. `fix39_activity_tests::valid_look_accepts_new_and_legacy_shapes` checks all thirteen names and rejects an unknown name. The P4 chooser/migration is outside P2.

## Gates

All gates pass in this worktree. The Rust gates and `npx tsc -b` were run by the first implementer (the work was carried on after a usage limit), and the takeover run re-ran and confirmed the full UI suite and both production builds.

- Rust workspace tests (`RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`): **734 passed, 0 failed**. `TEMP`/`TMP` set to `C:/fxt/c2/tmp`.
- Rust clippy (`cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`): clean.
- UI typecheck (`npx tsc -b`): passed.
- UI suite (`npx vitest run --maxWorkers=3`): **165 files, 1,164 tests, all passed** (re-run by the takeover to confirm the final tree).
- Production build (`npm run build`): passed (vite build, 1,857 modules, 15.35 s).
- Remote build (`npm run build:remote`): passed (vite build, 1,635 modules, 7.88 s). Run because the shared Remote golden fixture `policy-goldens.json` was changed; no production Remote source was touched.

Run notes from the first implementer:

The first workspace run caught an old raw-title expectation in the Codex fake-peer integration test (corrected above). It also failed the two daemon tests that intentionally create non-repository folders: placing `TEMP` inside this Git worktree let Git discover its parent repository. The final run uses `C:/fxt/c2/tmp`, outside the worktree and within the authorized target directory. No unrelated daemon source was changed for these environment failures.

The first full UI run had 1,163 passes and one old flat-order/raw-title expectation in `sessionActions.mounted.test.tsx`. That test was updated for the intended grouping and labels, and the full suite was rerun: 1,164 passes, 0 failures. The takeover run reproduced that result with no further changes to P2's files.

### Who did what

The first implementer wrote all P2 production code, tests and the shared Remote fixtures, and ran the Rust gates and `npx tsc -b`. The takeover ran the UI suite and both builds to completion, confirmed no failing test, made no further code change, and completed this Gates section. This matches the takeover instruction ("Sol finished the code and the Rust gates … run the UI gates … and complete the Gates section"); no P2 file was edited by the takeover beyond this report.

## Limits and scope notes

- No browser screenshots, native-window check, installed-app check, live-provider run or real-phone/tailnet run was performed. Director visual review is still needed for expanded activity in both themes and both looks. A mounted DOM test proves behavior, not visual acceptance.
- Old inputs clipped before the target was stored cannot be reconstructed. The UI uses any stored path/query and otherwise shows a generic label. Long commands retain the pre-existing storage safety bound; this change does not recover previously discarded text.
- Additional production file outside the package's explicit list: new `apps/desktop/src/ui/ActivityDetails.css`, needed to style the new group headings without touching P1's shared stylesheets. New UI tests and shared Remote golden fixtures are within the package's allowed tests.
- Dependency junctions were replaced locally with directories of package junctions and local `.bin` copies, keeping Vite/Vitest cache writes inside this worktree. Dependency sources were not modified. Final Rust test temporary files use `C:/fxt/c2/tmp`, npm cache uses `C:/fx82/target/npm-cache`, and Rust artifacts use only `C:/fxt/c2`.
- The user's installed Bitbots and its data were not accessed. No process outside the test/build processes started by this work was ended.

## Follow-up (audit)

Takeover implementation of every finding in `docs/history/fix-39/p2-audit.md`. F1 (security) first, then F2–F6. No commit was made.

### F1 — `tools[].title` no longer carries command, path, pattern or URL text over Remote (security)

- `crates/bloblex-daemon/src/remote/policy.rs:421`: added `FieldPolicy::ToolTitle` (the `GENERIC_TOOL_TITLE` constant is at `:427`). `field_policy` maps `title` to it only when the value sits in a `tools[]` item (`:461`); `redact_node` (`:526`) replaces a string title with `"Tool"` unless `include_tool_output` is set, in which case the real title is restored. Non-string titles pass through the normal walk.
- `apps/desktop/src/remote/remoteTiers.ts:332`: the TypeScript twin — `toolTitle` policy and `GENERIC_TOOL_TITLE` (`:335`), `case 'title'` in `fieldPolicy` (`:371`), and the matching branch in `redactNode` (`:415`). The policy table comment was updated (`:259`).
- `apps/desktop/src/remote/fixtures/policy-goldens.json`: the four `fix39-activity-fields-*` cases now carry a `title` of `Ran cargo test C:/private`. The hidden cases expect `"title": "Tool"`; the `includeToolOutput` cases expect the real title back. Both the Rust `goldens_results`/`goldens_snapshots` tests and the TypeScript `policyGoldens.test.ts` run these, so this is the failing-first test for F1 (it fails on the pre-follow-up policy, which passed the title through unchanged).
- Remote client: `RemoteApp.tsx` and `useRemote.ts` never render `tools[].title` (they show `session.title` and the content-free `remote.activity.list`), so no client change was needed.

### F2 — companion activity list stays flat

- `apps/desktop/src/ui/ActivityDetails.tsx:160`: `GroupedSteps` takes a `flat` prop and puts `flat` on the inner `<ol>`; `ActivitySteps` (`:172`) passes it. The `shell.css` `.activity-steps.flat` rule is used again instead of dead.
- `apps/desktop/src/ui/ActivityDetails.css:11`: `:root[data-bitbots="on"] .activity-steps.flat { border: 0; }` clears the Bitbots dotted left border that out-specified the shell rule. Kept in this package's own stylesheet so `bitbots.css` (P1) is untouched.
- Test: `ActivityDetails.mounted.test.tsx` — "lays the companion activity list flat" asserts the companion `<ol>` keeps the `flat` class.

### F3 — long paths keep the file name

- `apps/desktop/src/ui/ActivityDetails.tsx:33`: `shorten` gained a `head`/`tail` mode; `shortPath` shortens paths from the left (leading `…`). Used for `Read`/`Listed` (`:69`), `Edited` (`:65`) and the path in "pattern in path" (`:75`).
- `crates/bloblex-agent-core/src/lib.rs:81`: same split into `head` and `tail`; the search label is built from the pieces so the pattern keeps its head and the path keeps its tail (`:104`).
- Test: `agent-core` `audit_followups_keep_paths_identity_and_file_counts` (a >80-char path ends in `file.ts`; `Searched needle in …file.ts`); mounted test "keeps the file name for long paths".

### F4 — a `command` argument no longer forces the command category

- `apps/desktop/src/ui/conversation.ts:136`: the recognised kinds are checked before the argument; the `command` argument only decides when the tool/kind has no identity (`dynamic`, `:140`).
- `crates/bloblex-agent-core/src/lib.rs:49`: same order; `command.is_some() && !has_identity` is the last fallback before `tool` (`:76`).
- `crates/bloblex-storage/src/lib.rs:5251`: the `Ran …` `label` is only written for a shell kind, so a non-shell tool's stored label cannot leak back through the UI's tool branch.
- Tests: `agent-core` (`mcpToolCall` with a `command` argument stays `tool`), mounted test "does not call a non-shell tool a command just because it takes one", storage `audit_followups_label_only_commands_and_count_files`.

### F5 — multi-file `fileChange` names the count

- `crates/bloblex-storage/src/lib.rs:5274`: `tool_detail` records `fileCount` when `changes` has more than one entry.
- `crates/bloblex-agent-core/src/lib.rs:60`: the edit label becomes `Edited N files` for a multi-file change.
- `apps/desktop/src/ui/ActivityDetails.tsx:63`: the `Edited` branch shows `Edited N files` when `fileCount > 1`.
- Test: `agent-core` case, mounted test, and storage `audit_followups_label_only_commands_and_count_files`.

### F6 — cosmetic

- Moved `use super::*;` to the top of the tests module in `adapter-claude/src/lib.rs`, `adapter-acp/src/lib.rs` and `adapter-codex/src/lib.rs`.
- `crates/bloblex-storage/src/lib.rs:5256`: an empty first command line writes no `label`.
- `apps/desktop/src/ui/conversation.ts:15` and `crates/bloblex-agent-core/src/lib.rs:57`: added `NotebookRead` (no underscore) to the read kinds.

### Gates (re-run after the follow-up)

- Rust workspace tests (`RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`, `TEMP`/`TMP=C:/fxt/c2/tmp`): **736 passed, 0 failed** (the 734 from the first pass plus the two new Rust tests). The policy goldens run inside `bloblex-daemon` and pass with the new `title` expectations.
- Rust clippy (`cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`): clean.
- UI typecheck (`npx tsc -b`): passed.
- UI suite (`npx vitest run --maxWorkers=3`): **165 files, 1,167 tests, all passed** (1,164 + the three new mounted tests).
- Production build (`npm run build`) and Remote build (`npm run build:remote`): both passed.

### Who did what

The first implementer wrote all original P2 production code, tests and shared Remote fixtures, and ran the Rust gates and `npx tsc -b`. A takeover run finished the UI gates and builds and wrote the first Gates section. This second takeover applied every audit finding F1–F6 in `docs/history/fix-39/p2-audit.md`, added the tests above, re-ran every gate, and wrote this section. No P2 file was reverted; the working tree builds on what was already correct.

### Limits (follow-up)

- The visual fixes (companion flat list in both looks and both themes, the long-path labels on a real screen) still need the Director's visual review; the mounted DOM tests prove behaviour, not appearance.
- Remote is still unverified against a live device: F1's proof is the shared golden + parity tests, not a real phone.

