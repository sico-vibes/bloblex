# FIX29 (WP6a): one remote policy for Rust and TypeScript — implementation report

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort.
Worktree: `C:\fx46`, branch `lane/fix29-wp6a`, `CARGO_TARGET_DIR=C:/fxtarget`.
Spec: `docs/FIX29_WP6A_POLICY_SPEC.md`. No `git commit` was run.
Date: 17 October 2026.

## 1. What changed

The remote policy data moved out of hand-written TypeScript into one JSON file, the
TypeScript module was rewritten to load it without changing behaviour, and a Rust port
was added that is proved equal to TypeScript by shared golden fixtures.

| File | State | Lines | Note |
|---|---|---|---|
| `apps/desktop/src/remote/tiers.json` | new | 662 | The single source: methods, events, settings allowlist, sensitive-key pattern |
| `apps/desktop/src/remote/remoteTiers.ts` | changed | 555 | Loads and validates `tiers.json`; same exports, same behaviour |
| `apps/desktop/src/remote/fixtures/policy-goldens.json` | new | 1812 | 76 worked cases, run by Vitest and by `cargo test` |
| `apps/desktop/src/remote/policyGoldens.test.ts` | new | 105 | Runs every golden case through the TypeScript functions |
| `crates/bloblex-daemon/src/remote/mod.rs` | new | 9 | `pub mod policy;` (WP6b adds `tailscale`, `pairing`, `web`) |
| `crates/bloblex-daemon/src/remote/policy.rs` | new | 865 | The Rust port + 8 tests |
| `crates/bloblex-daemon/src/main.rs` | changed | +4 | `#[allow(dead_code)] mod remote;` |
| `crates/bloblex-daemon/Cargo.toml` | changed | +1 | `regex.workspace = true` |
| `Cargo.toml` | changed | +1 | `regex = "1"` in `[workspace.dependencies]` |
| `Cargo.lock` | changed | +1 | adds `regex` to `bloblex-daemon`'s dependency list |

Not changed: `remoteTiers.test.ts`, `remoteTiers.parity.test.ts`, `remoteContract.ts`,
`scripts/print-remote-tiers.mjs`, every UI file, every other daemon file. No listener, no
Tailscale, no pairing, no cookies, no `remote.*` RPCs, no storage tables, no PWA build.

`regex` 1.13.1 was already in `Cargo.lock` and in the build graph as a transitive
dependency of `tracing-subscriber` (`env-filter`), so adding it as a direct dependency of
the daemon fetched nothing and compiled nothing new; `cargo check --offline` succeeds.

## 2. The JSON as implemented

```json
{
  "version": 1,
  "methods": [ { "method": "app.snapshot", "class": "read", "minTier": "viewer", "why": "…", "params": null } ],
  "events": { "message.delta": "allow", "backup.imported": "drop" },
  "settingsAllowlist": [ "appearance.style" ],
  "sensitiveKeyPattern": "token|secret|password|credential|capability|api[-_]?key|private[-_]?key|authorization|bearer|cookie"
}
```

- `methods` holds all **86** rows of the old `METHOD_RULES`, in the same order, with the
  same `why` text; `minTier` is `"viewer" | "chat" | "operator" | null`; `params` is one of
  `"stagedAttachments"`, `"permissionReply"`, `"runtimeModels"` or `null`. Four rows carry a
  params rule (`runtime.models`, `session.prompt`, `session.queue.*`, `permission.reply`).
- `events` holds all **42** `EVENT_POLICY` entries (18 `allow`, 24 `drop`).
- `settingsAllowlist` holds the **8** settings keys, in the original order.
- `sensitiveKeyPattern` is the `i`-flag regex source, matched case-insensitively by both
  sides.
- The file lives under `apps/desktop/src` because `tsc -b` only allows imports inside
  `src`. TypeScript imports it; Rust reads the same bytes with
  `include_str!("../../../../apps/desktop/src/remote/tiers.json")`.

