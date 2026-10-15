# FIX25: harden the remote policy code after the independent review

Written 15 October 2026. Input: `docs/remote/REVIEW_NOTES.md` (sections 1, 4 and 5). Scope:
`apps/desktop/src/remote/remoteTiers.ts` and its tests only, plus the generator script. No
components, no CSS, no Rust, no docs (the Director edits the docs in parallel).
Never commit; leave the diff and write `docs/FIX25_REPORT.md` (one line per numbered item).

Read `remoteTiers.ts`, `remoteTiers.test.ts`, `remoteTiers.parity.test.ts`,
`remoteContract.ts` and `docs/remote/REVIEW_NOTES.md`.

## 1. Be honest about enforcement

The header comment claims `daemon_rpc` consults the table. It does not (the shell proxy is a
pass-through; enforcement is a P1 gateway job). Rewrite the comment to say: this module is the
executable specification of the policy; the future gateway must call `authorizeRemoteCall` and
the redactors before any call and before any value leaves the host; nothing enforces it yet.

## 2. Wire error codes from the policy

`authorizeRemoteCall` returns `{ allowed: false; code; reason }` where `code` is one of
`forbidden_remote` (class never or unknown), `tier_required` (tier too low), `approvals_disabled`
(approve class while `approvalsFromRemote` is false or tier below operator), `quiet_hours`,
`invalid_params` (param rule failed). Keep `reason` as plain English. Update tests and
`renderTierTableMarkdown` only if its columns change (they should not).

## 3. Quiet hours as a hard read-only override

Add `quietHours: boolean` to the input. When true, every method whose class is `chat` or
`approve` is denied with `quiet_hours`, including `session.cancel`, `session.archive`,
`session.rename`, `session.queue.*` and `session.resume`; `read` methods still pass. Tests.

## 4. Param rules

- `runtime.models`: reject `refresh: true` (`invalid_params`: a device may not make the host
  poll providers).
- `permission.reply`: keep current rule.
- Add a test that every `chat` method taking `attachments` is covered by the staged-attachment
  rule (list them by reading the dispatch for `attachments`).

## 5. Redaction coverage

Rewrite `redactSnapshotForRemote` to a documented field policy and add tests for each row:

| Path | Policy |
|---|---|
| `runtimes[].executablePath`, `runtimes[].args`, `runtimeProfiles[].executablePath/args` | executablePath reduced to its file name; args removed, replaced by `{ argCount }` |
| `agents[].defaultProject`, any `projectPath`, `projects[].path`, `files[].path` | last two path segments only |
| `agents[].customArgs` | replaced by `{ argCount }` |
| `agents[].customEnv` | `{}` (key names dropped, matching the current code; the docs are being corrected) |
| `agents[].instructions` | `{ hasInstructions: true }` when non-empty |
| `sessions[].messages[].attachments[].path` | file name only |
| `sessions[].tools[].detail`, `sessions[].turns[].detail`, `sessions[].files[].detail` | removed by default (`includeToolOutput` option, default false, restores tool `detail` only) |
| `sessions[].providerSessionId` | removed |
| keys matching `/token|secret|password|credential|capability|api[-_]?key|private[-_]?key|authorization|bearer|cookie/i` | removed |
| `settings` | reduced to the allowlist in section 6 |
| message `content` | kept (this is the conversation the device exists to show) |

Never mutate the input. The function accepts `unknown` and returns `unknown`.

## 6. Redactors for other reads

Export `redactResultForRemote(method, result, options?)` that routes by method:
`app.snapshot`, `session.get`, `session.list`, `agent.get`, `agent.list`, `runtime.list`,
`runtime.profile.list`, `search.messages`, `automation.get` (prompt kept, paths trimmed),
`memory.get`/`memory.list` (kept), `settings.get` (allowlist: `appearance.style`,
`appearance.accent`, `appearance.theme`, `appearance.textSize`, `appearance.density`,
`notifications.enabled`, `permissions.default_mode`, `experimental.memory`) and everything
else unchanged. A method the router does not know and whose class is `read` must go through the
generic walker (section 5), never pass raw.

## 7. Event redaction

Export `redactEventForRemote(event)` that returns `null` (do not send) for event types not on
an allowlist and a scrubbed copy for allowed ones. Allowlist: `message.delta`,
`message.completed` (drop `raw`, `providerPayload`), `session.changed`, `session.deleted`,
`turn.completed`, `turn.cancelled`, `turn.error` (message text trimmed to 200 chars, paths
reduced), `permission.requested` (command text kept, absolute paths reduced),
`permission.resolved`, `agent.changed` (through the agent redactor), `queue.changed`,
`usage.updated`, `quota.updated`, `daemon.health`, `events.replay.complete`, `replay.gap`.
Everything else (for example `tool.changed` detail, `hook.observed`, `exec.options.*`,
`settings.changed`) returns `null`. Tests including an unknown type.

## 8. Parity test additions

Add assertions that every event type emitted by the daemon (`st.emit("...")` or the event
constants; read the code) is either on the allowlist or consciously absent, in a table
`EVENT_POLICY` exported from the module (`allow` | `drop`), so a new event type fails the
build until classified.

## Gates

`npm run typecheck`, `npm run test`, then run the generator
(`apps/desktop/src/remote/remoteTiers.ts` `renderTierTableMarkdown`) and confirm the table in
`docs/remote/PROTOCOL.md` is unchanged or report the diff.
