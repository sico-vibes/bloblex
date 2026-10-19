# FIX18: which daemon methods a remote device may call (executable spec)

> **What this is:** Executable spec for FIX18: which daemon methods a remote device may call.
> **Status:** historical
> **Last updated:** 2026-10-15

Written 15 October 2026. Remote mode must never expose the daemon wholesale: `daemon_rpc`
today is a pass-through with no allowlist and the daemon accepts open-ended `settings.set`
keys. This lane writes the policy as code plus a parity test, so the table cannot drift.

Read `apps/desktop/src/remote/remoteContract.ts` (do not edit it) and `docs/ipc-contract.md`.
Do not touch components, CSS, Rust, `src/transport/*` or `src/preview/*`.

## 1. `apps/desktop/src/remote/remoteTiers.ts`

```ts
export type MethodClass = 'read' | 'chat' | 'approve' | 'never'
export interface MethodRule { method: string; class: MethodClass; minTier: RemoteTier | null; why: string; params?: ParamRule }
export const METHOD_RULES: readonly MethodRule[]
export function ruleFor(method: string): MethodRule | null
export function authorizeRemoteCall(input: { tier: RemoteTier; approvalsFromRemote: boolean; method: string; params?: unknown }): { allowed: true } | { allowed: false; reason: string }
```

Classification (from the exploration of `crates/bloblex-daemon/src/main.rs` dispatch):

- **read** (viewer and up): `app.snapshot`, `events.replay`, `daemon.health`, `session.list`,
  `session.get`, `runtime.list`, `runtime.capabilities`, `runtime.models`, `exec.snapshot.*`,
  `usage.*`, `quota.list`, `search.messages`, `memory.list`, `memory.get`, `automation.list`,
  `automation.get`, `automation.runs`, `automation.preview`, `agent.list`, `agent.get`,
  `project.list`, `permissions.policy.get`, `settings.get` (the response must be filtered, see 3),
  `runtime.profile.list`, `agent.conversation`.
- **chat** (chat and up): `session.prompt`, `session.steer`, `session.cancel`,
  `session.queue.*` (params rule: attachments must be staged uploads, never raw `path`),
  `session.rename`, `session.archive`, `message.reaction.toggle`, `turn.retry.cancel`,
  `session.resume`, `session.close`.
- **approve** (operator and up, and only when `approvalsFromRemote`): `permission.reply`.
- **never** (always denied remotely): `settings.set`, `agent.create`, `agent.update`,
  `agent.delete`, `agent.restore`, `agent.reorder`, `agent.team.update`, `project.create/update/delete`,
  `runtime.profile.save`, `runtime.profile.delete`, `runtime.refresh`, `session.new`
  (a remote client picks an existing agent and project through a higher-level call defined
  later, not an arbitrary path), `session.delete*`, `file.revert`, `automation.create/update/pause/resume/delete/run_now`,
  `memory.create/update/approve/delete/restore`, `daemon.shutdown`, `hook.event`, `mcp.*`,
  `session.handoff.draft`, `session.model.update`, and the retired `pricing.*`, `subscription.*`, `budget.*`.
- Unknown method: denied with reason "not on the remote allowlist".

`why` is one plain sentence per rule (used verbatim in the docs table).

## 2. Params rules

`ParamRule` is a small validator. Required: `session.queue.add` and `session.prompt` reject any
attachment object that carries a `path`; only `{ stagedId }` is allowed. `permission.reply`
requires `{ permissionId, choice }`. Add tests for each.

## 3. `redactSnapshotForRemote(snapshot)`

Pure function: removes `customEnv` values, `instructions` text longer than 0 replaced by
`{ hasInstructions: true }`, absolute filesystem paths reduced to the last two segments in
`projectPath` fields, and any key whose name matches `/token|secret|password|credential|capability/i`.
Test with a realistic fixture.

## 4. Parity test (the important one)

`remoteTiers.parity.test.ts` reads `crates/bloblex-daemon/src/main.rs` with `fs`, extracts every
dispatch arm method string (arms like `"session.prompt" =>` inside the dispatch function, also
`a | b =>` alternations and prefix guards such as `m if m.starts_with("mcp.")`; read the code to
get the extraction right), and asserts every method appears in `METHOD_RULES` (or is covered by a
documented prefix rule). It must also assert no rule names a method that the dispatch no longer has
(report these as "stale rules"). If the dispatch cannot be parsed reliably, fail loudly with a
clear message rather than passing.

## 5. Docs hand-off

Export `renderTierTableMarkdown()` that returns the Markdown table (method, class, minimum tier,
why) used by `docs/remote/PROTOCOL.md`; add a small node script `scripts/print-remote-tiers.mjs`
that prints it (the TS may be run with `npx vite-node` or by duplicating nothing: pick the simplest
working approach and document it in the report).

## Gates

`npm run typecheck`, `npm run test`. Never commit. Leave the diff and write
`docs/history/fix-18/report.md` (counts per class, any method you were unsure about and why).
