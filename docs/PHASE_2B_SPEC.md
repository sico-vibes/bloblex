# Phase 2b specification: execution options per blob

This is the implementation contract for Phase 2b of [E2E_PLAN_V2.md](E2E_PLAN_V2.md). Phase 2a stores blob identity and execution-shaped fields; Phase 2b makes fields effective only after per-runtime gates pass. Current inert agent columns and RPCs are in crates/bloblex-storage/src/lib.rs:79-86,226-278; current adapter requests contain only session/path or turn/text at crates/bloblex-agent-core/src/lib.rs:50-70; daemon paths are crates/bloblex-daemon/src/main.rs:470-558,561-664,666-793.

## 1. Scope, gates, and honest capability reporting

Implement backend execution options and per-turn evidence for Claude stream-json, Codex app-server, and OpenCode ACP; model catalogs and validation; safe child environments; execution snapshots; per-agent/global active-turn limits; normalized usage persistence. Phase 2a session.new accepts agentId or legacy runtimeId and persists the selected link (docs/ipc-contract.md:64; crates/bloblex-daemon/src/main.rs:470-558; crates/bloblex-storage/src/lib.rs:350-363). Usage attribution already reads agent_id from the persisted session (crates/bloblex-storage/src/lib.rs:387).

Out of scope: UI enabling of the execution card (later task); Phase 4 permissions, Phase 5 analytics, Phase 6 settings, Phase 7 native/release work. Add only read-only snapshot/catalog RPCs for later consumers. Never touch the live inspection database or sidecars.

### Gate model

Adapter capability response per runtime: settings map for model, thinking, serviceTier, instructions, customEnv. Each reports {supported,enabled,scope,evidence,reason?}; scope is spawn/resume/turn/process; evidence is none/request_shape/provider_echo/usage_effect/successful_turn. Unsupported means false/false. Request shape alone means supported true, enabled false. Sending an argv/RPC/env value is requested, never applied. The only accepted applied evidence is: Claude modelUsage key for model (provider_echo), successful-turn usage.output_tokens_details.thinking_tokens behavior for effort (usage_effect; indirect evidence), Codex catalog-validated request plus successful turn plus thread/start echo (provider_echo; `fast` normalized to `priority` is real server resolution), and OpenCode session configOptions currentValue plus successful turn (provider_echo). Instructions require the successful sentinel behavior described below. An echo by itself is never proof of success.

Director-controlled flags are settings keys exec_gate.<provider>.<setting>, boolean values: claude.model, claude.thinking, claude.instructions, codex.model, codex.thinking, codex.serviceTier, codex.instructions, opencode.model, opencode.thinking, opencode.instructions. Migration 3 seeds these ten keys using `INSERT OR IGNORE INTO settings(key,value) VALUES (?1,?2)` with the key and lowercase JSON boolean text bound per row: `true` for claude.model, claude.thinking, claude.instructions, codex.model, codex.thinking, codex.serviceTier, codex.instructions, opencode.model, opencode.instructions; `false` for opencode.thinking. Existing operator-edited values are preserved by INSERT OR IGNORE. This seed reflects the successful live checks on 2 Oct 2026 with Claude Code 2.1.286, codex-cli 0.159.3, and OpenCode 1.18.34 (docs/runtime-capabilities.md:204-251). If a CLI version changes, re-run scripts/live-checks/ and reassess the gates; a regression may require flipping a gate off. No Claude/OpenCode service-tier gate and no customArgs gate. Daemon computes enabled = adapter_supported && gate_true. No new RPC sets a gate. The existing generic settings.get/settings.set expose these keys; settings.set accepts arbitrary non-secret keys, so any authenticated client can change them. Special-case exec_gate.* writes to require a JSON boolean. This is acceptable because gates are a process-safety switch for the single local user, not a security boundary, and no UI exposes them (crates/bloblex-daemon/src/main.rs:80-110,387-414; crates/bloblex-storage/src/lib.rs:984). Whenever an exec_gate.* value changes, storage must atomically persist and broadcast a settings.changed event {key,enabled}; no-op writes emit no event. No settings.changed event currently exists (crates/bloblex-storage/src/lib.rs:212-225). Director changes a gate only after adding evidence to docs/runtime-capabilities.md.

