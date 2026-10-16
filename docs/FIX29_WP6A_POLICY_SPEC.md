# FIX29 (WP6a): one remote policy for Rust and TypeScript

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, own worktree, private `CARGO_TARGET_DIR`. Director reviews, runs the gates on the merged result and commits. **Do not run `git commit`.** Read `AGENTS.md` first, then `docs/remote/ARCHITECTURE.md`, `docs/remote/PROTOCOL.md` and `docs/remote/PHASES.md` (WP6a).

Read before coding: `apps/desktop/src/remote/remoteTiers.ts` (all of it), `remoteTiers.test.ts`, `remoteTiers.parity.test.ts`, `remoteContract.ts`, `scripts/print-remote-tiers.mjs`, and `crates/bloblex-daemon/src/main.rs` (`dispatch`, `mod` declarations).

## Goal
Today the remote policy lives only in `remoteTiers.ts`. The gateway (WP6b) will run inside the Rust daemon, so the same policy must exist in Rust **without two hand-kept copies drifting**. This package moves the data into one JSON file, keeps the TypeScript behaviour identical, and adds a Rust port that is proved equal by shared golden fixtures. No network, no listener, no gateway: that is WP6b.

## 1. `apps/desktop/src/remote/tiers.json` (the single source)
```json
{
  "version": 1,
  "methods": [ { "method": "app.snapshot", "class": "read", "minTier": "viewer", "why": "…", "params": null }, … ],
  "events": { "message.delta": "allow", …, "backup.imported": "drop", … },
  "settingsAllowlist": [ "appearance.style", … ],
  "sensitiveKeyPattern": "token|secret|password|credential|capability|api[-_]?key|private[-_]?key|authorization|bearer|cookie"
}
```
- `methods` holds every row of `METHOD_RULES`, **in the same order**, with the same `why` text. `minTier` is `"viewer" | "chat" | "operator" | null`.
- `params` names a rule by id instead of holding a function: `"stagedAttachments"`, `"permissionReply"`, `"runtimeModels"`, or `null`. Each side implements those three checks itself with identical denial strings.
- `events` holds every `EVENT_POLICY` entry. `settingsAllowlist` holds `SETTINGS_ALLOWLIST`. The pattern is matched case-insensitively.
- The file lives under `apps/desktop/src` because `tsc -b` only allows imports inside `src`; Rust reads it with `include_str!("../../../../apps/desktop/src/remote/tiers.json")` (adjust the relative path to the module's location).

## 2. TypeScript
- `remoteTiers.ts` imports `tiers.json` and builds `METHOD_RULES`, `EVENT_POLICY`, `SETTINGS_ALLOWLIST` and the sensitive-key regex from it. Keep every export name and type (`MethodRule.params` is still a `ParamRule` object, resolved from the id). `authorizeRemoteCall`, `ruleFor`, `renderTierTableMarkdown`, `redactSnapshotForRemote`, `redactResultForRemote` and `redactEventForRemote` keep exactly their current behaviour.
- A small validation at import (or in a test) fails if a `params` id is unknown, a class or tier is misspelled, or a method appears twice.
- Existing tests (`remoteTiers.test.ts`, `remoteTiers.parity.test.ts`) must pass unchanged, except that the parity test may read the JSON directly. `scripts/print-remote-tiers.mjs` keeps working.
- Do not change UI files.

## 3. Rust: `crates/bloblex-daemon/src/remote/` (new)
- `mod.rs` declares `pub mod policy;` (WP6b will add `tailscale`, `pairing`, `web`). Add `mod remote;` to `main.rs` with `#[allow(dead_code)]` only where truly needed until WP6b uses it.
- `policy.rs` loads `tiers.json` once (`OnceLock` / `LazyLock`, `serde_json`; a parse failure panics in a test, never at runtime: add a test that parses it). It ports, with the same semantics and strings:
  - `rule_for(method) -> Option<&MethodRule>`: exact match first, else the longest `family.*` prefix.
  - `authorize(call: &RemoteCall) -> Decision` with `Decision::Allowed | Denied { code, reason }`. Codes: `forbidden_remote`, `tier_required`, `approvals_disabled`, `quiet_hours`, `invalid_params`. Same order of checks as `authorizeRemoteCall`.
  - The three param checks.
  - `redact_snapshot(&Value, &RedactOptions) -> Value`, `redact_result(method, &Value, &RedactOptions) -> Value`, `redact_event(&Value) -> Option<Value>`: the full field policy (`providerSessionId` dropped, `customEnv` → `{}`, `customArgs`/`args`/`launchArgs` → `{argCount}`, `executablePath` → file name, `instructions` → `{hasInstructions:true}` when non-empty, `defaultProject`/`projectPath`/`files[].path`/`projects[].path` → last two segments, `attachments[].path` → file name, `detail` under `tools` kept only with `includeToolOutput`, under `turns`/`files` dropped, top-level `settings` reduced to the allowlist, sensitive keys removed everywhere), and the per-event rules (`message.completed` drops `raw`/`providerPayload`; `turn.error` trims `message` to 200 **characters** (TS `slice` counts UTF-16 units: use `chars().take(200)` and keep fixtures ASCII so both agree) and reduces absolute paths; `permission.requested` reduces absolute paths; `agent.changed` uses the agent policy). Absolute path detection matches TS: starts with `/`, `\\`, or `X:\` / `X:/`.
  - Pure functions; inputs are never mutated.
- Object key order: `serde_json` maps are sorted in this build. Compare goldens structurally (`Value == Value`), not as strings.

## 4. Golden fixtures shared by both sides
`apps/desktop/src/remote/fixtures/policy-goldens.json`:
```json
{ "authorize": [ { "name": "…", "call": { "tier": "chat", "approvalsFromRemote": false, "method": "permission.reply", "params": {…}, "quietHours": false }, "expect": { "allowed": false, "code": "approvals_disabled", "reason": "…" } }, … ],
  "results":   [ { "name": "…", "method": "agent.list", "options": { "includeToolOutput": false }, "input": {…}, "expect": {…} }, … ],
  "snapshots": [ { "name": "…", "options": {}, "input": {…}, "expect": {…} }, … ],
  "events":    [ { "name": "…", "input": { "type": "turn.error", "payload": {…} }, "expect": {… } | null }, … ] }
```
- At least: 15 authorize cases (every code, family wildcard, unknown method, quiet hours on read vs chat, each param rule pass and fail); 10 result cases (each `redactResultForRemote` branch, including `settings.get` and a `read` default); 4 snapshot cases (Windows and POSIX paths, nested `files`/`turns`/`tools` detail with and without `includeToolOutput`, sensitive keys at several depths, `customEnv`, `args`); 10 event cases (every special-cased type, an allowed default, a dropped type, an unknown type, a non-object envelope).
- **Generate the `expect` values by running the current TypeScript functions** (a one-off script is fine, do not commit it), then check them by eye. They are the contract.
- Vitest: a new `policyGoldens.test.ts` runs every case through the TS functions. Rust: a `#[cfg(test)]` module in `policy.rs` runs every case through the Rust functions (`include_str!` the fixture). Both must pass.

## 5. Parity guard in Rust
The TypeScript parity test already checks `tiers.json` against `dispatch`; do not duplicate it in Rust. Add Rust tests that every method row is unique, every `class` and `minTier` is valid, and every `params` id is one of the three known ids.

## Out of scope
Listener, Tailscale, pairing, cookies, storage tables, `remote.*` RPCs, PWA build, any UI change. Do not touch `remoteContract.ts` types beyond what the JSON import needs.

## Gates
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote && node ../../scripts/print-remote-tiers.mjs > NUL` (or `/dev/null`)

## Report
`docs/FIX29_WP6A_REPORT.md`: files changed, the JSON shape as implemented, how the goldens were generated, case counts per section, gate summaries, verified versus not verified.
