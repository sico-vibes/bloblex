# Phase 2b specification: execution options per blob

This is the implementation contract for Phase 2b of [E2E_PLAN_V2.md](E2E_PLAN_V2.md). Phase 2a stores blob identity and execution-shaped fields; Phase 2b makes fields effective only after per-runtime gates pass. Current inert agent columns and RPCs are in crates/bloblex-storage/src/lib.rs:79-86,226-278; current adapter requests contain only session/path or turn/text at crates/bloblex-agent-core/src/lib.rs:50-70; daemon paths are crates/bloblex-daemon/src/main.rs:470-558,561-664,666-793.

## 1. Scope, gates, and honest capability reporting

Implement backend execution options and per-turn evidence for Claude stream-json, Codex app-server, and OpenCode ACP; model catalogs and validation; safe child environments; execution snapshots; per-agent/global active-turn limits; normalized usage persistence. Phase 2a session.new accepts agentId or legacy runtimeId and persists the selected link (docs/ipc-contract.md:64; crates/bloblex-daemon/src/main.rs:470-558; crates/bloblex-storage/src/lib.rs:350-363). Usage attribution already reads agent_id from the persisted session (crates/bloblex-storage/src/lib.rs:387).

Out of scope: UI enabling of the execution card (later task); Phase 4 permissions, Phase 5 analytics, Phase 6 settings, Phase 7 native/release work. Add only read-only snapshot/catalog RPCs for later consumers. Never touch the live inspection database or sidecars.

### Gate model

Adapter capability response per runtime: settings map for model, thinking, serviceTier, instructions, customEnv. Each reports {supported,enabled,scope,evidence,reason?}; scope is spawn/resume/turn/process; evidence is none/request_shape/provider_echo/successful_turn. Unsupported means false/false. Request shape alone means supported true, enabled false. Sending an argv/RPC/env value is requested, never applied; report applied only with provider-side echo or successful-turn evidence tied to that turn.

Director-controlled flags are settings keys exec_gate.<provider>.<setting>, boolean default false: claude.model, claude.thinking, claude.instructions, codex.model, codex.thinking, codex.serviceTier, codex.instructions, opencode.model, opencode.thinking, opencode.instructions. Migration 3 initializes them with this exact statement (bind/list all ten keys): INSERT OR IGNORE INTO settings(key,value) VALUES (?1,'false'). On an existing row it preserves the operator's value. No Claude/OpenCode service-tier gate and no customArgs gate. Daemon computes enabled = adapter_supported && gate_true. No UI or agent RPC sets gates. Director changes a gate only after adding evidence to docs/runtime-capabilities.md.

| Runtime setting | Required live proof before enabling | Flag and evidence status |
|---|---|---|
| Claude model | Valid id resolved by list_models or success result; trivial successful turn uses it; unknown id surfaces and ends as error. | exec_gate.claude.model; C1 PARTIAL, C4 CONFIRMED behavior, host-dependent aliases/catalog |
| Claude thinking | Successful turn proves requested --effort; hide when selected row has no levels. | exec_gate.claude.thinking; C2 PARTIAL and host-dependent effort support |
| Claude instructions | Successful turn proves file content; resume after changing content proves --system-prompt-snapshot off applies it. | exec_gate.claude.instructions; C3 PARTIAL: path exists, body and file snapshot semantics open |
| Codex model | Same-profile model/list compared with selected row; start/resume/turn round-trip; successful-turn evidence. | exec_gate.codex.model; X3 PARTIAL catalog live check; X1/X2 CONFIRMED schema shape only |
| Codex thinking | Listed model effort accepted and successful-turn settings/response proves use; probe unlisted effort rejection/fallback. | exec_gate.codex.thinking; X3/X4 PARTIAL, unsupported combination behavior unknown |
| Codex service tier | Round-trip listed tier on thread and turn; response proves it; probe reject/fallback. | exec_gate.codex.serviceTier; X5 CONFIRMED IDs/shape, live priority acceptance unverified |
| Codex instructions | Sentinel developerInstructions effective on start and after resume. | exec_gate.codex.instructions; X1/X2 CONFIRMED shape; X6 PARTIAL retention/application |
| OpenCode model | Profile verbose list; ACP select; currentValue and successful-turn model evidence. | exec_gate.opencode.model; O1 CONFIRMED behavior/host-dependent rows; O3 PARTIAL |
| OpenCode thinking | Select model then effort; successful turn proves selected effort. | exec_gate.opencode.thinking; O6 CONFIRMED option behavior, successful use not proven |
| OpenCode instructions | Set per-blob config and mode; successful turn and continuation use prompt. | exec_gate.opencode.instructions; O2 CONFIRMED config merge; O4 PARTIAL/cross-turn open |

