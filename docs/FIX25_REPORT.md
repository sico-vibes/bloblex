# FIX25 report: harden the remote policy code

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`. Worktree: this checkout only. Nothing was
committed (the Director commits after review). Scope kept to
`apps/desktop/src/remote/remoteTiers.ts` and its two tests, plus this report; no components, CSS,
Rust or docs were edited.

Input read first: `docs/remote/REVIEW_NOTES.md`, `remoteTiers.ts`, `remoteTiers.test.ts`,
`remoteTiers.parity.test.ts`, `remoteContract.ts`, plus the daemon sources they cite
(`crates/bloblex-daemon/src/main.rs`, `queue.rs`, `automations.rs`, `questions.rs`, `retry.rs`,
`team.rs`, `memory.rs`, `crates/bloblex-storage/src/lib.rs`, `experiments.rs`) and the generated
table in `docs/remote/PROTOCOL.md`.

## 1. Honest enforcement header

The header comment no longer claims `daemon_rpc` consults the table: it now states that this
module is the executable specification of the policy, that the future gateway must call
`authorizeRemoteCall` before every call and route results and events through the redactors before
any value leaves the host, that nothing enforces it yet, and that the `lib.rs` `daemon_rpc` is a
pass-through.

## 2. Error codes

`authorizeRemoteCall` now returns `{ allowed: true }` or
`{ allowed: false; code: DenialCode; reason: string }` with codes `forbidden_remote` (unknown
method or `never` class), `approvals_disabled` (approve class at a tier below operator, or
`approvalsFromRemote` false), `quiet_hours`, `tier_required` (non-approve tier too low) and
`invalid_params` (param rule failed); `reason` stays plain English and `renderTierTableMarkdown`
columns are unchanged.

## 3. Quiet hours

`RemoteCall` gained `quietHours?: boolean`; when true, every `chat` and `approve` method is denied
with `quiet_hours` (including `session.cancel`, `session.archive`, `session.rename`,
`session.queue.*`, `session.resume` and `permission.reply`) while `read` methods still pass, with
tests for both halves.

## 4. Param rules

`runtime.models` now carries `runtimeModelsRule`, which rejects `refresh: true` with
`invalid_params`; `permissionReplyRule` is unchanged; and a test asserts every chat method that
reads `attachments` (`session.prompt` via `prompt_attachments(&p["attachments"])` in `main.rs`,
`session.queue.add` via `validate_body` in `queue.rs`) resolves to `stagedAttachmentRule` and
rejects a raw path.

## 5. Redaction coverage

`redactSnapshotForRemote` was rewritten around a documented path-aware field policy
(executablePath to file name; `args`/`launchArgs`/`customArgs` to `{ argCount }`; `defaultProject`,
`projectPath`, projects/files `path` to the last two segments; `customEnv` to `{}`; non-empty
`instructions` to `{ hasInstructions: true }`; attachment `path` to a file name;
tools/turns/files `detail` removed unless `includeToolOutput` restores tool `detail` only;
`providerSessionId` removed; the widened sensitive-key regex; `settings` reduced to the allowlist;
message `content` kept), with a test for each row and a no-mutation test.

## 6. Redactors for other reads

`redactResultForRemote(method, result, options?)` routes `app.snapshot` to the snapshot policy;
`session.get`/`session.list`, `agent.get`/`agent.list`, `runtime.list`, `runtime.profile.list`,
`search.messages` and `automation.get` (prompt kept, paths trimmed) through the field watcher;
`memory.get`/`memory.list` untouched; `settings.get` reduced to the allowlist; any other `read`
method through the field watcher; and every non-read method unchanged.

## 7. Event redaction

`redactEventForRemote(event)` returns `null` for any type not on the allowlist and a scrubbed
envelope otherwise: `message.completed` drops `raw`/`providerPayload`; `turn.error` trims the
message to 200 characters and reduces absolute paths; `permission.requested` keeps command text
and reduces absolute paths; `agent.changed` goes through the agent policy; the remaining allowed
types are walked for sensitive keys. Tests cover each allowed type, each dropped example
(`tool.changed`, `hook.observed`, `exec.options.*`, `settings.changed`) and an unknown type.

## 8. Parity additions

`EVENT_POLICY` is exported with an `allow`/`drop` value for all 39 daemon event types, and
`remoteTiers.parity.test.ts` now extracts every emitted type from `st.emit("...")`, the
`forward_events_with_timeouts` tuples, the inline JSON envelopes and the storage `app_events`
rows, then fails if any emitted type is unclassified and if the allow set drifts from the reviewed
16.

## Gates

- `npm run typecheck` — pass (`tsc -b --pretty false`, no output).
- `npm run test` — pass except one pre-existing load-related timeout in
  `src/ui/App.agent.mounted.test.tsx` (unrelated to `src/remote/`; passes alone: 781/782, and the
  three `src/remote/` files pass 47/47).
- Generator `npx vite-node scripts/print-remote-tiers.mjs` — the 75-line table is byte-identical
  to the table in `docs/remote/PROTOCOL.md` (`diff` empty; no docs diff to report).

## Judgement calls

- `runtimes[].launchArgs` is the daemon's spelling of the spec's `runtimes[].args`, and
  `runtime.profile.list` actually returns `profiles[]`; the policy covers `args`, `launchArgs` and
  both `runtimeProfiles[]`/`profiles[]` so either spelling is redacted.
- `reducedPath` now returns the last two segments for any path longer than two segments (absolute
  or relative); relative two-segment values such as `relative/project` are unchanged, as before.
- `session.queue.update` reads only stored attachments, not `params.attachments`, so it is listed
  under the covered `session.queue.*` family but not in the "takes attachments" list.
