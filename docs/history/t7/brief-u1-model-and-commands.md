# Lane U1 brief: model switching that tells the truth, and idempotent session commands

Worktree `D:\u1` (branch `lane/u1`), cut from `main` with the owner's dirty baseline applied. You are an OpenCode lane. The Director (Claude) reviews your diff and merges it.

## Hard rules (owner, 27 October 2026; they override the repo gates)

- **No tests of any kind.** Do not run `cargo test`, `cargo check --tests`, `cargo clippy --all-targets`, `npm test`, vitest, any app, browser, probe or screenshot. Do not add, edit or delete any test or any `#[cfg(test)]` code. Allowed check: `cargo check -p bloblex-daemon -p bloblex-storage -p bloblex-agent-core -p bloblex-adapter-claude -p bloblex-adapter-codex -p bloblex-adapter-acp` (production targets, no `--tests`). If your change breaks an existing test's compilation you cannot see it; say so in the report and list the tests that reference what you changed (`rg` for the symbol).
- **No git writes**: no commit, add, stash, reset, checkout, rebase, push, branch. Do not touch any other worktree or any running process. Never print secrets, tokens or message content.
- Work log at `target/lane/worklog.md` (update as you go so a stopped run can resume); final report at `target/lane/report.md`. Keep tool output small (pipe through `head`/`tail`).
- Cargo: use this worktree's own `target`. Set `$env:RUST_MIN_STACK='33554432'`.
- Style: match the surrounding Rust (dense lines are normal). Doc comments say why. Daemon errors use `derr(code, message, StatusCode)`; messages are plain sentence-case English a user can act on.
- Golden rules: the daemon owns decisions; never fabricate success; no budgets; no copied provider authentication; prompts never go through shell text.

## Files you own