A requested non-null setting with gate off or unsupported capability fails closed with unsupported before provider prompt submission; safe message is “The requested setting is unavailable for this runtime until its execution check passes.” A provider rejection at session setup also fails before session is marked ready. For a turn-scoped setting, send the option only when its gate is already enabled; if the provider rejects, persist rejected evidence, fail that turn with “The provider rejected the requested setting.”, and do not retry without it. Where proof can only arrive in a successful result, the turn may run under the enabled gate but applied remains null until that result; contradictory evidence marks the turn error. Never claim applied on a constructed request alone. Null means runtime default. After a live rejection, disable that runtime setting.

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

At session.new resolve agent row and construct options from persisted columns. Resume reloads current agent row. Each turn reloads the row and sends fresh options, so agent.update affects later turns only. Legacy agentId:null sessions receive null/default settings, empty env/args, max_concurrency 4 (global-only cap). Existing core structs/trait: crates/bloblex-agent-core/src/lib.rs:50-70,138-160. Daemon dispatch/new/resume/prompt: crates/bloblex-daemon/src/main.rs:232-249,470-664,666-793.

## 3. Adapter contracts

Each adapter emits normalized SettingOutcome {requested,applied,evidenceKind,evidenceValue?,reason?}. applied is nullable; false=rejected, null=no provider evidence. Parse evidence to normalized values; raw provider JSON never reaches React. Rejection stops before prompt and creates a rejected snapshot; never retry after dropping the option.

### Claude stream-json

Current fixed stream-json permission launch, resume identity and stdin prompt are at crates/bloblex-adapter-claude/src/lib.rs:202-221,381-395 (C6 CONFIRMED current source mapping). Append typed arguments after fixed protocol/permission flags and before resume identity, in order: --model <id>; --effort <id>; --append-system-prompt-file <absolute-private-path>; --system-prompt-snapshot off when instruction gate is enabled. Never put instruction text in argv or use --system-prompt. File path probe is PARTIAL C3; model/effort support and warning/rejection nuances are PARTIAL C1/C2; speed setter absence is CONFIRMED C5. Catalog rows/aliases are host-dependent C1/C2/C4.

Chosen resume behavior: respawn provider process on resume with newest instruction file and snapshot off; hash desired instructions each turn and store hash only. Help says snapshot defaults on, reuses the rendered initial prompt for requests/resume, and changed launch instructions are ignored until compaction; that statement names inline prompt flags, not the file form. Snapshot off is the chosen mitigation, but its effect on file flags is still open (C3 PARTIAL). If launch-scoped model/effort/instruction options change between turns, restart/resume with the new options before sending the next prompt; if that native resume cannot be proven, reject the changed setting. Unknown model/effort diagnostics or contradictory success evidence fail the turn. Successful model evidence must come from modelUsage keys or provider-confirmed model; effort needs successful-turn proof. Failed result is not proof or usage (C7 PARTIAL).

Catalog: stream-json control_request subtype list_models; normalize response. If it fails, return a built-in suggestion list of documented aliases (sonnet, opus, fable) marked fallback:true and hostDependent:true; these are suggestions, not an assertion that this profile resolves them. In fallback mode allow custom IDs rather than rejecting IDs absent from that suggestion list. Request works (C4 CONFIRMED behavior); count/default aliases are host-dependent (C1/C4). No speed/service tier (C5 CONFIRMED behavior).

### Codex app-server

Current launch/RPC fields: crates/bloblex-adapter-codex/src/lib.rs:45-48,159-174,278-309,336-346. Current CLI request mapping is CONFIRMED source evidence (X8); added field shapes are schema-confirmed, not application proof (X1/X2 CONFIRMED schema; X6 PARTIAL application).