TypeScript validation runs once at import and throws on: an unsupported `version`, a
duplicate method, an unknown `class`, an unknown `minTier`, an unknown `params` id, a
non-string settings key, and an unknown event policy. `MethodRule.params` is still an
optional `ParamRule` object resolved from the id, and the exported rule objects are the
same objects as `stagedAttachmentRule` / `permissionReplyRule` / `runtimeModelsRule`, so
`expect(rule?.params).toBe(stagedAttachmentRule)` in the existing test still holds.

The Rust loader accepts exactly the same file and rejects the same mistakes
(`load_policy()` returns `Result`; the `OnceLock` initialises it with
`expect("tiers.json embedded at compile time is invalid")`). Because the file is embedded
at compile time, a parse failure is a build-time data bug caught by
`tiers_json_parses_and_every_row_is_valid`, not a runtime condition.

## 3. How the goldens were generated

A one-off `vite-node` script (kept outside the commit; deleted after use) imported the
**pre-rewrite** `remoteTiers.ts` and:

1. emitted `tiers.json` from `METHOD_RULES`, `EVENT_POLICY`, `SETTINGS_ALLOWLIST` and the
   regex source, so the data is a transcription of the old code rather than a retyping;
2. ran each hand-written input through `authorizeRemoteCall`, `redactResultForRemote`,
   `redactSnapshotForRemote` and `redactEventForRemote`, and wrote the results as
   `expect` values after a `JSON.parse(JSON.stringify(...))` round trip (so a dropped
   `undefined` is written the way the wire would carry it).

The expectations were then read by eye: the excerpts below are the policy being pinned, not
a snapshot being blessed.

- `chat-requires-tier` → `{"allowed":false,"code":"tier_required","reason":"a viewer device cannot call session.prompt"}`
- `param-permission-no-params` → `invalid_params` / `"permission.reply requires permissionId and choice"`
- `param-runtime-models-string-refresh` → allowed (`refresh === true` is strict; `"true"` is not `true`)
- `turn-error-long` → `message` cut to 200 `x`, `detail` `"C:\\Users\\sam\\deep\\proj\\file.ts failed"` → `"proj/file.ts failed"`
- `windows-paths` → `executablePath` `"codex.exe"`, `launchArgs` `{"argCount":3}`, `defaultProject` `"apps/desktop"`, `instructions` `{"hasInstructions":true}`, attachment `path` `"a.png"`
- `nested-detail-default` vs `nested-detail-with-output` → tool `detail` only returns with `includeToolOutput`; turn and file `detail` never return
- `sensitive-keys-and-env` → `capability`, `apiKey`, `api_key`, `api-key`, `privateKey`, `private_key`, `authorization`, `cookie`, `bearer_token`, `accessToken`, `credentialRef`, `password`, `clientSecret` and a nested `refreshToken` all removed; `customEnv` → `{}`; settings reduced to the allowlist
- `message-completed` → `raw` and `providerPayload` gone; `dropped-tool-changed` and `non-object-null` → `null`

Independent evidence that the rewrite did not change the policy: the docs table printed by
`renderTierTableMarkdown()` from the rewritten module is **byte-identical** to the table
printed from `HEAD`'s module (`diff` produced no output). And the pre-rewrite tests
(`remoteTiers.test.ts`, `remoteTiers.parity.test.ts`) pass unmodified.

## 4. Case counts per section

| Section | Count | Minimum in the spec |
|---|---|---|
| `authorize` | 37 | 15 |
| `results` | 15 | 10 |
| `snapshots` | 5 | 4 |
| `events` | 19 | 10 |
| **Total** | **76** | 39 |

Coverage of the required inputs:

- `authorize`: all five codes (`forbidden_remote`, `tier_required`, `approvals_disabled`,
  `quiet_hours`, `invalid_params`), quiet hours on a read (pass) and on chat/approve
  (deny), family wildcards (`exec.snapshot.*`, `usage.*`, `session.queue.*`, `session.delete.*`,
  `mcp.*`), exact-beats-family (`session.delete`), unknown methods, and each of the three
  params rules passing and failing (raw path, missing/empty `stagedId`, non-object
  attachment, missing permissionId/choice, `refresh` true/false/absent/string).
