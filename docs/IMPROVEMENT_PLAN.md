# Bloblex improvement plan v2: a BB-informed, companion-style roadmap

Status: approved by the owner, 12 October 2026. **Phase 1 is implemented on branch `phase1-lifecycle` and fake-peer verified only** (specs: `IMPROVEMENT_PHASE_1A_SPEC.md`, `IMPROVEMENT_PHASE_1B_SPEC.md`; evidence: `evidence/recovery-hints-2026-10-12.md`). It has no live-CLI or native-window verification yet. Later phases still need their own go-ahead. Baseline `17591b9` (beta.18). Supersedes the QA draft, kept as [IMPROVEMENT_PLAN_v1_qa-draft.md](IMPROVEMENT_PLAN_v1_qa-draft.md).

## Context

The owner wants Bloblex to be a Grok-Bot-style companion that reuses the coding-agent CLIs already installed and logged in on the user's PC (Claude Code, Codex, OpenCode). The owner asked me to read `get-bb/bb` (MIT, "the agent IDE that builds itself", ~40 plugins) and borrow what fits, then produce an improved plan. This replaces the QA lane's `docs/IMPROVEMENT_PLAN.md` (v1), which was ~1/3 stale against HEAD (`17591b9`, beta.18) and framed everything as "match BB".

Owner decisions: (1) lead with ALL four themes: proactive companion, memory and persona, reliability, interaction polish; (2) ChatGPT transcription via the Codex login is approved as an exception to the "no copied provider authentication" invariant, but **opt-in, on-device stays default**, with consent and automatic fallback.

Sources: BB read remotely (provider layer, ~25 feature plugins, dictation, desktop UX, Windows notes) and Bloblex code verified by grep/read. BB claims are from reading its source; none were run.

## What Bloblex already has (do not re-plan)

Per-model effort catalogs incl. Codex `ultra` and CLI-gated Claude `ultracode`; validated/fallback catalog gating; ask/auto/bypass modes (Codex bypass = `danger-full-access`); usage/quota/context meters; runtime health discovery; session resume; team delegation + side conversations over an app-owned MCP bridge (`bloblexd mcp-bridge`, `crates/bloblex-daemon/src/mcp_bridge.rs`, tools in `team.rs` ~L132); Claude and Codex native question cards in chat and island; per-blob `instructions`; tray, global shortcuts, notifications; on-device dictation; opt-in experiments framework; additive SQLite schema (v12).

**Found while verifying:** budgets are retired (`main.rs:943`, so `AGENTS.md` still mentioning them is stale); the timeout path never calls `team::after_turn` (`main.rs` ~L2415-2440, so queued deliveries stall); the 45s/300s watchdog (`main.rs:2306`) does not pause for a pending permission or question; Codex's fresh-thread resume fallback is silent (only Claude emits `ContextReset`); no queue/steer, keep-awake, memory, scheduler or ask-user shim exists.

## Not taking from BB

Account-pool proxy (credential custody), workflows (QuickJS fan-out), browser-automation, GitHub panel, editors, worktree/sandbox environments, connect/tunnel/mobile, Claude Agent SDK (TypeScript; Bloblex already speaks stream-json). Credential-free profile rotation (alternate `CLAUDE_CONFIG_DIR`/`CODEX_HOME`) is deferred. v1 items already done are dropped: A1, A3, B4, D1, D2, D4.

## Execution model (owner directive: delegation pipeline)

**Lanes.** Heavy non-UI coding goes to OpenCode Go `opencode-go/deepseek-v4.1-flash` at high effort. Anything that touches UI or UX is done by me (Claude, the Director), following `DESIGN.md`/`PRODUCT.md` and the existing blob/island language.

| Lane | Owns | Does not touch |
|---|---|---|
| OpenCode DeepSeek flash (high) | Rust daemon/adapters/storage/speech crates, `src-tauri` native code (keep-awake, speech backend), schema, scheduler, retry, memory store + MCP tools, replay harness, RPC/event contracts, non-visual TS (types, hooks, bridge/fixture data), backend tests | Any rendered component, styles, copy, motion |
| Claude (Director) | React components, island/companion, settings screens, cards, onboarding UI, blob visuals, copy, mounted UI tests, `App.tsx` edits; review of every OpenCode diff; commits | Backend implementation (except trivial fixes found in review, routed back) |