- thread/start: keep cwd, approvalPolicy:"on-request", sandbox:"workspace-write"; add model, serviceTier if non-null and developerInstructions if enabled. No top-level effort. Do not rely on config.model_reasoning_effort until live acceptance (X1 CONFIRMED shape; nested acceptance unverified).
- thread/resume: threadId, cwd plus same model/serviceTier/developerInstructions. Re-send developerInstructions; baseInstructions is distinct (X2 CONFIRMED shape; X6 PARTIAL).
- Each turn/start: {threadId,input:[{type:"text",text}],model?,effort?,serviceTier?,serviceTierForTurn?}. Use catalog ids as-is. "default" serviceTierForTurn means one-turn standard; never send fast/standard as a tier id. No developerInstructions on turn/start (X2/X5 CONFIRMED behavior; per-model availability host-dependent).
- Order: initialize; start/resume; parse response/settings evidence; validate requested per-turn options; send turn/start with text only after successful preflight. RPC rejection fails closed; never retry without option. Never log debug models raw output because it can contain instruction templates (X3 PARTIAL).
- Catalog: paginated model/list (cursor, includeHidden:false, limit=100), consume data/nextCursor until null. Normalize ids/labels, efforts/default, tier id/name/description/default. Schema exists but RPC not called and comparison to debug models unverified (X3 PARTIAL); effort choices vary per model/profile (X4 PARTIAL); priority/Fast is observed, not hard-coded (X5 CONFIRMED behavior, host-dependent rows).

### OpenCode ACP

Current ACP launch/session flow is crates/bloblex-adapter-acp/src/lib.rs:44-53,350-367,386-420,428-440; wrapper re-export is crates/bloblex-adapter-opencode/src/lib.rs:1-5. CLI facts: config merge O2 CONFIRMED; verbose catalog contents host-dependent O1; custom agent needs mode, cross-turn persistence open O4 PARTIAL; model/effort option facts O3 PARTIAL/O6 CONFIRMED; no tier exposed in inspected ACP O7 CONFIRMED only for inspected version.

Launch each blob process with isolated child environment and Bloblex-generated OPENCODE_CONFIG_CONTENT JSON containing model default and a Bloblex agent with prompt=instructions. Never inherit another blob's config/data/cache/state or OPENCODE_CONFIG_CONTENT (O2 CONFIRMED; catalog profiles host-dependent O1). Do not expose/log the env value.

Call initialize and initialized, then session/new or session/load. Select model first with session/set_config_option {sessionId,configId:"model",value:modelId}, or session/set_model {sessionId,modelId}. Set instructions mode with session/set_config_option {sessionId,configId:"mode",value:agentId}; then inspect options and set {sessionId,configId:"effort",value:thinkingId}. "default" only if ACP returns it as selectable. Re-fetch configOptions after each change; currentValue is request echo, not successful-turn proof (O3/O4/O6 statuses above).

On load, order is model, mode, inspect options, effort; rebuild env before process spawn. Non-null OpenCode serviceTier is unsupported and rejected (O7 CONFIRMED inspected behavior). Any RPC error/missing option fails before session/prompt. set_model requires modelId (O3 PARTIAL); model selection adds effort option when available (O6 CONFIRMED behavior). initialized method-not-found stderr is harmless (O3 CONFIRMED).

Catalog via opencode models --verbose with model/provider ids, label, variants, cost/limits metadata; bounded no-prompt child and timeout, isolated config/data/cache/state; no terminal scraping. Mark hostDependent:true. Verbose rows/counts vary by host (O1 CONFIRMED behavior, host-dependent). Use ACP configOptions to validate session-available model/effort (O3 PARTIAL).

## 4. Allowlists, secrets, instruction files

customArgs MUST be empty for all adapters; reject nonempty with invalid_argument. Typed fields are adapter-owned. Never let user options control protocol, cwd, permissions, sandbox, transport, output format, config source or authentication (empty allowlists: C6/X8/O7 source; relevant item status and Z2 in docs/runtime-capabilities.md).

Explicit customEnv allowlists:
- Claude: LANG, LC_ALL, TZ, NO_COLOR, TERM.
- Codex: LANG, LC_ALL, TZ, NO_COLOR, TERM.
- OpenCode: LANG, LC_ALL, TZ, NO_COLOR, TERM. Bloblex alone constructs OPENCODE_CONFIG_CONTENT and owns isolated config/data/cache/state paths; reject user values for those variables.

Reject keys outside that per-runtime list, case-insensitive TOKEN|SECRET|PASSWORD|KEY|AUTH|CREDENTIAL|COOKIE keys, and NUL values. Never log values or include in errors/events. These are conservative product choices; environment inheritance was not implemented per runtime-capabilities.md:163.

