# Phase 6A spec: ask-the-user tool for OpenCode, hand-off draft and notification level (backend)

Owner: OpenCode lane (backend only). Reviewer: Director. Parent plan: `docs/IMPROVEMENT_PLAN.md` Phase 6. Builds on Phases 1-5 (durable queue, MCP bridge tool list, session links). The UI is built by the Director against this contract; do not touch `apps/`.
Scope: `crates/bloblex-storage`, `crates/bloblex-daemon` (`team.rs`, `main.rs`, `queue.rs`), `docs/`. No new dependencies.

## Rules
- Work only in this worktree. **Never run `git commit`, `git push`, `git checkout`, `git stash`.** Leave changes uncommitted. Attach/read only files inside this worktree.
- Cargo: `CARGO_TARGET_DIR=D:/b-p1` and `RUST_MIN_STACK=33554432` (one daemon test overflows the default stack on the base commit; pre-existing).
- Match repo style. No `unwrap()` in non-test code you add. Never log answers, prompts or raw provider JSON.
- An unanswered or expired question must **never** read as answered. When unsure, keep it pending/expired and say so.
- Existing behaviour not listed here must stay identical. Claude Code keeps its native `AskUserQuestion` path and Codex keeps its native `item/tool/requestUserInput` path; this phase must not change either.

## Part 1: `ask_user` MCP tool (non-blocking)
Why: OpenCode over ACP has no question tool of its own. The bridge's tool call times out at about 60 seconds, so the tool cannot wait for the human.
- Register `ask_user` on the existing bridge **only for sessions whose provider is `opencode`** (and never for `automation` or side-conversation sessions). Input: `{title?: string (<= 120), questions: [{header (<= 40), question (<= 400), options: [{label (<= 80), description? (<= 200)}] (2..=4), multiSelect?: bool, allowOther?: bool}] (1..=4)}`. Reject anything else with a clear tool error.
- Behaviour: persist the question using the same storage function and DTO the native question path uses (`insert_question`; see the `QuestionRequested` arm in `forward_events_with_timeouts`), with `provider_request_id = "mcp:<uuid>"`, then emit the same `permission.requested` event with `kind:"question"`. Return immediately to the agent with the text: `Your question was shown to the user. End your turn now. Their answer will arrive as your next message.` Do **not** set the session to `waiting_permission` (the turn finishes normally), and do not block.
- Pending cards must survive the turn ending and daemon restarts (they are rows already). Give them an expiry: `expiresAt` = now + 24 hours (setting `questions.expirySecs`, integer 1800..=604800, default 86400). A sweep (reuse an existing periodic loop) marks expired rows `expired`, emits `permission.changed`/the existing resolution event with status `expired`, and posts a transcript notice `A question expired without an answer.` meta `{"kind":"question_expired"}`. An expired card can no longer be answered (`conflict`).
- Answering: in the existing `permission.reply` path, when the question's `provider_request_id` starts with `mcp:`, do **not** call the adapter. Instead build the follow-up prompt `The user answered your question.\n\n<header>: <answer>\n...` (answers only, bounded to 2000 chars, "Other" text included), mark the question answered, and deliver it as a normal user prompt through the Phase 2 queue: send immediately when the session is idle, otherwise enqueue at the front as a plain queued item. A dismiss (`answers: null`) records `dismissed` and sends `The user dismissed your question without answering.` the same way. The answer message must be stored with `meta {"kind":"question_answer","questionId":...}`.
- The existing UI contract for question cards must not change: the same `permission.requested` payload and the same reply RPC. The only visible differences are that the session may be `completed`/`idle` while the card is pending, and that `expiresAt` is set.

## Part 2: hand-off draft
- Bloblex keeps one main conversation per blob, so a hand-off must **not** create a new session. RPC `session.handoff.draft {fromSessionId, note?}` is read-only: it validates the source (`not_found` for missing/archived, side conversations are allowed as a source) and returns `{draft, carried:{messages:N, truncated:bool}, fromAgentId, title}`.
- `draft` is a ready-to-edit first message for another blob: `Continue from <source blob>'s conversation "<title>".` followed by `note` when present, then a bounded excerpt of the source transcript (the last 8 user and assistant messages, each clipped to 600 characters, whole excerpt at most 4000 characters, oldest first, thinking and notices excluded, never tool output or file contents). Reuse the excerpt/snapshot helper behind quoted replies if it fits; otherwise write a small one.
- It stores nothing and sends nothing. The UI selects the target blob's own conversation and places `draft` in its composer for the user to edit and send.

## Tests (required; deterministic)
`ask_user`: tool listed only for `opencode` main sessions; validation bounds; card persisted with `mcp:` id and `expiresAt`; session state not `waiting_permission`; reply while idle sends one prompt with the answers and marks the card answered; reply while busy queues at the front and sends at the next completed turn; dismiss path; expiry sweep marks `expired`, posts the notice, and a later reply returns `conflict`; Claude and Codex question paths unchanged (existing tests). Hand-off draft: read-only (no session or message rows change), draft contents and bounds (message count, clip lengths, exclusion of thinking/notices/tool output), `not_found` for missing/archived sources.

## Gates (run and report real output)
```
CARGO_TARGET_DIR=D:/b-p1 RUST_MIN_STACK=33554432 cargo test -p bloblex-storage -p bloblex-daemon -p bloblex-agent-core -p bloblex-adapter-claude -p bloblex-adapter-codex -p bloblex-adapter-acp
```

## Final report (plain text, last message)
1. Files changed. 2. Per section: what you did and exact test names. 3. Gate summary per crate. 4. Anything unverified, spec/source mismatches, decisions where the spec was silent. Fake-peer verified only; whether OpenCode actually calls a bridge tool named `ask_user` has not been seen live.

## Part 3: per-blob notification level (small)
- Add a nullable `agents.notification_level` column via the same idempotent additive-schema pattern used for other agent columns (`ensure_*` helper, not a ledger bump). Values: `all`, `input`, `muted`; `NULL` means `all`.
- `agent.create` / `agent.update` accept `notificationLevel` (string or null), validate it, and include it in the agent DTO and the `agent.changed` event; `agent.list`/`agent.get` return it (null normalised to `"all"`).
- Meaning (enforced by the UI, documented here): `all` = finished turns, questions, approvals and errors; `input` = only questions and approvals (things that need the user); `muted` = nothing. Automation runs follow the blob's level.
- Tests: column added idempotently to an existing database; create/update validation (bad value -> `invalid_argument`); DTO and event carry the field; export/import of a blob setup is unchanged (do not add the field to shared blob files).

## Part 4: automation sessions are never a blob's main conversation (small, mandatory)
Sessions linked `{"kind":"automation"}` (created by Phase 4A) carry the blob's `agentId`. Bloblex keeps one main conversation per blob, so the daemon must never pick an automation session as that blob's main conversation:
- `agent.conversation` (and any helper it uses, e.g. the "newest open non-side session" selection) must skip sessions whose link kind is `automation` (and `handoff`, if any exist from earlier drafts), the same way it skips `side`. When the blob has no other session it creates one as today.
- `agent.list`/snapshot summaries that report a blob's "current conversation", unread/attention state or `busy` must not let an automation session replace the main conversation. A running automation may still make the blob count as working; keep that behaviour if it already exists.
- Tests: a blob with an old main conversation and a newer automation session still returns the old one from `agent.conversation`; with only an automation session it creates a fresh main conversation; archived/deleted cases unchanged. Also assert side-conversation behaviour is unchanged.