**Mechanism.** `opencode run -m opencode-go/deepseek-v4.1-flash --variant high --dir <task worktree> --format json --title <task> -f <spec.md> "<short brief>"` (flags read from `opencode run --help`, 1.18.35). Specs go in a file, not argv. Each backend task runs in its own git worktree; I review the diff, run gates, then commit. OpenCode never runs `git commit`, and `--auto` is not used unless approved after a trivial-task smoke test shows how headless permission prompts behave (unverified today).

**Contract first.** Before a phase starts I write a short spec: RPC names, event payload shapes, DTO fields, failure copy. OpenCode builds the backend against it; I build the UI against `apps/desktop/src/preview/fixtureBridge.ts` fixtures in parallel, then we integrate. Backend phases stay sequential (they all touch `main.rs`), so there is one writer per file set; UI work lands in the main checkout.

**Independent review.** DeepSeek must not grade its own work. Backend diffs get my review plus a read-only second opinion from a different lane (Cursor `grok-4.7-high` via `scripts/run-cursor-delegate.ps1`, as in the current pipeline). `scripts/live-checks/live-opencode-effort.mjs` already exists and covers the OpenCode effort round-trip probe.

**Docs follow.** `AGENTS.md` still says the Director never writes production code and that QA is the OpenCode lane. It gets amended to this model (plus the dictation exception) as part of the first deliverable.

### Lane split per phase
| Phase | OpenCode (backend) | Claude (UI/UX) |
|---|---|---|
| 1 Lifecycle | `finish_turn_failed`, hints, delivery facts, `session.replaced` | "Context was reset" divider, timeout copy |
| 2 Queue/steer | storage, `queue.rs`, RPCs, Codex `turn/steer`, fake server | Composer-during-turn, queue banner, Send-later popover, island composer |
| 3 Retry/replay | `retry.rs`, replay harness, wire fixtures | Retry notice with Cancel, experiment toggle |
| 4 Automations | schema, `scheduler.rs`, RPCs, clamps, keep-awake thread, tool filtering | Schedule tab, run history, island badge, Settings list, notification-level UI |
| 5 Memory | schema + FTS, MCP tools, rails, catalog prefix | Settings → Memory, per-blob "Remembers", review/approve flow |
| 6 Questions/hand-off | `ask_user` shim, `session.handoff`, answer routing | Question card variants, hand-off draft UI, onboarding state-machine UI |
| 7 Cloud dictation | `cloud.rs`, `speech.rs` backend, errors, tests | Consent dialog, engine indicator, Settings engine selector |

## Phases (order follows dependencies)

### 1. Lifecycle hardening (reliability core), M
- Extract one `finish_turn_failed()` from the three failure sites in `crates/bloblex-daemon/src/main.rs` (Error ~L2716, spawned-prompt Err ~L2200, timeout ~L2422); call `team::after_turn` on timeout; pause the inactivity timer while a permission/question is pending.
- `bloblex-agent-core`: new `AgentEvent::RecoveryHint{hint,retry_after}` (typed: authRequired, rateLimited, overloaded, restartRecommended, staleTurn) instead of text matching. Claude emits from the `result` branch and `api_retry`; Codex from `turn/completed` errors. Codex fresh-resume and Claude restart emit `ContextReset`; daemon emits `session.replaced{reason,contextLost}` plus a transcript notice via `team.rs` `note()`.
- Record per-turn `delivery` (`not_sent|acknowledged|unknown`) in `turns.data` (no migration). Acknowledged = Claude first stream event after stdin write; Codex `turn/start` result; ACP first `session/update`.
- UI: "context was reset" divider, honest timeout copy. Tests: extend the three `forward_events_with_timeouts` tests; reuse `fake_codex_server` `crash-reject`; add a fake_claude rejected-resume flag.

### 2. Durable queue, "send later", steer, M-L
- `crates/bloblex-storage`: `queued_prompts` via the idempotent `ensure_*_schema` pattern (like `ensure_team_schema` ~L396, no version bump). New `queue.rs` absorbs the in-memory `Team.queued` (`team.rs:34`) and its drain in `after_turn`.
- RPCs `session.queue.add|list|update|reorder|delete|send_now`, `session.steer`; event `queue.changed`. Startup settles `sending` rows. A queue never changes the permission mode; attachments revalidated at send.
- Steer maps honestly per adapter: **Codex** `turn/steer{expectedTurnId}` (stale falls back to queue); **Claude and ACP** queue-only until a live capture proves otherwise. Gate via a `steer` row in `runtime_capabilities` (`main.rs` ~L1407) + `exec_gate.codex.steer`, default off, evidence `none`.
- UI (`apps/desktop/src/ui/App.tsx` ~L1941/1952): composer stays enabled during a live turn, Enter queues, Stop is its own button; queue banner (reorder/edit/delete); "Send later" presets with countdown card, also in the island composer. Missed-while-off sends on next start labelled "late by X".