| Runtime setting | Evidence (2 Oct 2026) | Flag and evidence status |
|---|---|---|
| Claude model | Successful result `modelUsage` contains resolved `claude-haiku-4-5-20251001`; unknown-id turn errors with empty `modelUsage` (docs/runtime-capabilities.md:210-211). | exec_gate.claude.model = TRUE |
| Claude thinking | On sonnet, low yielded 0 and max 45 thinking tokens; use `usage_effect`; hide for rows without effort levels (docs/runtime-capabilities.md:214). | exec_gate.claude.thinking = TRUE for catalog rows with levels |
| Claude instructions | File body was honored; changed resume file was ignored with default snapshot and applied with snapshot off; fresh session applied it (docs/runtime-capabilities.md:210,212-213). | exec_gate.claude.instructions = TRUE |
| Codex model | `model/list` returned 8 visible entries; successful live turn plus catalog-validated request and `thread/start` echo are required; echo alone is not proof (docs/runtime-capabilities.md:220,222-223). | exec_gate.codex.model = TRUE |
| Codex thinking | Listed effort was accepted and reasoning-token behavior observed; unlisted effort was also accepted, so Bloblex must validate against the catalog (docs/runtime-capabilities.md:222-223,246). | exec_gate.codex.thinking = TRUE with catalog validation |
| Codex service tier | `priority` echoed; old `fast` normalized to `priority`; unknown tiers are accepted by Codex, so Bloblex validates the catalog (docs/runtime-capabilities.md:222-223). | exec_gate.codex.serviceTier = TRUE with catalog validation |
| Codex instructions | Start instructions applied and persisted across resume without the field; changed resume instructions were ignored and require a new thread (docs/runtime-capabilities.md:221). | exec_gate.codex.instructions = TRUE for new threads |
| OpenCode model | Real-profile session options listed 52 model values; model selection stuck and successful turn completed (docs/runtime-capabilities.md:230,232). | exec_gate.opencode.model = TRUE |
| OpenCode thinking | Selectable and echoed, but no behavioral proof of effort effect (docs/runtime-capabilities.md:234,249). | exec_gate.opencode.thinking = FALSE |
| OpenCode instructions | Custom agent instruction was followed on both turns when its mode was selected; control without the mode ignored it (docs/runtime-capabilities.md:230-231). | exec_gate.opencode.instructions = TRUE |

A requested non-null setting with gate off or unsupported capability fails closed with unsupported before provider prompt submission; safe message is “The requested setting is unavailable for this runtime until its execution check passes.” A session-scoped rejection (session.new/resume) persists only exec.options.rejected {sessionId,agentId,runtimeId,setting,code,reason}, creates no turn/snapshot, and fails the RPC; for session.new, do not persist a sessions row, and for resume leave the existing session unchanged. A turn-scoped rejection discovered before user prompt delivery creates a failed turn/message/rejected snapshot and event atomically, marks the turn error, and creates no reservation. If a provider rejects after any user-prompt bytes may have been sent, treat it as an ambiguous post-send error instead. Send an option only when its gate is enabled; never retry after dropping it. Where proof can only arrive in a successful result, applied remains null until that result; contradictory evidence marks the turn error. Never claim applied on a constructed request alone. Null means runtime default. On a live setting rejection, persist false to the provider/setting exec_gate key (disabling that provider setting across its runtime instances) and append settings.changed atomically; capability reporting for the affected runtime immediately reports enabled:false. False gates and unsupported capabilities remain fail-closed.

## 2. Core types and request flow

Add to crates/bloblex-agent-core:

    #[derive(Clone, Debug, Serialize, Deserialize)]
    #[serde(rename_all="camelCase")]
    pub struct ExecOptions {
        pub model: Option<String>,
        pub thinking: Option<String>,
        pub service_tier: Option<String>,
        pub instructions: Option<String>,
        pub extra_args: Vec<String>,
        pub env: BTreeMap<String, String>,
        pub max_concurrency: u32,
    }
    impl Default for ExecOptions {
        fn default() -> Self {
            Self { model: None, thinking: None, service_tier: None,
                   instructions: None, extra_args: vec![], env: BTreeMap::new(),
                   max_concurrency: 1 }
        }
    }

Nullable fields mean runtime default; empty instructions normalize to None. extra_args defaults empty and is rejected when nonempty because all Phase 2b allowlists are empty. max_concurrency is daemon metadata from agent, default 1, not provider input. Serialize camelCase; internal adapter calls carry explicit nulls. Add exec_options to NewSessionRequest, ResumeSessionRequest, PromptRequest. Serde defaults the whole field for older callers; session.new RPC params stay unchanged.

At session.new resolve agent row and construct options from persisted columns. Resume reloads current agent row. Each turn reloads the row for turn-scoped settings, so agent.update affects later turns only; provider thread/session instruction semantics below govern when changed instructions can take effect. Legacy agentId:null sessions receive null/default settings, empty env/args, max_concurrency 4 (global-only cap). Existing core structs/trait: crates/bloblex-agent-core/src/lib.rs:50-70,138-160. Daemon dispatch/new/resume/prompt: crates/bloblex-daemon/src/main.rs:232-249,470-664,666-793.

## 3. Adapter contracts

Each adapter emits normalized SettingOutcome {requested,applied,evidenceKind,evidenceValue?,reason?}. applied is nullable; false=rejected, null=no provider evidence. Parse evidence to normalized values; raw provider JSON never reaches React. A session-scoped rejection creates no snapshot and only a persisted exec.options.rejected event. A turn-scoped rejection proven before prompt bytes are sent creates a rejected turn snapshot atomically with its error state and event, without a reservation. Never retry after dropping the option.

### Claude stream-json

Current fixed stream-json permission launch, resume identity and stdin prompt are at crates/bloblex-adapter-claude/src/lib.rs:202-221,381-395 (C6 CONFIRMED current source mapping). Append typed arguments after fixed protocol/permission flags and before resume identity, in order: --model <id>; --effort <id>; --append-system-prompt-file <absolute-private-path>; --system-prompt-snapshot off only when the stored instruction hash for this session differs from the agent's current instruction hash. Otherwise use the default snapshot to preserve the prompt cache. The live snapshot-off turn wrote roughly 9k prompt-cache tokens (docs/runtime-capabilities.md:212-214). Never put instruction text in argv or use --system-prompt. If the instruction gate is false, do not send instruction flags.