Claude nonempty instructions: create random .txt under %LOCALAPPDATA%\Bloblex\private-tmp (fallback %TEMP%\Bloblex\private-tmp). Directory ACL current-user only; file disables inheritance and grants current-user full control. POSIX fallback 0700 dir/0600 file. Use create-new, UTF-8, flush/close; pass path only; delete on process exit or spawn failure. Startup cleanup only for Bloblex-owned files older than 24 hours with no live process marker. Filename contains no prompt text. Logs/events/errors/snapshots contain neither text nor file body; store SHA-256 only. File path exists but successful body application unverified (C3 PARTIAL); gate stays shut.


## 5. Execution snapshots and migration 3

Every turn gets a snapshot, including rejected preflight. Migration 3 reuses verified online-backup-before-DDL from migration 2 (crates/bloblex-storage/src/lib.rs:68-86,146-155; docs/PHASE_2A_SPEC.md:22-32,87-100). Use BEGIN IMMEDIATE; insert version 3 and PRAGMA user_version=3 in transaction. Verify backup before DDL; abort on failure. After DDL verify markers/integrity/FKs; on failure preserve failed DB, close all connections, restore verified backup only to stopped DB path. Never alter live WAL/SHM sidecars. Existing pattern checks markers and backup/integrity at crates/bloblex-storage/src/lib.rs:68-78,110-120,146-155.

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
    ALTER TABLE usage_events ADD COLUMN exec_snapshot_id TEXT REFERENCES exec_snapshots(id) ON DELETE SET NULL;
    ALTER TABLE usage_events ADD COLUMN provider_update_id TEXT;
    ALTER TABLE usage_events ADD COLUMN usage_status TEXT NOT NULL DEFAULT 'unreported'
      CHECK(usage_status IN ('reported','partial','unreported'));
    ALTER TABLE usage_events ADD COLUMN context_used INTEGER;
    ALTER TABLE usage_events ADD COLUMN context_size INTEGER;
    CREATE INDEX idx_usage_exec_snapshot ON usage_events(exec_snapshot_id);
    CREATE UNIQUE INDEX idx_usage_provider_update ON usage_events(runtime_id,provider_update_id)
      WHERE provider_update_id IS NOT NULL;

Existing usage rows keep null exec_snapshot_id/provider_update_id/context fields and default usage_status='unreported'; preserve legacy raw column but write only {} for new events. requested_json stores typed requested values/nulls and maxConcurrency; env keys only, never values. applied_json records per-setting true/false/null and normalized ids. evidence_json stores kind and normalized provider echo only. adapter_flags_json stores adapter/version/gates. instruction_sha256 is hash only. No raw provider JSON, credential, env value or instructions. Set first pointer once and latest each turn. Retain for session lifetime; no automatic pruning; archival does not delete data.

For idempotency, wrap DDL and version update in the migration transaction; use CREATE TABLE/INDEX IF NOT EXISTS and inspect pragma_table_info before each ADD COLUMN. If version 3 already exists, verify schema and both version markers then return without a new backup or writes.

Read-only RPCs: exec.snapshot.get {snapshotId}->{snapshot}; exec.snapshot.list {sessionId,after?,limit?}->{snapshots,next?}; exec.snapshot.latest {sessionId}->{snapshot|null}. No mutation RPC.

## 6. Model catalog and validation

RPC runtime.models request {runtimeId:string,refresh?:boolean}; response {runtimeId,provider,models:[{id,displayName,providerId?,supportedThinking:string[],defaultThinking:string|null,serviceTiers:[{id,name}],defaultServiceTier:string|null,variants?:string[],hostDependent:boolean}],fetchedAt,expiresAt,fallback:boolean,source:"app_server"|"control_request"|"cli_verbose"|"static"}. Missing runtime not_found; unsupported runtime unsupported; process/protocol failure provider_unavailable; malformed catalog provider_error. refresh true bypasses cache; otherwise 60 second TTL. Cache by runtime ID, executable/version and provider profile; never share catalogs across profiles. hostDependent marks profile-scoped data and never validates arbitrary custom IDs.