### 3. Safe auto-retry and replay harness, M
- `retry.rs`, behind `experimental.autoRetry` (default off). Overload: 5s·2^(n-1)+jitter, max 5. Rate limit: only with a known reset (reuse `quota.rs` `resets_at`), capped by a `retry.maxWait` setting. Auth/billing/context/permission/cancel/unknown: decline with a stored explanation.
- **No double-send:** `not_sent` resends the prompt; `acknowledged` sends "Please continue."; `unknown` declines. One retry per original (`turns.data.retryOf` + in-flight set); enters the Phase 2 queue as `kind=retry`, never steers; reuses the locked model/effort/mode. Events `turn.retry_scheduled|declined` with Cancel.
- Replay harness (BB `provider-parity` idea): `--replay` mode on `fake_claude`, `fake_codex_server`, `fake_acp_peer`; redacted NDJSON under `crates/*/tests/wire/`, stamped with CLI version; dev-only `BLOBLEX_WIRE_RECORD` reusing the credential markers in `safe_provider_error_detail`.

### 4. Proactive companion: automations and presence, L
- Data: `automations(agent_id,name,prompt,cron,tz,once_at,mode,enabled,next_run_at,consecutive_failures,max_runtime_s,created_by)`, `automation_runs(...)` with a partial unique index for single-flight; `agents.notification_level` (all|input|muted).
- `scheduler.rs` spawned in `run()` beside the deletion loop (~L2902); 1s tick for send-later, 10s sweep for automations; cron + IANA tz (`chrono-tz` present, add a cron crate). **Missed runs coalesce into one** (next run recomputed from now). Overlap = `skipped`. Failures retry at 30s/60s; 3 consecutive pause it visibly. Startup settles interrupted runs next to `recover_after_restart()` (~L2862).
- **Safety (budgets no longer exist, so automations bring their own):** `max_runtime_s` default 30 min via `adapter.cancel`; `automations.maxConcurrent` default 1 under the existing cap of 4; global pause wired to tray "Pause all". Unattended runs pin `modelLock.approvalMode`, clamp bypass to auto, default to plan; an unclassified permission is auto-denied with an audit event. Run sessions carry `link.kind="automation"` and their MCP tool list drops `message_blob` and scheduling tools (recursion guard; make `team::tools()` take the link, generalize `is_team_tool_permission` ~L1132).
- Presence: notifications honour per-blob level and `automation.run.finished` (`App.tsx` ~L520-546); opt-in `power.keepAwake` via `SetThreadExecutionState` on a parked thread in `src-tauri/lib.rs`, requested by a daemon `power.wanted` event. UI states plainly: "Runs only while Bloblex is running and awake; missed runs coalesce; lid-close/user sleep is not blocked."
- UI: per-blob "Schedule" tab with run history, island badge, Settings list.

### 5. Memory and persona, L
- Tables via `ensure_*_schema`: `memory_records(scope blob|project|shared, kind, title, body, tags, importance, pinned, origin user|agent, source_session_id, reviewed, version, deleted_at)` + FTS5 (assert availability in a unit test).
- Tools on the existing bridge: `memory_search|get|write|update|forget` (extend `team::tools()` + `mcp_rpc`; auto-allow like the existing `bloblex` tools). Bounded catalog (~3.9k chars, summaries only) delivered as a **per-turn prompt prefix like `reference_context` (~L2190)**, not via instructions, so a memory write never changes the instruction hash; re-sent only when its hash changes or context was replaced.
- Rails: size/writes-per-turn caps; reject credential markers (move the list into `bloblex-security`) and injection phrases/`<bloblex_` tags; `expected_version` on update; soft delete; agent-written shared records show "new, unreviewed" and post a `note()`; automation sessions write blob scope only.
- Persona: add `profile.about` (<=1.5k) in `runtime_instructions` next to `user_name` (`team.rs:84`); per-blob persona is the existing `instructions` field. UI says Codex persona edits need a new conversation.
- UI: Settings → Memory (search, filter, edit, delete, approve, source link), per-blob "Remembers" tab.