Chosen resume behavior: respawn provider process on resume with the current instruction file and hash desired instructions each turn; store the hash only. Compare the current hash with `sessions.claude_instruction_sha256`, which tracks the hash last proven applied. If they differ, pass `--system-prompt-snapshot off`; otherwise leave the CLI default snapshot enabled. Update the stored hash only after a successful turn proves the current instruction sentinel. A fresh session uses the current instruction file and default snapshot. The changed-file live test showed default snapshot ignores the update and snapshot off applies it (docs/runtime-capabilities.md:212-213). If launch-scoped model/effort/instruction options change between turns, restart/resume with the new options before sending the next prompt; if that native resume cannot be proven, reject the changed setting. Unknown model/effort diagnostics or contradictory success evidence fail the turn. Successful model evidence must come from a success result's modelUsage key; an init echo is not evidence. Effort evidence is usage.output_tokens_details.thinking_tokens behavior and is recorded as usage_effect (indirect). A failed result is never usage or application evidence; successful result usage semantics are confirmed (docs/runtime-capabilities.md:210-214).

Catalog: stream-json control_request subtype list_models; normalize response. If it fails, return a built-in suggestion list of documented aliases (sonnet, opus, fable) marked fallback:true and hostDependent:true; these are suggestions, not an assertion that this profile resolves them. In fallback mode allow custom IDs rather than rejecting IDs absent from that suggestion list. Request works (C4 CONFIRMED behavior); count/default aliases are host-dependent (C1/C4). No speed/service tier (C5 CONFIRMED behavior).

### Codex app-server

Current launch/RPC fields: crates/bloblex-adapter-codex/src/lib.rs:45-48,159-174,278-309,336-346. The live checks used codex-cli 0.159.3 and confirmed the documented fields and thread behavior (docs/runtime-capabilities.md:216-224).

- thread/start: keep cwd, approvalPolicy:"on-request", sandbox:"workspace-write"; add model, serviceTier if non-null and developerInstructions if enabled. No top-level effort. `config.model_reasoning_effort` was accepted and echoed at start, but the app must still validate effort against its catalog (docs/runtime-capabilities.md:222-223).
- thread/resume: send threadId, cwd, model and serviceTier as needed. Instructions are fixed per thread: `developerInstructions` from thread/start persist across resume; sending them on resume is unnecessary and must not be relied on. Record the hash installed at thread/start in `sessions.codex_thread_instruction_sha256`. If the current agent instruction hash differs from that thread hash, do not claim application: record `applied:false, reason:"instructions_change_requires_new_thread"` in the execution snapshot and emit the options event so the UI can say “applies to new conversations.” Do not replace the stored thread hash on resume. A newly created session/thread uses the new text and records its hash (docs/runtime-capabilities.md:221).
- Each turn/start: {threadId,input:[{type:"text",text}],model?,effort?,serviceTier?,serviceTierForTurn?}. Use catalog ids as-is. "default" serviceTierForTurn means one-turn standard; never send fast/standard as a tier id. No developerInstructions on turn/start (X2/X5 CONFIRMED behavior; per-model availability host-dependent).
- Order: initialize; retrieve/refresh the profile catalog and validate model and serviceTier before thread/start and effort before turn/start; then start/resume, parse response/settings evidence, and send turn/start with text only after successful preflight. Codex accepts unlisted effort values, unknown model ids at thread/start, and unknown tiers, so Bloblex must validate before sending. Successful turn plus catalog-validated request plus thread/start echo is the accepted provider_echo evidence; an echo alone is not application proof. Never retry without option. Never log debug models raw output because it can contain instruction templates (docs/runtime-capabilities.md:222-223).
- Catalog: use paginated model/list only (cursor, includeHidden:false, limit=100), consume data/nextCursor until null. Normalize ids/labels, efforts/default, tier id/name/description/default. The live profile returned 8 visible models while `codex debug models` returned 10 including hidden entries; the app must use model/list, not debug models (docs/runtime-capabilities.md:220). Effort and tier values vary by model/profile; validate each selection against this catalog.

### OpenCode ACP

Current ACP launch/session flow is crates/bloblex-adapter-acp/src/lib.rs:44-53,350-367,386-420,428-440; wrapper re-export is crates/bloblex-adapter-opencode/src/lib.rs:1-5. Live checks used OpenCode 1.18.34. Session options on the real profile exposed the full provider catalog (52 models on this host); counts are host-dependent and must never be hard-coded (docs/runtime-capabilities.md:204,226,230).

Launch each blob process with isolated child environment and Bloblex-generated OPENCODE_CONFIG_CONTENT JSON containing model default and a Bloblex agent with prompt=instructions. Never inherit another blob's config/data/cache/state or OPENCODE_CONFIG_CONTENT (O2 CONFIRMED; catalog profiles host-dependent O1). Do not expose/log the env value.

Call initialize and initialized, then session/new or session/load. Select model first with session/set_config_option {sessionId,configId:"model",value:modelId}, or session/set_model {sessionId,modelId}. Set instructions mode with session/set_config_option {sessionId,configId:"mode",value:agentId}; then inspect options and set {sessionId,configId:"effort",value:thinkingId}. "default" only if ACP returns it as selectable. Re-fetch configOptions after each change. Accepted applied evidence for model, effort and mode is the relevant configOptions currentValue together with a successful turn; record evidence kind provider_echo. Effort remains gated off because selectable/currentValue plus one turn did not establish a behavioral effort effect (docs/runtime-capabilities.md:204,230-234).

