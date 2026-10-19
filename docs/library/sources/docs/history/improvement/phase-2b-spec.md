# Phase 2B spec: steer a live Codex turn (backend, gated off by default)

> **What this is:** Spec for phase 2B: steering a live Codex turn (backend, gated off by default).
> **Status:** historical
> **Last updated:** 2026-10-12

Owner: OpenCode lane (backend only). Reviewer: Director. Parent plan: `docs/plans/improvement-plan.md` Phase 2. Builds on Phase 2A (durable queue, already in this branch). The UI is built by the Director against this contract; do not touch `apps/`.
Scope: `crates/bloblex-agent-core`, `crates/bloblex-adapter-codex`, `crates/bloblex-daemon`, `crates/bloblex-storage` (only if needed), `docs/`. No new dependencies.

## Rules
- Work only in this worktree. **Never run `git commit`, `git push`, `git checkout`, `git stash`.** Leave changes uncommitted.
- Cargo: `CARGO_TARGET_DIR=D:/b-p1` and `RUST_MIN_STACK=33554432` (one daemon test overflows the default stack on the base commit; pre-existing).
- Match repo style. No new dependencies. No `unwrap()` in non-test code you add. Never log or persist tokens or raw provider JSON.
- Specs and any file you are given must stay inside the worktree. Existing behaviour not listed here is unchanged.
- **No guessing about the wire.** The installed Codex (codex-cli 0.162.1) advertises a `turn/steer` client request. Generate the schema once into an OS temp directory with `codex app-server generate-json-schema --out <temp dir>` (read-only for the repo; do not commit it), read `TurnSteerParams` / `TurnSteerResponse` (and the related error shapes) and cite the schema paths in the evidence file below. Build the request exactly from that schema.

## Product behaviour
Steering means "add this to the turn that is running right now". It is only for providers that can do it for real. **Only Codex implements it.** Claude and ACP/OpenCode stay queue-only (their adapters return `Unsupported`); the daemon must say so honestly, never fake it by interrupting and re-sending.
It is **off by default** and reported as unproven until someone verifies it live: evidence `none`.

## Data/contract
### Adapter trait (`bloblex-agent-core`)
Add a defaulted method to `AgentAdapter`: `async fn steer(&self, handle: &SessionHandle, req: SteerRequest) -> Result<SteerOutcome, AdapterError>` returning `Err(AdapterError::Unsupported("steering is unavailable for this runtime"))` by default. `SteerRequest { turn_id: String, text: String }` (daemon turn id; text only, no attachments). `SteerOutcome` is `Accepted` or `Stale` (the provider says the expected turn is no longer active).
### Codex adapter
Implement `steer` with `turn/steer`, addressed by the thread id and the **provider turn id** the adapter already tracks for the active turn (`expectedTurnId` or the schema's equivalent). A provider "turn is not active / mismatch" error maps to `SteerOutcome::Stale`; other JSON-RPC errors map to `AdapterError::Rejected`/`Process` like existing calls. Emit nothing else: the daemon records the message.
### Capability and gate (`bloblex-daemon`)
- Add `steer` to the runtime capability table (`runtime_capabilities`, the `table` per provider): `codex` => supported true, scope `turn`, evidence `"none"`; `claude` and `opencode` => supported false with reason "setting is unsupported by this runtime". Gate key `exec_gate.codex.steer`, **default false** (add to the seeded gates list and the `gate_default` logic the same way other gates are; check that `settings.set` accepts the key as a boolean like other `exec_gate.*` keys).
- RPC `session.steer {sessionId, text}`:
  1. Validate: session exists, not archived, not a side conversation (`read_only`), text 1..=100000 bytes after trim, else `invalid_argument`.
  2. `unsupported` if the provider is not Codex or the capability is unsupported; `unsupported` with message "Steering is turned off for this runtime." if the gate is disabled.
  3. Requires an active turn: if there is none, return `conflict` ("Nothing is running to steer.").
  4. Call `adapter.steer`. On `Accepted`: append the text as a user message on the active turn with `meta = {"kind":"steer"}` using the same helper/emission shape `session.prompt` uses for user messages (so it appears as a normal user message and persists), return `{"steered":true,"turnId":...}`.
  5. On `Stale`: fall back to the 2A queue: add the text as a plain queued item at position 0 (same validation as `session.queue.add`), return `{"steered":false,"queued":true,"item":{...}}`. Never drop the user's text.
  6. On adapter errors: return the mapped `DispatchError` and leave the turn running untouched.
- Steering never changes the permission mode, never cancels the turn, and serialises with the per-session gate lock so it cannot race turn completion.

## Tests (required; deterministic, existing fakes)
Extend `fake_codex_server` with a `turn/steer` handler and flags for: accept, stale ("turn not active"), reject. Cover:
1. Adapter: accepted steer sends the schema-exact request (assert method and params shape), returns `Accepted`; stale returns `Stale`; reject returns an error; default adapters (Claude, ACP fake) return `Unsupported`.
2. Daemon: gate off => `unsupported` with the specified message; gate on + Codex + active turn => message persisted with `meta.kind == "steer"` and a `message.completed`-style event; no active turn => `conflict`; stale => queued item at position 0 and `queue.changed` emitted; Claude/OpenCode runtime => `unsupported`; side conversation => `read_only`.
3. Capability table reports `steer` per provider with `evidence: "none"` and `enabled` following the gate.
4. All pre-existing tests pass unchanged.

## Evidence file
Create `docs/evidence/codex-turn-steer-2026-10-12.md`: the schema paths and field names you used, what the fake proves (request shape only), and an explicit **Not verified live** section (acceptance by a real Codex turn, behaviour when the turn is in a tool call, ordering relative to streamed output).

## Gates (run and report real output)
```
CARGO_TARGET_DIR=D:/b-p1 RUST_MIN_STACK=33554432 cargo test -p bloblex-storage -p bloblex-daemon -p bloblex-agent-core -p bloblex-adapter-claude -p bloblex-adapter-codex -p bloblex-adapter-acp
```

## Final report (plain text, last message)
1. Files changed. 2. Per section: what you did and exact test names. 3. Gate summary per crate. 4. Anything unverified, spec/source mismatches, and declined items. Fake-peer verified only; no live-CLI claim.

## Fix-ups from the Phase 2A review (do these first, with tests)
1. **Failed items could never be retried.** `Storage::queue_claim` only claims `status='queued'`, so `session.queue.send_now` on a `failed` item returns `conflict`. The UI offers "Try again" for failed items and the 2A spec said failed items can be sent with `send_now`. Make `queue_claim` also claim `failed` rows (clear `error` when claiming), keep position, and add a daemon test: a failed item sent with `send_now` on an idle session succeeds and is removed.
2. **A transient "turn already active" conflict must not fail the item.** In `send_claimed`, when `session_prompt` returns a `conflict` error (the session became busy between the idle check and the send), put the item back to `queued` (same position, no `failed`, no pause) instead of `queue_mark_failed`. Other errors keep the current failed + paused behaviour. Add a daemon test that forces the conflict and asserts the item stays queued, unpaused, and is sent at the next completed turn.