Sources: Codex paginated model/list; schema/request shape only, live response/comparison PARTIAL (X3). Claude stream-json list_models, static fallback only on failed control request; behavior CONFIRMED, rows/aliases host-dependent (C4). OpenCode opencode models --verbose including variants; behavior CONFIRMED, catalog rows host-dependent (O1). ACP configOptions validates session selections when available because it may differ from verbose list (O3 PARTIAL; O6 CONFIRMED effort option behavior).

agent.create/update validate model, thinking, serviceTier against fresh/cached catalog when available. Match -> accept. Catalog unavailable or fallback:true -> accept nonempty custom ID for editing/recovery, but do not claim validated. Authoritative catalog available and id absent -> invalid_argument with field-specific safe message. Unsupported model-effort/tier combination -> invalid_argument. Never convert invalid/missing to runtime default. Claude custom model IDs remain editable due invalid-ID uncertainty (C1 PARTIAL); effort availability varies (C2 PARTIAL); Codex efforts vary per model (X4 PARTIAL) and tier IDs are catalog-specific (X5 CONFIRMED behavior, host-dependent availability); OpenCode variants are profile-specific (O1 host-dependent; O6 CONFIRMED option behavior).

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

Admission in one BEGIN IMMEDIATE transaction: re-read active session/agent, count reservations globally and for agent, compare global cap 4 and agent.max_concurrency (legacy session uses 4), then insert turn, reservation, message and snapshot atomically. Either limit exceeded -> conflict with exact message: Concurrency limit reached for this blob or daemon. Wait for an active turn to finish. No queue.

Release once on turn.completed, confirmed turn.cancelled, or pre-provider failure proving no work sent. Ambiguous failure after prompt send retains reservation. Cancel request alone does not release; await adapter TurnCancelled or process end. Restart recovery already marks incomplete turns error and sessions offline (crates/bloblex-storage/src/lib.rs:609-616); in same recovery transaction clear their reservations. DB rows are counters; memory map is cache only. Race tests cover same-agent and global competing starts and exactly-once release.

## 8. Usage capture and nullability

Current nullable usage columns and session-derived agent attribution: crates/bloblex-storage/src/lib.rs:166-168,387. Current core event has nullable tokens/model and raw payload: crates/bloblex-agent-core/src/lib.rs:120-127. Replace raw persistence with normalized evidence, never expose raw JSON. Every usage row gets agent_id from persisted session and exec_snapshot_id from turn; add FK/index in migration 3.

- Claude successful non-error result: map usage.input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens; model from success modelUsage keys or success model field only after verified; total_cost_usd to USD minor units only if finite, nonnegative, exact. service_tier/speed are reports, not setters. is_error:true zeros/null/empty modelUsage are not successful evidence: metrics null/unreported, never zero. These keys were observed on failure only and success semantics are PARTIAL (C7).
- Codex thread/tokenUsage/updated: use tokenUsage.last, not cumulative total. Input = inputTokens - cachedInputTokens - cacheWriteInputTokens only when all exist and subtraction valid. Map cached buckets, outputTokens, reasoningOutputTokens. Model comes from thread/start or thread/settings/updated, not usage notification; cost null. Schema event has tokens but no model/cost (X7 CONFIRMED).
- OpenCode usage_update: used/size only context-window figures (context_used/context_size), never token buckets. cost.amount only for successful turn and explicit USD; retain decimal until exact minor conversion. Treat repeats as snapshots, do not sum; cumulative-vs-delta unverified. Failed-request zeros are not successful free usage. Input/output/cache/reasoning remain null. “No usage” is REFUTED; event shape exists, but success semantics are not established (O5 REFUTED claim, successful semantics PARTIAL/unverified).

Zero is valid only when successful provider event explicitly reports zero for that metric. Missing/malformed, failed-turn, unknown currency/model, lossy conversion, ambiguous cumulative value -> SQL NULL and unreported. Never store raw provider payload as source. Deduplicate by provider update id. If event is cumulative snapshot, persist latest observation, never sum. Until successful semantics pass gate, mark status unreported and ambiguous fields null.


## 9. Daemon/RPC behavior and events

session.new remains {agentId?,runtimeId?,projectPath,title?}, exactly-one selection unchanged (docs/ipc-contract.md:64). It loads stored agent options for startup. Legacy runtime-only caller gets null/default values. Refuse creation if requested option cannot be accepted/proven at required scope; never silent fallback. Refresh agent settings for every new session.prompt. agent.update affects later turns only. If active session requires process-level restart (Claude), resume with stored native id before sending prompt; resume failure returns unsupported/provider_unavailable without sending text.