- `results`: one case per branch of `redactResultForRemote` — `app.snapshot`, `session.get`,
  `session.list`, `agent.get`, `agent.list`, `runtime.list`, `runtime.profile.list`,
  `search.messages`, `automation.get`, `memory.get` and `memory.list` (kept),
  `settings.get` (allowlist), the `read` default (`project.list`), the non-read default
  (`session.prompt`, unchanged), plus a `session.get` with `includeToolOutput: true`.
- `snapshots`: Windows paths, POSIX paths, nested `files`/`turns`/`tools` detail with and
  without `includeToolOutput`, and sensitive keys at several depths plus `customEnv` and
  `args`/`launchArgs`.
- `events`: every special-cased type (`message.completed`, `turn.error` long and short,
  `permission.requested`, `agent.changed`), allowed defaults (`message.delta`,
  `session.changed`, `usage.updated`, `daemon.health`, `turn.completed`), a nested sensitive
  key inside an allowed event, dropped types (`backup.imported`, `tool.changed`,
  `settings.changed`), an unknown type, a missing `type`, and three non-object envelopes
  (`null`, an array, a string).

## 5. Rust port notes

- `rule_for` matches an exact method first, else the longest `family.*` prefix (the prefix
  keeps the dot, matching `method.slice(0, -1)`).
- `authorize` applies the checks in the same order as `authorizeRemoteCall` and returns
  `Decision::Allowed` or `Decision::Denied { code, reason }` with the same five codes and
  the same reason strings, including `"a {tier} device cannot call {method}"` and
  `"a {tier} device cannot approve on this host"`.
- The three params checks are implemented in Rust with identical denial strings.
- `redact_snapshot`, `redact_result` and `redact_event` port the whole field policy:
  `providerSessionId` dropped; `customEnv` → `{}`; `customArgs`/`args`/`launchArgs` →
  `{argCount}`; `executablePath` → file name; `instructions` → `{hasInstructions:true}` when
  a non-empty string; `defaultProject`/`projectPath`/`files[].path`/`projects[].path` → last
  two segments; `attachments[].path` → file name; `detail` under `tools` kept only with
  `includeToolOutput`, under `turns`/`files` always dropped; top-level `settings` reduced to
  the allowlist; sensitive keys removed at every depth. `redact_event` drops
  `raw`/`providerPayload` for `message.completed`, trims `message` to 200 **characters**
  (`chars().take(200)`; the fixtures are ASCII, so this agrees with the TypeScript
  `slice`, which counts UTF-16 units) and reduces absolute paths for `turn.error`, reduces
  absolute paths for `permission.requested`, sends `agent.changed` through the agent
  policy, and returns `None` for anything not on the `allow` list. Absolute-path detection
  matches TypeScript (`/…`, `\\…`, `X:\…`, `X:/…`).
- All functions are pure; the input value is never mutated (asserted by
  `redaction_does_not_mutate_its_input`).
- Object key order: `serde_json` maps are sorted in this build (no crate enables
  `preserve_order`), so goldens are compared as `Value == Value`, never as strings.
- A missing event `payload` stays missing, mirroring the TypeScript `payload: undefined`
  that its JSON serialization drops.
- `mod remote;` in `main.rs` carries `#[allow(dead_code)]`, because nothing in the daemon
  calls the module until WP6b; the allowance is on the module declaration only.
- Rust tests added: `tiers_json_parses_and_every_row_is_valid` (parse, unique methods, valid
  class, `minTier` consistent with class, valid params id, every event classified),
  `rule_for_resolves_exact_then_longest_family`, `quiet_hours_only_spare_reads`,
  `redaction_does_not_mutate_its_input`, and the four golden runners.
- The TypeScript↔daemon parity guard stays where it was: `remoteTiers.parity.test.ts` still
  checks `tiers.json` (through `METHOD_RULES`) against `dispatch` and `EVENT_POLICY` against
  emitted event types. It is not duplicated in Rust, as the spec directs.

## 6. Gates

All commands were run in this worktree with `CARGO_TARGET_DIR=C:/fxtarget`.