### 6. Questions, hand-off, onboarding, M
- Ask-user shim only where no native tool exists (OpenCode; Codex default mode if `request_user_input` is plan-only): non-blocking `ask_user` MCP tool (1-4 questions, 2-4 options, "Other") persists a card via `insert_question`, ends the turn, answer arrives as next prompt through the queue. Card stays visible when the session is `completed`; expiry 30 min-7 days; expired never reads as answered.
- Hand-off: `session.handoff{fromSessionId,toAgentId}` makes a new session with `link.kind="handoff"` and a bounded excerpt (reuse `prepare_reply_snapshot`), left as a draft; UI states what was and was not carried.
- Onboarding: turn the numeric `step` in `FirstRunOnboarding.tsx` into a typed machine (checking, ready, signIn, install, update, installFailed) reusing `launchChecks`.

### 7. Cloud dictation (approved exception), M, independent
- `crates/bloblex-speech/src/cloud.rs`: read `$CODEX_HOME`/`~/.codex` `auth.json` read-only and fresh per call; `tokens.access_token` + account id (`tokens.account_id` else JWT claim `https://api.openai.com/auth`.`chatgpt_account_id`); redacting `Debug`, `zeroize`, never persisted or logged. POST `https://chatgpt.com/backend-api/transcribe` multipart (`file`, `model=gpt-transcribe`, optional `prompt`), headers `Authorization`, `chatgpt-account-id`, `originator`, `User-Agent`; 65s timeout, 20 MiB cap, parse `{text}`. API-key mode falls back to `api.openai.com/v1/audio/transcriptions`. Typed errors: AuthRequired(401, "run `codex login`"), RateLimited, Unavailable, Challenged (403 `cf-mitigated`: fall back, **no cookie replay**), TooLarge.
- Wire into `apps/desktop/src-tauri/src/speech.rs` `run_worker` (~L335) as `Backend::{Local,Cloud}`: buffer 16 kHz PCM, upload on Stop, on any failure feed the same buffer to the local engine. Reuse the existing `SpeechProvider::OpenAi` manifest variant (no download).
- Settings: `speech.engine = local|automatic|cloud`, **default `local`**; `speech.cloud.consent` set via a dialog listing what is read and sent; status-only `engine` event (on-device / chatgpt) for the indicator; never log audio, transcripts or tokens.
- **Process:** amend `AGENTS.md` invariants with this one explicit, scoped exception so the audit trail matches.

## Cross-cutting rules
- OpenCode never commits; I review diffs and commit after gates. Every phase ships with fake-peer tests; label results independent evidence / implementer report / source-only / unverified.
- Update stale docs as part of Phase 1: budgets retired, `ensure_*_schema` pattern, delivery facts.
- Keep unknown honest: Claude/ACP steer, Codex `turn/steer` and ChatGPT WAV acceptance stay `unproven` in capabilities until live-captured.

## Open questions that need a live probe (not resolvable from code)
1. Claude: does a second mid-turn stdin user message yield one `result` or two? (decides steer for Claude)
2. Codex: is `turn/steer` present on the installed CLI (0.162.1)? Is `request_user_input` plan-mode only?
3. OpenCode: any native question tool over ACP? Does the effort round-trip prove behavior (still gates `exec_gate.opencode.thinking`; flip it after this probe; also discover the effort option by `category=thought_level`)?
4. ChatGPT transcribe: accepts WAV (BB sends webm)? Behaviour under Cloudflare, 401, 429.
5. Product call: inject unreviewed *shared* agent-written memories, or only after approval? (recommend: approval required for shared, blob-scope immediate)

## Verification

- Per phase: `cargo test --workspace` (offline, excluding desktop), desktop typecheck + Vitest + web build, native desktop lib check, NSIS bundle (the existing gates in `SESSION_HANDOFF.md`).
- New deterministic tests per phase as listed (DST next-run, coalesce/overlap, bypass clamp, recursion, FTS/rails, retry decision table incl. `delivery`, queue drain/startup settle, replay wire diffs, JWT parse/redaction/fallback for cloud dictation).
- Live (isolated database, never the user's data): kill provider mid-turn → divider; quota exhaustion → retry; scheduled run fires and coalesces after sleep; keep-awake via `powercfg /requests`; memory catalog lands in the prompt on all three CLIs; one real dictation pass, local and cloud.

## Deliverable on approval
Write this plan to `docs/IMPROVEMENT_PLAN.md`; move the QA draft to `docs/IMPROVEMENT_PLAN_v1_qa-draft.md` (it is untracked, so preserve it); amend `AGENTS.md` (dictation exception, budgets retired, the lane model above). No production code changes until a phase is separately approved; Phase 1 is the first candidate, starting with a lane smoke test on a trivial task.
