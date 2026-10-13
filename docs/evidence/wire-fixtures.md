# Wire fixtures and replay (Phase 3B)

Recorded-wire replay lets the adapter tests exercise a real CLI protocol
transcript without the CLI: each fixture is a synthesised NDJSON transcript of
one provider session, replayed by the provider's fake binary. The production
adapter is the only adapter under test; a mismatch between what it sends and
what the fixture recorded fails the replayer with a JSON-pointer diagnostic.

All fixtures here are **synthesised** from the in-repo fake binaries' own
output, not captured from a real CLI. Every header carries `"synthesised": true`
and the CLI version the transcript models (from
[`docs/runtime-capabilities.md`](../runtime-capabilities.md): Claude Code
2.1.286, Codex CLI 0.159.3, OpenCode 1.18.34).

## Format

NDJSON, one JSON object per line. Line 1 is the header:

```json
{"header":{"provider":"claude","cliVersion":"2.1.286","scenario":"simple-turn.ndjson","synthesised":true}}
```

Every later line is a message:

```json
{"dir":"in","t":1,"msg":{"type":"user","message":{"role":"user","content":"hello"}}}
{"dir":"out","t":1,"msg":{"type":"result","is_error":false,"result":"fake response"}}
```

- `dir:"in"` is a message the **adapter writes to the provider** (stdin).
- `dir:"out"` is a message the **provider writes back** (stdout).
- `t` is a millisecond offset from fake start. It is informational; replay does
  not sleep on it.
- `msg` is the message body.

With neither `--replay` nor `BLOBLEX_WIRE_RECORD` set, the fake binaries behave
exactly as before.

## Replay

`--replay <file>` plays the transcript back:

- Provider-initiated `out` lines before the first client input are emitted
  immediately at startup (for example Claude's `system/init`, which the adapter
  waits on).
- Each subsequent `out` line is emitted only after the `in` line that precedes
  it has been received and matched.
- Each received `in` message is compared to the recorded one. A mismatch exits
  non-zero and writes one safe stderr line naming the fixture line number and
  the differing JSON pointer — never the message body.

Volatile fields differ between runs, so both sides of an `in` comparison are
masked before comparing. Masked by key: `id`, `session_id`, `sessionId`,
`threadId`, `turnId`, `turn_id`, `request_id`, `requestId`, `expectedTurnId`,
`provider_session_id`, `tuid`, `uuid`, `timestamp`, `createdAt`, `updatedAt`,
`created_at`, `updated_at`, `startedAt`, `completedAt`, `resetsAt`, `cwd`.
Additionally, any string that looks like a UUID, and any absolute POSIX,
Windows-drive or UNC path, is replaced with `<masked>` / `<masked-path>` on
**both** sides.

`out` lines are sanitised the same way when written (UUIDs and absolute paths
only) so recordings never carry real ids or user paths. Request correlation
still works because the Codex and ACP adapters number requests from a
deterministic counter (1, 2, 3 …), and Claude echoes the provider request id.

## Recorder (developer only)

`BLOBLEX_WIRE_RECORD=<path>` makes a fake write its own live behaviour to
`<path>` in the same format (header included); `BLOBLEX_WIRE_SCENARIO=<name>`
sets the header's scenario label. Only the three fake binaries honour it; the
production adapters never read it.

The wire tests support regeneration directly: when `BLOBLEX_WIRE_RECORD` is
exported, each test points the fake at its own fixture path and runs the fake
live instead of replaying. Run one crate at a time and single-threaded so the
process-wide environment variable cannot leak between scenarios (PowerShell;
bash users set the same variables with `export`):

```powershell
$env:BLOBLEX_WIRE_RECORD="1"
cargo test -p bloblex-adapter-claude --test wire_replay -- --test-threads=1 --skip wire_fixtures
cargo test -p bloblex-adapter-codex  --test wire_replay -- --test-threads=1 --skip wire_fixtures
cargo test -p bloblex-adapter-acp    --test wire_replay -- --test-threads=1 --skip wire_fixtures
Remove-Item Env:BLOBLEX_WIRE_RECORD
```

Each test sleeps briefly before tearing the provider down so a recording
captures a complete final line. A person replacing a fixture with a real
capture should keep the header's `cliVersion` and change `synthesised` to
`false`.

## Fixtures and tests

Each crate exposes its own `tests/wire_replay.rs` crate root with the scenarios
in `tests/wire/mod.rs` and fixtures in `tests/wire/fixtures/`. Every scenario
test drives the production adapter against `--replay` and asserts the normalised
`AgentEvent` sequence.

| provider | fixture | scenario | asserted events | test |
|---|---|---|---|---|
| claude | `simple-turn.ndjson` | simple text turn | reported usage, `TurnCompleted` | `claude_simple_turn_replays_a_text_result` |
| claude | `tool-permission-allow.ndjson` | tool call + permission allow | `ToolStarted`, `PermissionRequested`, `TurnCompleted` | `claude_tool_call_permission_allow_roundtrips` |
| claude | `permission-deny.ndjson` | permission deny | `PermissionRequested`, `TurnCompleted` | `claude_permission_deny_still_completes_the_turn` |
| claude | `api-error-429.ndjson` | `api_error_status` 429 | `RecoveryHint(RateLimited)` then `Error`, unreported usage | `claude_api_error_status_429_emits_a_recovery_hint_before_the_error` |
| claude | `compact-boundary.ndjson` | compact boundary | `ContextReset` then `ContextChanged(Compaction)` | `claude_compact_boundary_resets_context_then_announces_compaction` |
| codex | `simple-turn.ndjson` | simple turn | reported token usage, `TurnCompleted` | `codex_simple_turn_replays_a_completed_turn` |
| codex | `turn-steer-accepted.ndjson` | `turn/steer` accepted | `SteerOutcome::Accepted` | `codex_turn_steer_is_accepted` |
| codex | `server-overloaded.ndjson` | `serverOverloaded` failed turn | `RecoveryHint(Overloaded)` then `Error` | `codex_server_overloaded_turn_emits_a_recovery_hint` |
| codex | `resume-rejected.ndjson` | rejected resume | `ResumeRejected` | `codex_rejected_resume_is_reported` |
| opencode | `simple-turn.ndjson` | simple turn + usage update | reported usage with context and cost, `TurnCompleted` | `acp_simple_turn_reports_a_usage_update` |
| opencode | `effort-echo.ndjson` | effort selection echo | `ExecApplied` with provider-echoed effort | `acp_effort_selection_is_echoed` |
| opencode | `permission-request.ndjson` | permission request | `PermissionRequested` then `TurnCompleted` | `acp_permission_request_roundtrips` |

## Drift guard

`<provider>_wire_fixtures_are_versioned_and_present` scans the provider's
fixture directory and fails if it is empty or if any header is missing a
`provider`, `cliVersion` or `synthesised` field, or if the provider or version
does not match the expected value. Adding a provider version therefore forces
adding fixtures.

## Limitations

- Fixtures are synthesised, not real captures. They prove the adapter agrees
  with the fake's transcript, not with a real CLI build.
- The two additive fake modes used only by fixtures are
  `fake-claude --fake-tool-permission` and `fake-claude
  --fake-api-error-status=<code>`, plus `fake-acp-peer --permission-request`.
  They are test infrastructure, never production.
- The Codex "rejected resume falls back to a fresh thread" behaviour needs a
  two-process crash/restart transcript. The fake expresses the rejection and
  the single-process `resume-rejected.ndjson` covers it; the fresh-thread
  fallback itself is a daemon-level path and is **not** replayed here.