On load, order is model, mode, inspect options, effort; rebuild env before process spawn. No tier was exposed in the inspected ACP handshake/help for the documented build (docs/runtime-capabilities.md §Z1, Speed/service tier, line 109); this is not proof that the provider rejects tiers universally. Bloblex rejects a non-null OpenCode serviceTier at preflight with unsupported. Any RPC error/missing option fails before session/prompt. set_model requires modelId (O3 PARTIAL); model selection adds effort option when available (O6 CONFIRMED behavior). initialized method-not-found stderr is harmless (O3 CONFIRMED).

Use ACP session configOptions as the app's model and effort catalog and validation source. It exposed 52 provider models on the live host; counts and rows are host-dependent, never hard-coded. The selected model/effort must appear in the relevant options and currentValue; application evidence also requires a successful turn (docs/runtime-capabilities.md:230-232).

## 4. Allowlists, secrets, instruction files

customArgs MUST be empty for all adapters; reject nonempty with invalid_argument. Typed fields are adapter-owned. Never let user options control protocol, cwd, permissions, sandbox, transport, output format, config source or authentication (empty allowlists: C6/X8/O7 source; relevant item status and Z2 in docs/runtime-capabilities.md).

Explicit customEnv allowlists:
- Claude: LANG, LC_ALL, TZ, NO_COLOR, TERM.
- Codex: LANG, LC_ALL, TZ, NO_COLOR, TERM.
- OpenCode: LANG, LC_ALL, TZ, NO_COLOR, TERM. Bloblex alone constructs OPENCODE_CONFIG_CONTENT and owns isolated config/data/cache/state paths; reject user values for those variables.

Reject keys outside that per-runtime list, case-insensitive TOKEN|SECRET|PASSWORD|KEY|AUTH|CREDENTIAL|COOKIE keys, and NUL values. Never log values or include in errors/events. These are conservative product choices; environment inheritance was not implemented per runtime-capabilities.md:163.

Claude nonempty instructions: create random .txt under %LOCALAPPDATA%\Bloblex\private-tmp (fallback %TEMP%\Bloblex\private-tmp). Directory ACL current-user only; file disables inheritance and grants current-user full control. POSIX fallback 0700 dir/0600 file. Use create-new, UTF-8, flush/close; pass path only; delete on process exit or spawn failure. Startup cleanup only for Bloblex-owned files older than 24 hours with no live process marker. Filename contains no prompt text. Logs/events/errors/snapshots contain neither text nor file body; store SHA-256 only. The file body was honored on a successful live turn (docs/runtime-capabilities.md:210).


## 5. Execution snapshots and migration 3

Every turn gets one snapshot, including a turn-scoped rejected preflight. Session-scoped rejection in session.new/resume creates no turn and no snapshot; persist only exec.options.rejected {sessionId,agentId,runtimeId,setting,code,reason}, then fail the RPC. Migration 3 reuses verified online-backup-before-DDL from migration 2 (crates/bloblex-storage/src/lib.rs:44-66,68-86,146-155; docs/PHASE_2A_SPEC.md:22-32,87-100). Generalize verified_backup to accept expected_pre_migration_version; migration 3 calls it with 2 and verifies the copied ledger is exactly 2. Generalize restore_verified_backup to validate/restore the expected version 2 as well; the existing helper hard-requires a v1 backup (crates/bloblex-storage/src/lib.rs:117-134). The current backup routine hard-requires version 1 at crates/bloblex-storage/src/lib.rs:44-66; current Storage::migrate and migrate_agents reject ledgers above 2 at crates/bloblex-storage/src/lib.rs:146-155 and crates/bloblex-storage/src/lib.rs:68-78. Update both version guards to accept a completed version 3. A v3 reopen must return after read-only validation of schema/version markers, before backup, journal-mode changes, base schema DDL, or migration writes. For a v2-to-v3 run, make/verify the version-2 backup before DDL. Use BEGIN IMMEDIATE; insert version 3 and PRAGMA user_version=3 in the transaction. Verify backup before DDL; abort on failure. After DDL verify markers/integrity/FKs; on failure preserve failed DB, close all connections, restore verified backup only to stopped DB path. Never alter live WAL/SHM sidecars. A committed v3 database must reopen without error, backup, or writes.

    CREATE TABLE exec_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      runtime_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      created_at TEXT NOT NULL,
      requested_json TEXT NOT NULL CHECK(json_valid(requested_json)),
      applied_json TEXT NOT NULL CHECK(json_valid(applied_json)),
      evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
      instruction_sha256 TEXT,
      adapter_flags_json TEXT NOT NULL CHECK(json_valid(adapter_flags_json)),
      status TEXT NOT NULL CHECK(status IN ('applied','partial','rejected','runtime_default')),
      UNIQUE(turn_id)
    );
    CREATE INDEX idx_exec_snapshots_session_time ON exec_snapshots(session_id,created_at);
    CREATE INDEX idx_exec_snapshots_agent_time ON exec_snapshots(agent_id,created_at);
    CREATE INDEX idx_exec_snapshots_runtime_time ON exec_snapshots(runtime_id,created_at);
    ALTER TABLE sessions ADD COLUMN first_exec_snapshot_id TEXT REFERENCES exec_snapshots(id) ON DELETE SET NULL;
    ALTER TABLE sessions ADD COLUMN latest_exec_snapshot_id TEXT REFERENCES exec_snapshots(id) ON DELETE SET NULL;
    ALTER TABLE sessions ADD COLUMN claude_instruction_sha256 TEXT;
    ALTER TABLE sessions ADD COLUMN codex_thread_instruction_sha256 TEXT;
    ALTER TABLE sessions ADD COLUMN opencode_cost_total TEXT;
    ALTER TABLE usage_events ADD COLUMN exec_snapshot_id TEXT REFERENCES exec_snapshots(id) ON DELETE SET NULL;
    ALTER TABLE usage_events ADD COLUMN provider_update_id TEXT;
    ALTER TABLE usage_events ADD COLUMN usage_status TEXT NOT NULL DEFAULT 'unreported'
      CHECK(usage_status IN ('reported','partial','unreported'));
    ALTER TABLE usage_events ADD COLUMN context_used INTEGER;
    ALTER TABLE usage_events ADD COLUMN context_size INTEGER;
    ALTER TABLE usage_events ADD COLUMN reported_cost_decimal TEXT;
    CREATE INDEX idx_usage_exec_snapshot ON usage_events(exec_snapshot_id);
    CREATE UNIQUE INDEX idx_usage_provider_update ON usage_events(runtime_id,provider_update_id)
      WHERE provider_update_id IS NOT NULL;