| Gate | Command | Result |
|---|---|---|
| Rust tests | `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast` | **pass** — 595 passed, 0 failed, 0 ignored across 43 suites |
| Rust lints | `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` | **pass** — clean, `Finished dev profile` |
| TypeScript | `cd apps/desktop && npx tsc -b` | **pass** — exit 0, no diagnostics |
| TypeScript tests | `cd apps/desktop && npx vitest run src/remote` | **pass** — 125 tests in 4 files (`remoteTiers.test.ts`, `remoteTiers.parity.test.ts`, `policyGoldens.test.ts` 78, `RemoteApp.mounted.test.tsx` 3) |
| Tier table | `node ../../scripts/print-remote-tiers.mjs > NUL` | **cannot pass as written — pre-existing, not caused by this change (see below)** |
| Tier table (documented invocation) | `npx vite-node ../../scripts/print-remote-tiers.mjs` | **pass** — 88 lines (86 rows + 2 header rows), byte-identical to the table printed from `HEAD` |

`--offline` was added to the Cargo commands; the toolchain had everything cached, so it
changed nothing about the result.

### The tier-table gate, honestly

The spec's gate says `node ../../scripts/print-remote-tiers.mjs`. That command fails with
`ERR_MODULE_NOT_FOUND`, and it fails **on the unmodified checkout too**, for a reason that
has nothing to do with WP6a:

```
$ git show HEAD:apps/desktop/src/remote/remoteTiers.ts > apps/desktop/src/remote/_headcheck.ts
$ node -e "import('./apps/desktop/src/remote/_headcheck.ts').then(...)"
ERR_MODULE_NOT_FOUND | Cannot find module 'C:\fx46\apps\desktop\src\remote\remoteContract'
imported from C:\fx46\apps\desktop\src\remote\_headcheck.ts
```

`remoteTiers.ts` has always imported `./remoteContract` without a file extension, which
plain Node ESM cannot resolve; the script's own header documents the working invocation
(`npx vite-node scripts/print-remote-tiers.mjs`). It also could not be made to work by
adding extensions alone, because a JSON import would then need an ESM import attribute,
which risks the UI bundle for a gate line that is already broken at `HEAD`. So the gate was
run with `vite-node` (the documented path) and this note records the discrepancy rather
than papering over it. The temporary `_headcheck.ts` used as evidence was deleted.

## 7. Verified vs not verified

**Verified in this worktree**

- The Rust and TypeScript policy agree on all 76 golden cases (`cargo test` and
  `vitest run`), which is the anti-drift proof the package exists for.
- The rewrite is behaviour-preserving: the generated docs table is byte-identical to
  `HEAD`'s, and the pre-existing TypeScript tests pass unmodified.
- `tiers.json` is a faithful transcription of the old tables: generated from them, and
  the counts (86 methods, 42 events, 8 settings keys) match.
- Workspace tests, clippy with `-D warnings`, `tsc -b` and the remote Vitest suite all pass.

**Not verified**

- No listener, gateway, Tailscale, pairing, cookie or `remote.*` RPC was built or exercised;
  nothing enforces the policy at runtime (WP6b).
- No end-to-end run of the daemon; `mod remote;` has no production caller yet.
- The golden fixtures all use ASCII text, deliberately, so the 200-code-unit trim is only
  proved equal for ASCII. A non-ASCII message could differ between
  `chars().take(200)` and JavaScript's UTF-16 `slice`; this is called out in the spec and in
  a code comment.
- The fixtures are not exhaustive over the whole snapshot schema; they cover the field
  policy branches the spec lists, not every field the daemon emits.
- `serde_json/arbitrary_precision` is enabled elsewhere in the workspace
  (`bloblex-adapter-acp`), so number equality is on the internal string form; the golden
  comparison passes, but that dependency is a workspace-level feature-unification effect
  rather than a property of this module.
- The desktop Vite bundle was not rebuilt; `remoteTiers.ts` is not imported by any UI file
  (only `scripts/print-remote-tiers.mjs` imports it), so the JSON import does not enter the
  UI graph.
- No `git commit` was made, by instruction.