`crates/bloblex-daemon/src/main.rs` (only: `update_session_model` and its helpers, the `session.model.*` dispatch arms, `session_prompt_impl`'s idempotency preamble, a new `session_model_plan` function), `crates/bloblex-daemon/src/queue.rs` (only the `add` path), `crates/bloblex-storage/src/lib.rs` (only the new/changed session-model, message and queue-idempotency functions), `crates/bloblex-agent-core/src/lib.rs` (one new default trait method), and the single capability method in each of `crates/bloblex-adapter-{claude,codex,acp,opencode}/src/lib.rs`. **Do not edit**: `delegations.rs`, `questions.rs`, `team.rs`, `proposals.rs`, `retry.rs`, `tasks.rs`, anything under `apps/` or `docs/`. Other lanes edit those in parallel.

## Item A: model switching must use what each provider can really do

### Evidence (read these first)

- `main.rs:2635-2789` `update_session_model`. A model change always runs `st.db.clear_session_provider_id(sid)` (line ~2770) then `set_session_model_lock` (line ~2771) as **two separate writes**; if the second fails the provider id is gone but the old lock stays. It then removes the live handle from `st.sessions`, emits `session.context.reset`, calls `knowledge::announce_model_change` (Manager handover, or the bounded recap for other bots, `knowledge.rs:~420-470`) and closes the handle. Every model change with any history needs `confirmModelChange:true` (lines 2705-2711).
- But the adapters already apply a changed model **between turns inside the same provider session**:
  - Codex: `bloblex-adapter-codex/src/lib.rs:~1560` sends `p["model"]` (and `effort`) in every `turn/start` for the live thread.
  - Claude: `bloblex-adapter-claude/src/lib.rs:1152-1190` `prompt()` compares `launch_options` to the request (including `model`), and when any differ kills the process and restarts with `--resume <provider_id>` (and `--model` from `typed_args`, line ~205). Effort changes already travel this way today.
  - ACP/OpenCode: `bloblex-adapter-acp/src/lib.rs:836-850` `apply_options` selects the model through the agent's config option when it differs from `applied.model`, before each prompt, and returns an error (`ERR_MODEL_MISSING`/`ERR_MODEL_REJECTED`) instead of prompting when the agent refuses.
  - Read `crates/bloblex-adapter-opencode` and decide from its code whether it can do the same; if you cannot prove it from the code, it must declare "new session".
- T3 Code (the reference app) classifies every selection change as apply-on-next-turn, restart-and-resume, create-with-handoff or reject (`apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.ts` in `C:/Users/SicoZ/AppData/Local/Temp/codex-t3code-research-20261026`). Bitbots has only "create fresh session" for every provider, so it asks the user to confirm a context loss that the provider may not have.

### What to build

1. **Capability on the adapter trait.** In `bloblex-agent-core/src/lib.rs` add to `AgentAdapter` a default method, for example `fn model_switch(&self) -> ModelSwitch` with `enum ModelSwitch { KeepsSession, NewSession }` (serde camelCase, `as_str()`), defaulting to `NewSession`. Override it per adapter **only where the code above proves it**: Codex `KeepsSession`; Claude `KeepsSession` (resume-with-new-model); ACP `KeepsSession` (config-option select before the prompt); opencode as you can prove. Put a one-line comment with the file:line that proves it.
2. **A read-only plan RPC.** Add `session.model.plan` (dispatch arm next to `session.model.update`; params `{sessionId, model}`; no writes, no events, allowed while a turn is live). It returns `{ok, sessionId, provider, currentModel, nextModel, modelChanged, busy, locked, contextAtRisk, continuity, hasHistory, reason}` where `continuity` is `"kept"` (provider session carries on with the new model, nothing lost), `"recap"` (fresh provider session, Bitbots passes a bounded recap) or `"none"` (nothing to lose or model unchanged), and `reason` is one plain sentence the UI can show (provider-specific, honest, e.g. "Codex keeps this thread and runs your next message on the new model." / "Claude Code restarts and resumes this chat on the new model." / "This runtime cannot switch models inside a chat, so the new model starts a fresh session and is given a short summary of the conversation; it will not have the full working memory."). `busy` is true when a turn is active or the state is not idle/closed/error/completed; `locked` mirrors the locked-bot rule. It must reuse the same predicates as `update_session_model` (extract one shared function so the plan and the update can never disagree).
3. **Use the capability in `update_session_model`.** When `ModelSwitch::KeepsSession` and the session has a provider session: do **not** clear the provider id, do **not** drop the live handle, do **not** emit `session.context.reset`, do **not** announce a context loss, and do **not** require `confirmModelChange`. Persist only the new lock; the next `session.prompt` carries the new model to the adapter, which applies it. When `NewSession`: keep today's behaviour (confirmation, reset, recap) unchanged. The reply gains `contextKept: bool`. The Manager keeps its handover note only in the new-session path.
   - Failure honesty: if the adapter later refuses the model on the next prompt, the existing turn error already surfaces it; do not add a silent fallback to a fresh session or to a different model. Check that `session_prompt_impl` does not retry a model-refusal with another model, and report what you find.
4. **Atomic persistence.** Add one storage method (for example `session_apply_model_change(sid, &lock, clear_provider: bool)`) that does the lock write and the provider-id clear in **one SQLite transaction** (follow how other multi-statement storage methods take `self.conn.lock()` and a transaction). Use it in `update_session_model` and nowhere else changes behaviour. Keep `set_session_model_lock` for the other callers.
5. **Stale updates.** Accept an optional `expectedModel` (string or null) on `session.model.update`; when present and different from the stored lock's current model (compare against the same `previous_model` the function computes), return `derr("conflict", "This conversation's model changed elsewhere. Reload it and choose again.", StatusCode::CONFLICT)` **before** writing. Absent means today's behaviour. The check runs under the per-session gate that already serialises prompts.
6. **Idempotent repeats.** A repeated identical request (same model, same effort, nothing else) must be a no-op that does not clear the provider session, emit a reset or write (today `model_changed` is false so this mostly holds; verify and make sure `modelChanged:false` replies carry the current session summary).
7. **Pending work.** Verify and report: what happens to prompts already in this session's durable queue when the model changes? They must run on the new model (they read the lock when sent). If `queue` sends carry an old `exec_options` snapshot, fix that; otherwise just state the evidence.

## Item B: idempotent `session.prompt` and `session.queue.add`

### Evidence

- The UI resends a failed pending message through `deliverPendingSend` (`apps/desktop/src/ui/App.tsx:~1967`) and after a reconnect. `sendWithDelivery` (`apps/desktop/src/ui/busySend.ts`) says "Resend only a definitive refusal; an ambiguous provider failure may have delivered it", but a user "Retry" of an ambiguous failure can duplicate the message. The daemon has no client-supplied key for prompts (`rg clientMessageId` finds nothing); only `task.dispatch` has `idempotencyKey`.
- T3 stores a command receipt per command id (`CommandReceiptStore.ts`) so a replayed command returns the first result.

### What to build

1. Accept an optional `clientMessageId` (string, 8 to 80 chars of `[A-Za-z0-9_-]`, else `invalid_argument`) on `session.prompt` and `session.queue.add`.
2. Store it durably with the message it created: on a prompt, in the user message's `meta` (`meta.clientMessageId`); on a queue add, in the queued prompt's params (`params_json.clientMessageId`). Add storage lookups (`message_by_client_id(session_id, client_id)`, `queue_item_by_client_id(session_id, client_id)`) that are **indexed or bounded** (look at the schema; add `CREATE INDEX IF NOT EXISTS` through the existing migration helpers only if a scan would be unbounded; keep the migration additive and idempotent).
3. Replay rule: if a prompt with this `(sessionId, clientMessageId)` already exists, return the original outcome shape plus `"deduplicated": true` and do **not** start a second turn; for a queue add return the existing item. The lookup happens under the same per-session gate before any side effect. A different text under an existing key is `conflict` ("This message id was already used for a different message.") and writes nothing.
4. Never log the key together with message text. Do not change behaviour when the key is absent.
5. `session.steer` is not made idempotent (a steer cannot be replayed safely); say so in the report.

## Acceptance and report

- `cargo check` of the packages listed above is clean with no new warnings.
- Report (`target/lane/report.md`): per item what changed with `path:line`; the exact contract of the new/changed RPCs (params, reply fields, error codes, messages); every decision you took that this brief did not specify; evidence for each adapter's `model_switch` declaration; the list of existing tests that reference anything you changed (names only); anything you could not make safe, stated exactly. The tail (last 15 lines) of each `cargo check`. No claim of behaviour you did not read in the code.