Existing usage rows keep null exec_snapshot_id/provider_update_id/context fields and default usage_status='unreported'; preserve legacy raw column but write only {} for new events. requested_json stores typed requested values/nulls and maxConcurrency; env keys only, never values. applied_json records per-setting true/false/null and normalized ids. evidence_json stores only the accepted evidence kind/value and normalized reason, never raw provider echoes. adapter_flags_json stores adapter/version/gates. Snapshot `instruction_sha256` stores the current desired instruction hash only. `sessions.claude_instruction_sha256` stores the hash last proven applied for that session and changes only after a successful turn proves the current instruction sentinel; compare the agent's current hash with this value on resume. `sessions.codex_thread_instruction_sha256` stores the hash installed when the current Codex thread was created; it changes only when a new thread starts, so an agent.update mismatch remains detectable across resumes. For a changed hash on an existing Codex thread, snapshot the current desired hash and applied:false/reason `instructions_change_requires_new_thread`; do not overwrite the thread hash. `sessions.opencode_cost_total` stores the latest exact cumulative OpenCode USD amount as decimal text so restart recovery can compute the next turn's delta; `usage_events.reported_cost_decimal` stores the exact per-turn delta as decimal text. No raw provider JSON, credential, env value or instructions. Set first pointer once and latest each turn. Retain for session lifetime; no automatic pruning; archival does not delete data.

For idempotency, wrap DDL and version update in the migration transaction; use CREATE TABLE/INDEX IF NOT EXISTS and inspect pragma_table_info before each ADD COLUMN (the guard is mandatory: unconditional re-run fails with duplicate column name). This guard applies to `sessions.claude_instruction_sha256`, `sessions.codex_thread_instruction_sha256`, `sessions.opencode_cost_total`, and `usage_events.reported_cost_decimal` as well: add each column only when its name is absent from that table's `pragma_table_info`. If version 3 already exists, verify schema and both version markers then return without a new backup or writes. Migration 3 also installs the evidence-backed exec_gate keys described in section 1 and records settings.changed atomically for each actual gate flip.

Read-only RPCs: exec.snapshot.get {snapshotId}->{snapshot}; exec.snapshot.list {sessionId,after?,limit?}->{snapshots,next?}; exec.snapshot.latest {sessionId}->{snapshot|null}. No mutation RPC.

## 6. Model catalog and validation

RPC runtime.models request {runtimeId:string,refresh?:boolean}; response {runtimeId,provider,models:[{id,displayName,providerId?,supportedThinking:string[],defaultThinking:string|null,serviceTiers:[{id,name}],defaultServiceTier:string|null,variants?:string[],hostDependent:boolean}],fetchedAt,expiresAt,fallback:boolean,source:"app_server"|"control_request"|"acp_config_options"|"static"}. Missing runtime not_found; unsupported runtime unsupported; process/protocol failure provider_unavailable; malformed catalog provider_error. refresh true bypasses cache; otherwise 60 second TTL. Cache by runtime ID, executable/version and provider profile; never share catalogs across profiles. hostDependent marks profile-scoped data and never validates arbitrary custom IDs.

Sources: Codex paginated model/list only; the real profile returned 8 visible models while `codex debug models` returned 10 including hidden entries, so the app must not use debug models (docs/runtime-capabilities.md:220). Claude stream-json list_models, static fallback only on failed control request; behavior CONFIRMED, rows/aliases host-dependent (C4). OpenCode ACP session configOptions provides the full provider model catalog on the checked host (52 models); host-dependent counts/rows must never be hard-coded (docs/runtime-capabilities.md:230). Before sending any non-null model, effort, or tier, Bloblex validates it against the runtime/profile catalog and the selected model's supported values. Codex accepts unknown model ids, unlisted efforts, and unknown tiers, so provider acceptance is not validation (docs/runtime-capabilities.md:223). A fallback or unavailable catalog may support editing/recovery but does not validate a value for execution; fail closed rather than sending it or silently using a runtime default. OpenCode configOptions validates session selections; its currentValue alone is not application proof (docs/runtime-capabilities.md:230-234).