RPC additions:
- runtime.capabilities {runtimeId}->{runtimeId,settings:{...},globalConcurrency:{limit:4,active:n},hostDependent:boolean}.
- runtime.models and exec.snapshot.* as above.
- agent.create/update wire fields unchanged except validation.
- session.new wire params unchanged.

Events: exec.options.changed {sessionId,turnId,agentId,runtimeId,requested:{model,thinking,serviceTier,instructionsPresent},applied:{per-setting outcomes},snapshotId}; exec.options.rejected has identifiers plus {setting,code:"unsupported"|"provider_error",reason}. Never include instruction text, env values, argv or raw provider JSON. Persist event with snapshot transaction. Keep existing usage.updated/turn.completed/turn.cancelled/turn.error lifecycle names (crates/bloblex-daemon/src/main.rs:900-989).

## 10. Test plan and acceptance gates

Deterministic tests use fake CLIs/stub protocol peers only; never installed real CLIs or network. Assert exact Claude argv order and private-file path; Codex/ACP exact JSON-RPC params and ordering; env allowlists/isolation/redaction; rejected setting sends no prompt; provider evidence differs from sent request; snapshots store hashes, not text/raw JSON; model pagination/cache/fallback/profile keys and validation; migration 3 idempotency, verified backup, rollback in temp DB only; restart recovery; concurrency races; usage mapping for null/missing, failed-result zeros, cumulative OpenCode snapshots and currency conversion; agent_id and snapshot attribution. Mutation tests remove a gate, convert null to zero, omit a reservation check, release at cancel request, or leak instruction text; each must fail.

### Live Phase 2b entry gate (Director-run only)

1. Record CLI path/version and profile class without credentials/prompt text. Use disposable project and non-secret sentinel instructions. Do not run model completions beyond minimal checks.
2. Claude: list catalog without model call; one short successful prompt with model+effort+file instruction; resume same native session after changing sentinel file; inspect normalized result/evidence and exit behavior. Update C1-C4/C7 separately; no setting gate enabled without successful-turn proof.
3. Codex: paginate model/list, compare same-profile catalog with debug models only diagnostically; start/resume with model/instructions; one short turn with listed effort/tier; inspect settings echo and tokenUsage notification. Probe unsupported ID only if safe. Update X1-X7; separate schema, behavior and host-dependent facts.
4. OpenCode: opencode models --verbose with isolated config/data/cache/state; launch ACP with synthetic agent prompt, select model/mode/effort, inspect echo; one short success turn and continuation if needed; record usage_update sequence/currency and cumulative-vs-delta. Update O1-O7 separately.
5. In docs/runtime-capabilities.md record date/version/profile class, redacted request shape, outcome, evidence kind (schema/help/no-model live/successful turn/source), status. Request shape alone never upgrades status. No credentials, session ids, full prompts, instruction text or raw provider JSON. Enable the exact exec_gate.* only after successful provider evidence.

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

Risks: catalog/profile drift; provider echo that confirms request but not model execution; Claude file snapshot semantics; Codex resume instructions; ACP prompt persistence; usage snapshots becoming cumulative totals; subprocess env leakage; admission races across restart; user DB migrations. Default all gates off, preserve nullable usage, fail closed on rejection.

Genuine open questions for Director: live outcomes listed by entry gate; whether Claude file prompt honors snapshot-off; whether Codex settings echo proves execution; whether ACP repeated cost is cumulative; whether custom ACP prompt persists across turns. No open question blocks this contract; each remains gated rather than assumed.

Implementation order:

1. 2b-1 types + snapshots migration — ExecOptions, request compatibility, migration 3, backup/rollback, snapshot storage/DTO.
2. 2b-2 Claude — private instruction file, typed model/effort, snapshot-off resume design, usage normalization.
3. 2b-3 Codex — catalog pagination, start/resume/turn mapping, evidence, usage.
4. 2b-4 OpenCode — isolated env/config, ACP model/mode/effort order, catalog, context/cost mapping.
5. 2b-5 catalog + validation — TTL/cache, capabilities/models RPC, validation and gates.
6. 2b-6 concurrency — transactional per-agent/global reservations, cancel/restart recovery, races.
7. 2b-7 usage — final per-provider semantics, storage links, nullability, redaction/mutation tests.

