# Phase 3B spec: recorded-wire replay tests per CLI version (test infrastructure)

Owner: OpenCode lane. Reviewer: Director. Parent plan: `docs/IMPROVEMENT_PLAN.md` Phase 3 (the BB `provider-parity` idea). Purpose: catch adapter drift against real CLI protocol transcripts without needing the CLIs in CI.
Scope: `crates/bloblex-adapter-claude`, `crates/bloblex-adapter-codex`, `crates/bloblex-adapter-acp` (their existing fake binaries and tests), a new tiny shared module only if clearly needed, `docs/`. No new dependencies. No production behaviour change.

## Rules
- Work only in this worktree; **do not read or list any path outside it** (an out-of-tree read is auto-rejected and ends your session). Never run git commit/push/checkout/stash.
- `CARGO_TARGET_DIR=D:/b-p1`, `RUST_MIN_STACK=33554432`.
- Match repo style. No `unwrap()` in non-test, non-fake-binary code you add.
- **Fixtures must be hand-built or synthesised from existing in-repo fake output and test fixtures. Do not run any real provider CLI, do not read the user's home directory or provider config, and never include credentials, tokens, absolute user paths or real prompt text.** Mark every fixture header with `"synthesised": true` and the CLI version string it models (take versions from `docs/runtime-capabilities.md`).

## Deliverables
1. **Wire fixture format** (documented in `docs/evidence/wire-fixtures.md`): NDJSON, one object per line: `{"dir":"in"|"out","t":<ms offset>,"msg":{...}}` where `in` is what the adapter writes to the provider and `out` is what the provider writes back; a first line header `{"header":{"provider","cliVersion","scenario","synthesised":true}}`.
2. **Replay mode** for the three fake binaries (`fake_claude`, `fake_codex_server`, `fake_acp_peer`): a `--replay <file>` flag that plays the `out` lines in order, each only after the matching `in` line (or immediately for provider-initiated lines at the start) was received, comparing each received `in` message to the recorded one with an allowlist of volatile fields (`id`, `session_id`/`sessionId`, `threadId`, `turnId`, `request_id`, uuids, timestamps, absolute paths) that are masked on both sides before comparison. A mismatch exits non-zero and writes one safe diagnostic line to stderr naming the line number and the differing JSON pointer (never the whole message).
3. **Recorder helper (developer only):** env var `BLOBLEX_WIRE_RECORD=<path>` honoured by the three fake binaries only (not by production adapters) to write the same format from their own live behaviour, with the same masking, so new fixtures can be generated from fake scenarios and later replaced by real captures by a person.
4. **Fixtures and tests** under `crates/<adapter>/tests/wire/`: at least these scenarios, each as a fixture plus a test that drives the production adapter against the replaying fake and asserts the normalised `AgentEvent` sequence: Claude: simple text turn; tool call plus permission allow; permission deny; `api_error_status` 429 failed turn (expects a `RecoveryHint` then `Error`); compact boundary (expects `ContextReset` then `ContextChanged`). Codex: simple turn; `turn/steer` accepted; `serverOverloaded` failed turn; rejected resume falling back to a fresh thread. ACP/OpenCode: simple turn with usage update; effort selection echo; permission request.
5. **Drift guard:** a test that fails with a clear message if a fixture's header `cliVersion` is missing or if the fixture set for a provider is empty, so adding a provider version forces adding fixtures.

## Gates (run and report real output)
```
CARGO_TARGET_DIR=D:/b-p1 RUST_MIN_STACK=33554432 cargo test -p bloblex-adapter-claude -p bloblex-adapter-codex -p bloblex-adapter-acp
```
All pre-existing tests must pass unchanged.

## Final report (plain text, last message)
1. Files changed. 2. Per deliverable: what you did and exact test names. 3. Gate output per crate. 4. Anything unverified; state plainly that fixtures are synthesised, not real captures.