agent.create/update validate model, thinking, serviceTier against fresh/cached catalog when available. Match -> accept. Catalog unavailable or fallback:true -> accept nonempty custom ID for editing/recovery, but do not claim validated and do not send it until authoritative catalog validation succeeds. Authoritative catalog available and id absent -> invalid_argument with field-specific safe message. Unsupported model-effort/tier combination -> invalid_argument. Never convert invalid/missing to runtime default. Provider echoes never substitute for pre-send validation. Unknown Claude model ids fail a real turn; its `system/init` echo reflects the requested model and is not success evidence (docs/runtime-capabilities.md:211). Codex does not reject unknown models, unlisted efforts or unknown tiers (docs/runtime-capabilities.md:223). OpenCode counts and available values are host-dependent (docs/runtime-capabilities.md:230).

## 7. Concurrency admission

Current daemon active_turns is volatile, global cap four, and rejects another turn in same session (crates/bloblex-daemon/src/main.rs:45,683-699). Replace authority with DB reservations.

    CREATE TABLE active_turn_reservations (
      turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_active_reservations_session ON active_turn_reservations(session_id);
    CREATE INDEX idx_active_reservations_agent ON active_turn_reservations(agent_id);

The configured per-agent cap is agent.max_concurrency (1-50, as constrained in crates/bloblex-storage/src/lib.rs:79); effective cap is min(agent.max_concurrency,4), because global cap is fixed at 4. Legacy sessions have configured=null and effective=4. runtime.capabilities exposes global {limit:4,active} and, for an agentId, {configuredMaxConcurrency,effectiveMaxConcurrency,active}; without agentId it returns each active agent's configured/effective values.

For options with a separate provider preparation request, perform preflight before user prompt delivery. If gate/capability/provider rejects before prompt bytes, run one BEGIN IMMEDIATE transaction that inserts the turns row and user message, writes exec_snapshots(status='rejected'), marks the turn error, persists exec.options.rejected, and creates no reservation. For accepted work, the same transaction re-reads active session/agent, counts reservations globally and for agent, checks effective cap and global cap, then inserts turn, reservation, message and pending snapshot atomically. If either cap is reached, roll back and return conflict with exact message: Concurrency limit reached for this blob or daemon. Wait for an active turn to finish. No queue. If an adapter cannot prepare a field separately and rejection follows a prompt-bearing request, use the ambiguous post-send path and retain reservation.

Release points are exact: (1) turn.completed event; (2) confirmed TurnCancelled event, never merely session.cancel accepted; (3) adapter failure proven before any user-prompt bytes reach provider. Give adapter prompt failure a delivery classification {not_sent,may_have_been_sent}. For Claude, process spawn/serialization failure or stdin write never started is not_sent; instrument writes, and any positive/unknown byte count is may_have_been_sent. For Codex and ACP, process spawn/serialization failure or JSON-RPC send not started is not_sent; count bytes while writing, and partial/unknown delivery is may_have_been_sent. If adapter.prompt returns not_sent after the admission transaction created a reservation, atomically mark turn error and delete that reservation. If a launch/preparation failure is detected before admission, create no reservation. Provider option preparation that returns rejection before prompt dispatch is not_sent. For may_have_been_sent, a generic error never releases capacity; retain reservation through error until restart recovery, because provider work/usage may exist. Current daemon prompt-error path deliberately keeps budget capacity when usage is unknown (crates/bloblex-daemon/src/main.rs:774-784); Phase 2b must likewise keep active-turn reservation. session.cancel does not release before TurnCancelled, and session.close or process exit alone does not release an ambiguous reservation. Restart recovery clears reservations for incomplete turns. Recovery currently marks active turns error and sessions offline (crates/bloblex-storage/src/lib.rs:609-616); clear matching reservations in that same recovery transaction. DB rows are counters; memory map is cache only.

## 8. Usage capture and nullability

Current nullable usage columns and session-derived agent attribution: crates/bloblex-storage/src/lib.rs:166-168,387. Current core event has nullable tokens/model and raw payload: crates/bloblex-agent-core/src/lib.rs:120-127. Replace raw persistence with normalized evidence, never expose raw JSON. Every usage row gets agent_id from persisted session and exec_snapshot_id from turn; add FK/index in migration 3.

- Claude successful non-error result: map usage.input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens; model only from a successful result's modelUsage key (no top-level model was observed). Map total_cost_usd to USD minor units only if finite, nonnegative, exact. service_tier/speed are reports, not setters. is_error:true results are never usage: their zero usage and empty modelUsage are unreported, never zero (docs/runtime-capabilities.md:210-211).
- Codex thread/tokenUsage/updated: scope notifications to the current turn id because resume can replay a previous turn's notification before the new turn. Use tokenUsage.last, not cumulative total. Input = inputTokens - cachedInputTokens - cacheWriteInputTokens only when all exist and subtraction valid. Map cached buckets, outputTokens, reasoningOutputTokens. Model comes from thread/start or thread/settings/updated, not usage notification; cost null (docs/runtime-capabilities.md:224).
- OpenCode successful `session/prompt` result usage is per turn: map inputTokens directly to input (do not add cached tokens), outputTokens to output, thoughtTokens to reasoning, and cachedReadTokens to cache-read; cache-write stays NULL. Map totalTokens only if the schema has a normalized destination; otherwise leave it unreported. `usage_update.used` and `size` are context-window figures only (context_used/context_size). `usage_update.cost.amount` is a cumulative per-session total in explicit USD: compute the per-turn delta from the previous cumulative total using exact decimal arithmetic, key the write/deduplication by provider update id, store the delta in `usage_events.reported_cost_decimal`, and update `sessions.opencode_cost_total` to the latest total in the same transaction. The first observed turn's delta is the total itself. Never sum raw snapshots. Keep the latest cumulative total across restarts; if an update is missing, leave cost unreported for that turn and retain the prior total. Failed turns and their reported zeros are never successful usage; mark usage unreported and keep metrics null (docs/runtime-capabilities.md:232-233).

Zero is valid only when a successful provider event explicitly reports zero for that metric. Missing/malformed usage, failed-turn values (including explicit zeros), unknown currency/model, lossy conversion, or an unavailable cumulative-cost baseline -> SQL NULL and unreported. Never store raw provider payload as source. Deduplicate by provider update id. If an event is a cumulative snapshot, persist the latest session total and store only the computed per-turn delta; never sum raw snapshots. OpenCode token buckets and successful cost semantics are confirmed for the live profile (docs/runtime-capabilities.md:232-233).


## 9. Daemon/RPC behavior and events

session.new remains {agentId?,runtimeId?,projectPath,title?}, exactly-one selection unchanged (docs/ipc-contract.md:64). It loads stored agent options for startup. Legacy runtime-only caller gets null/default values. A gated-off/unsupported option or session-scoped provider-preparation rejection fails session.new/resume before readiness, with the event-only behavior from section 1. For turn-scoped options, apply section 7's rejected-turn transaction when rejection is proven before prompt delivery; do not refuse merely because successful-turn evidence will arrive after the prompt. Never silently fall back. Refresh agent settings for every new session.prompt. `agent.update` changes later applicable execution options. Changed Claude instructions take effect on resume only when the stored session hash differs and the daemon passes `--system-prompt-snapshot off`; unchanged hashes keep the default snapshot. Changed Codex instructions do not apply to an existing thread: record `applied:false, reason:"instructions_change_requires_new_thread"` in the snapshot and emit `exec.options.changed`, allowing the UI to say “applies to new conversations”; a new session/thread uses the updated text. If active Claude session requires process-level restart, resume with stored native id before sending prompt; resume failure returns unsupported/provider_unavailable without sending text.

RPC additions:
- runtime.capabilities {runtimeId,agentId?}->{runtimeId,settings:{...},globalConcurrency:{limit:4,active:n},agentConcurrency:{configuredMaxConcurrency,effectiveMaxConcurrency,active}|null,hostDependent:boolean}.
- runtime.models and exec.snapshot.* as above.
- agent.create/update wire fields unchanged except validation.
- session.new wire params unchanged.
- Update docs/ipc-contract.md in Phase 2b with runtime.capabilities, runtime.models, exec.snapshot.get/list/latest request/response/error shapes; exec.options.changed, exec.options.rejected, and settings.changed payloads; and the new unsupported/provider_unavailable error cases.

Events: exec.options.changed {sessionId,turnId,agentId,runtimeId,requested:{model,thinking,serviceTier,instructionsPresent,maxConcurrency},applied:{per-setting outcomes},snapshotId}; exec.options.rejected {sessionId,agentId,runtimeId,setting,code:"unsupported"|"provider_error",reason,turnId?:string,snapshotId?:string}. For a changed instruction hash on an existing Codex thread, the snapshot and exec.options.changed outcome must contain applied:false and reason `instructions_change_requires_new_thread`; do not create a rejection because the turn's other options remain usable. Session-scoped rejection has no turnId/snapshotId and is persisted before the RPC fails; turn-scoped not-sent rejection includes both and is persisted atomically with error turn/snapshot and no reservation. Never include instruction text, env values, argv or raw provider JSON. Persist events with the corresponding storage transaction. Keep existing usage.updated/turn.completed/turn.cancelled/turn.error lifecycle names (crates/bloblex-daemon/src/main.rs:900-989).

## 10. Test plan and acceptance gates

Deterministic tests use fake CLIs/stub protocol peers only; never installed real CLIs or network. Assert exact Claude argv order and private-file path; instruction-file ACL and stale-file cleanup only after 24 hours (preserve files with a live process marker); pass `--system-prompt-snapshot off` only when the stored instruction hash differs from the current hash, with the flag absent otherwise. Codex tests must show developerInstructions at thread/start applies, a changed hash on an existing thread is recorded as applied:false with reason `instructions_change_requires_new_thread`, and a new thread applies the updated text; resume need not resend instructions. Verify Claude's applied hash advances only after successful sentinel evidence and Codex thread hash is set only for a new thread and preserved on resume; usage notifications are scoped to the current turn id. Assert ACP exact JSON-RPC params and ordering; env allowlists/isolation/redaction; rejected setting never retries after dropping the option; a live setting rejection persists its provider gate false in generic settings and emits settings.changed; successful turn evidence differs from sent request; snapshots store hashes, not text/raw JSON. Cover turn-scoped rejection atomicity (turn/message/rejected snapshot/error event, no reservation), session-scoped rejection (event only, no snapshot), transaction rollback, and no reservation leak. Model pagination/cache/fallback/profile keys and validation; migration 3 idempotency including pragma_table_info ADD COLUMN guards for every added column, v3 reopen without backup/writes, v2 backup corruption abort before DDL, v3 rollback restoring the v2 backup, rollback in temp DB only; restart recovery. Concurrency: legacy max_concurrency=4; exact conflict message; dedicated per-agent race where omitting only the per-agent check is caught; global-cap race; release on completed, confirmed cancelled, and adapter not_sent at each provider's spawn/pre-write point; retain on may_have_been_sent; session.cancel before TurnCancelled keeps reservation. Usage mapping tests cover null/missing usage, Claude failed-result zeros, OpenCode cumulative cost delta and first-turn delta, missing usage_update, failed-turn zeros, decimal persistence and restart baseline, Codex replayed usage notification filtering by turn id, currency conversion, agent_id and snapshot attribution. Mutation tests remove a gate, convert null to zero, omit either reservation check, release at cancel request, retry without an option, omit settings.changed, or leak instruction text; each must fail.

### Live Phase 2b entry gate (Director-run only)

The entry gate was run once on 2 Oct 2026 against the real profile. Results, status deltas, exact CLI versions and evidence are recorded in docs/runtime-capabilities.md:204-251; scripts/live-checks/README.md describes the scripts and what they probe. It established the migration-3 seed values in section 1. Re-run `scripts/live-checks/` when any CLI version changes or a gate needs re-evidence. A regression means update the evidence first and flip the affected gate off; do not continue to report that setting as applied. Reconcile new results with this contract and never infer more than the recorded evidence supports.

1. Record CLI path/version and profile class without credentials/prompt text. Use disposable project and non-secret sentinel instructions. Keep prompts minimal.
2. Claude: run list_models plus short successful/negative probes, including changed-file resume with default snapshot and snapshot off; validate modelUsage, thinking-token behavior, instructions and failed-result usage semantics.
3. Codex: paginate model/list (do not use debug models as the app catalog), check new-thread/resume instruction behavior, validated model/effort/tier selections, and turnId-scoped usage notifications.
4. OpenCode: inspect real session configOptions, select model/mode/effort, run a short success continuation, and record per-turn usage plus cumulative cost updates. Keep the thinking gate off until behavioral proof exists.
5. In docs/runtime-capabilities.md record date/version/profile class, redacted request shape, outcome, evidence kind, and status. Request shape or echo alone never upgrades status. No credentials, session ids, full prompts, instruction text or raw provider JSON.

### Exact post-implementation commands

Run each Rust suite with isolated CARGO_TARGET_DIR (PowerShell):

    $env:CARGO_TARGET_DIR = Join-Path $env:TEMP 'bloblex-2b-target'
    cargo test -p bloblex-agent-core
    cargo test -p bloblex-storage
    cargo test -p bloblex-adapter-claude
    cargo test -p bloblex-adapter-codex
    cargo test -p bloblex-adapter-acp
    cargo test -p bloblex-adapter-opencode
    cargo test -p bloblex-daemon
    Remove-Item Env:CARGO_TARGET_DIR
    npm --prefix apps/desktop run typecheck
    npm --prefix apps/desktop test
    npm --prefix apps/desktop run build

Scripts are typecheck = tsc -b --pretty false, test = vitest run, build = tsc -b && vite build (apps/desktop/package.json:6-10). Do not run during docs-only review; implementation acceptance reports exact results/failures.

## 11. Risks, open questions, implementation order

Risks: catalog/profile drift; seed gate values becoming stale after CLI upgrades; provider evidence scoped to the wrong turn; subprocess env leakage; admission races across restart; user DB migrations. Preserve nullable usage and fail closed on rejection.

Open questions: whether Codex `serviceTier:"priority"` measurably speeds turns (the live acceptance/normalization was observed, speed effect was not measured); whether OpenCode effort has a behavioral effect (the live comparison did not establish one, so its gate remains off); and whether future CLI/provider versions change any live result. No open question blocks this contract; each remains gated rather than assumed.

Implementation order:

1. 2b-1 types + snapshots migration — ExecOptions, request compatibility, migration 3 including `sessions.claude_instruction_sha256`, `sessions.codex_thread_instruction_sha256`, `sessions.opencode_cost_total` and `usage_events.reported_cost_decimal`, backup/rollback, snapshot storage/DTO.
2. 2b-2 Claude — private instruction file, typed model/effort, snapshot-off resume design, usage normalization.
3. 2b-3 Codex — catalog pagination, start/resume/turn mapping, fixed-per-thread instruction hash behavior, evidence, turn-scoped usage.
4. 2b-4 OpenCode — isolated env/config, ACP model/mode/effort order, catalog, context/token and cumulative-cost delta mapping.
5. 2b-5 catalog + validation — TTL/cache, capabilities/models RPC, validation and gates.
6. 2b-6 concurrency — transactional per-agent/global reservations, cancel/restart recovery, races.
7. 2b-7 usage — final per-provider semantics, storage links, nullability, redaction/mutation tests.

