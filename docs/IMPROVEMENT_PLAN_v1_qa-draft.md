# Bitbots improvement plan: CLI connectivity, reasoning effort, and dictation

> Status: superseded by [IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md) (the owner-approved v2, 12 October 2026, which says it supersedes this draft). Kept as the QA record; its budget and path references are not current.

Status: proposal for review. Author: QA lane (OpenCode), for the Director.
Date: 12 October 2026. Baseline source: `17591b9` (beta.18).

This plan is grounded in a side-by-side read of the Bitbots sources and the
`get-bb/bb` sources. It covers the two areas requested:

1. **Connection to different coding-agent CLIs** (Claude Code, Codex, OpenCode
   Go/Zen) and the **reasoning/effort levels** they advertise.
2. **Dictation**, including the "free, no model download" option.

Mobile is explicitly deferred; see the appendix.

The plan obeys the standing invariants in `AGENTS.md`: no copied provider
authentication, no primary terminal scraping, prompts stay in
stdin/protocol, the daemon owns sessions/permissions/budgets, and no
capability secrets or provider credentials are written to docs or logs.

---

## 1. Where we are today (findings)

### 1.1 CLI connectivity

Bitbots already uses the right shape: one Rust adapter per CLI, spawned as the
user's installed executable, using the user's own logged-in account.

| CLI | Bitbots transport | Reference |
| --- | --- | --- |
| Claude Code | `claude` CLI with typed flags (`--model`, `--effort`, `--settings`) | `crates/bloblex-adapter-claude/src/lib.rs` |
| Codex | `codex app-server` JSON-RPC (`initialize`, `model/list`, `turn/start`) | `crates/bloblex-adapter-codex/src/lib.rs` |
| OpenCode Go/Zen | ACP over stdio via the shared ACP adapter | `crates/bloblex-adapter-opencode/src/lib.rs` (re-exports `bloblex-adapter-acp`) |

Comparable to BB's provider plugins (`plugins/provider-claude-code`,
`plugins/provider-codex`, `plugins/provider-acp`). Connectivity is therefore
not the core gap.

### 1.2 Reasoning/effort

Bitbots calls the concept `thinking`:

- `ModelInfo.supported_thinking` carries per-model effort ids
  (`crates/bloblex-agent-core/src/lib.rs:801`).
- Codex keeps raw `supportedReasoningEfforts`, including `ultra`
  (`crates/bloblex-adapter-codex/src/lib.rs:1044`; test at `:1857`).
- Claude maps `supportedEffortLevels` and synthesizes `ultracode` only after a
  workflow probe (`crates/bloblex-adapter-claude/src/lib.rs:97`, `:193`).
- OpenCode derives efforts from `opencode models --verbose` *variant keys*,
  and the ACP config-option fallback leaves `supported_thinking` **empty**
  (`crates/bloblex-adapter-acp/src/catalog.rs:171`, `:221`).
- The daemon gates OpenCode thinking behind `exec_gate.opencode.thinking`,
  default **off** (`crates/bloblex-daemon/src/main.rs:1381`, `:1410`), and the
  ACP effort echo is recorded as unproven (`crates/bloblex-adapter-acp/src/exec.rs:362`).

BB instead has a canonical ladder shared by all providers and reads each
provider's *live* per-model effort list:

- Canonical values and rank: `packages/domain/src/shared-types.ts:4`,
  reconciliation in `packages/domain/src/reasoning-level.ts`.
- Codex maps `ultra` through and rejects `ultracode`
  (`plugins/provider-codex/src/models.ts:53`).
- Claude advertises `ultracode` for **every** model that reports `xhigh`, and
  maps it to `effort:"xhigh"` + `settings.ultracode:true`
  (`plugins/provider-claude-code/src/model-list.ts:38`,
  `plugins/provider-claude-code/src/bridge/session-options.ts:64`).
- ACP reads the config option whose `category === "thought_level"` and forwards
  the agent's own values and labels
  (`packages/provider-bridge-acp-next/src/bridge/model-catalog.ts:129`,
  set at `.../bridge/bridge.ts:1508`).

### 1.3 Dictation

Bitbots is on-device only: `bloblex-speech` bundles sherpa-onnx + cpal and
requires a model download (`crates/bloblex-speech/src/model_manager.rs`,
`manifest.rs`).

BB has **two** transcription backends and does not ship a model:

- `bb cloud` (`plugins/bb-ai/src/server.ts`) via the getbb.app account gateway.
- `codex` (`plugins/provider-codex/src/ai-service.ts`), which reuses the local
  **Codex CLI login** (`plugins/provider-codex/src/ai/codex-auth.ts`) and calls
  `chatgpt.com/backend-api/transcribe` with `gpt-transcribe`
  (`plugins/provider-codex/src/ai/chatgpt-client.ts:23`), falling back to
  `api.openai.com/v1/audio/transcriptions` for API-key auth.
- Selection is per task, defaulting to `automatic`
  (`packages/domain/src/ai-services.ts:37`), which skips services that are not
  ready and falls through (`apps/server/src/services/ai/ai-tasks.ts:73`, `:212`).

This is why dictation in BB works without a getbb.app account when the user has
run `codex login`: the Codex service answers from the user's ChatGPT session.

---

## 2. Goals, non-goals, and success criteria

**Goals**

- Correct, provider-faithful effort labeling: Codex `Ultra`, Claude
  `Ultracode` and `Max`, and OpenCode/Go per-model efforts that BB can show.
- Robust, low-friction CLI connectivity with honest capability reporting.
- Dictation that works with no model download for users who already have a
  supported CLI login, while keeping the existing on-device path.

**Success criteria (verifiable)**

- Switching models reconciles the selected effort against the target model's
  reported levels using a shared ladder, not per-adapter ad hoc order.
- For a model whose catalog reports `xhigh`, the Claude effort control offers
  `Ultracode` whether or not workflows are enabled for the session.
- For an OpenCode model, the effort control lists that model's real effort
  options (from the ACP `thought_level` option) and marking one does not
  produce the "cannot obtain effort" state.
- A Codex model whose catalog reports `ultra` displays `Ultra`, distinct from
  `Max`, and selecting it sends `ultra` on the wire.
- With a logged-in Codex CLI and no downloaded speech model, dictation
  transcribes end to end; with no such login, it falls back cleanly.

**Non-goals**

- Mobile apps, tunnels, remote access, and account systems (deferred).
- Multi-session/thread orchestration. Bitbots stays single-session with
  bot-to-bot communication.
- Replacing the daemon's decision ownership or copying provider credentials.

---

## 3. Workstream A — Unified reasoning/effort ladder

**Problem.** Effort ordering and reconciliation are re-implemented per adapter
and in the frontend; capability is declared inconsistently, and OpenCode's real
efforts are not read.

**A1. Add a shared ladder module.**
- New module (suggested `bloblex-agent-core::reasoning` or a small
  `bloblex-reasoning` crate) with:
  - `REASONING_LEVELS = [none, low, medium, high, xhigh, ultracode, max, ultra]`
    and a rank function.
  - `reconcile(previous, supported) -> level` that treats `ultracode` as
    `xhigh` when the target model lacks it and otherwise picks the nearest
    ranked level.
- Replace the ad-hoc sort in
  `crates/bloblex-adapter-claude/src/lib.rs:161` and the daemon's
  `normalize_model_fields` logic (`crates/bloblex-daemon/src/main.rs:1227`)
  with calls to the shared module.

**A2. Claude: advertise `Ultracode` per model, not per session.**
- Change `offer_ultracode` (`crates/bloblex-adapter-claude/src/lib.rs:193`) so
  any model reporting `xhigh` also lists `ultracode`, independent of
  `claude.enableWorkflows`.
- Keep the execution mapping already present: `ultracode` → `--effort xhigh`
  plus `{"ultracode":true}` (`typed_args`, `:203`); only enable the workflow
  setting at send time, exactly as BB does.
- Acceptance: the mounted effort control shows `Ultracode` for `xhigh` models
  with workflows off.

**A3. Codex: make `ultra` first-class.**
- Confirm the daemon rank logic and any allowlists include `ultra` above `max`.
- Keep raw pass-through (`mapBbReasoningLevelToCodex` equivalent): `ultra`
  goes to the wire; `ultracode` is rejected for Codex with a clear message.
- Acceptance: selecting a model that reports `ultra` shows `Ultra`, and the
  turn request carries `"ultra"`.

**A4. OpenCode/ACP: read the real effort option.**
- In `crates/bloblex-adapter-acp/src/catalog.rs` / `exec.rs`, find the config
  option by `category == "thought_level"` (fallback ids: `effort`,
  `reasoning_effort`) and populate each model's `supported_thinking` from its
  option `value`s. Use the option `name` as the display label when present.
- Keep applying effort through `session/set_config_option`
  (`crates/bloblex-adapter-acp/src/lib.rs:763`), addressed by the discovered
  option id rather than a hard-coded `"effort"`.
- Stop treating the effort echo as unusable: after a successful
  `set_config_option` whose returned `currentValue` matches the request, record
  `provider_echo` evidence instead of `none`
  (`crates/bloblex-adapter-acp/src/exec.rs:362`).
- Acceptance: an OpenCode model lists its ACP-reported efforts and selecting
  one persists and echoes.

**A5. Preserve provider labels/descriptions (optional, low risk).**
- Keep the effort description from the provider (Codex
  `supportedReasoningEfforts[].description`) in `ModelInfo` so the UI can show
  the provider's own wording rather than only a derived label.
- Frontend `labelizeEffort` (`apps/desktop/src/ui/effortLabels.ts`) stays as a
  fallback.

**A6. Gate/evidence correction for OpenCode.**
- Make the default for OpenCode thinking permissive: derive availability from
  the catalog instead of `exec_gate.opencode.thinking` defaulting false
  (`crates/bloblex-daemon/src/main.rs:1381`).
- Update `runtime_capabilities` for `opencode` thinking from
  `evidence: "none"` to `provider_echo` with `scope: "session"`
  (`crates/bloblex-daemon/src/main.rs:1410`).
- Update the fixture bridge so the preview no longer hard-codes OpenCode
  thinking as gated (`apps/desktop/src/preview/fixtureBridge.ts:456`).

---

## 4. Workstream B — CLI connectivity hardening

**Problem.** Connectivity works, but resilience and honest reporting across
CLI versions are thin compared to BB.

**B1. Capability probing and honest status.**
- Record recognized CLI versions per provider and expose an "installed /
  signed in / version recognized" status (`runtimeDiscovery` already exists).
  Mirror BB's `maintenance: { health, usage, installation }`.
- Acceptance: a signed-out or missing CLI surfaces a clear, actionable state
  rather than an empty catalog.

**B2. Rate-limit and transient-failure recovery.**
- Add bounded retry/backoff for provider rate limits and transient RPC errors
  in the adapters, and surface "rate limited; retrying" in the UI. BB ships a
  dedicated `provider-retry` plugin and per-provider recovery tests.
- Acceptance: a simulated 429/overloaded response retries with backoff and then
  either succeeds or reports a clear terminal state.

**B3. Stream/session robustness audit.**
- Audit the Codex and ACP turn loops against BB's recovery patterns
  (reconnect, writer lock, zero-work turn, session signature, resume
  hydration). Fix any unprotected re-entrancy or partial-write paths.
- Acceptance: race/recovery tests added for each fixed path using fake peers.

**B4. Model catalog freshness.**
- Ensure `refresh` bypasses the 60s cache and that a stale/fallback catalog is
  labeled as such in the UI (`fetch_model_catalog_for`,
  `crates/bloblex-daemon/src/main.rs:1184`). Confirm a fallback catalog never
  authorizes a model/effort change as if validated.

---

## 5. Workstream C — Dictation without a model download

**Problem.** Today dictation is blocked on a model download. Users who have a
supported CLI login should get working dictation immediately, and the local
engine should remain the private fallback.

**C1. Introduce a `SpeechProvider` abstraction.**
- In `bloblex-speech`, define a provider trait with two operations: list
  providers + availability, and `transcribe(audio) -> transcript`. Wire the
  existing sherpa-onnx engine as one provider.
- Acceptance: the dictation entry point works against the trait with the local
  provider unchanged.

**C2. Add a Codex-auth remote provider.**
- Read the user's Codex auth read-only from the Codex home
  (`auth.json`), decode the ChatGPT access token and account id, and POST the
  recorded audio to `chatgpt.com/backend-api/transcribe` with model
  `gpt-transcribe`; fall back to `api.openai.com/v1/audio/transcriptions` when
  the auth file holds an API key.
- Never persist or log the token or the raw response. Record only a status
  (ready / not signed in / rate limited).
- This is best-effort against a private endpoint: handle Cloudflare challenges
  and non-200 with a clear message and a fallback.
- Acceptance: with a logged-in Codex CLI, a recording transcribes with no model
  downloaded; with it absent, the provider reports not-ready and the local
  provider is used.

**C3. Optional BYO-key provider.**
- Add a settings-level remote provider for a user-supplied key (OpenAI /
  Groq / Deepgram), stored via the existing secrets facility
  (`bloblex-security`), never in docs or logs.
- Acceptance: configuring a key enables transcription with no model download;
  clearing it reverts to local.

**C4. Selection, ordering, and UX.**
- Add per-source selection with `automatic` default: prefer an available remote
  provider, fall through to local, and expose "off".
- Show which engine produced a transcript only as a status, never as content.
- Keep the on-first-use local model download as an explicit, optional action
  rather than a blocker.

**C5. Privacy and consent.**
- Because a remote provider sends audio off-device, surface an explicit,
  per-source consent and a clear indicator when remote transcription is used,
  consistent with Bitbots' local-first posture.

---

## 6. Workstream D — Permission/sandbox correctness (secondary)

Discussed alongside CLI connectivity; smaller but worth including.

**D1. Separate sandbox scope from approval.**
- Model `sandboxScope: workspace | full` independently of the approval mode so
  `ask`/`auto` stay sandboxed and only `bypass` widens. See
  `docs/APPROVAL_MODES.md` for the current single-axis model.

**D2. Widen the sandbox in bypass.**
- Ensure Codex bypass sets `sandbox: danger-full-access` with a matching
  `sandboxPolicy` (not just `approvalPolicy: never`) so the agent is not
  trapped inside `workspace-write`.

**D3. Git-aware writable roots.**
- Compute the real git dir/refs/objects writable roots so sandboxed/auto agents
  can still commit (BB derives these in
  `plugins/provider-codex/src/session-params.ts`).

**D4. Fail-closed auto review.**
- Keep the daemon classifier authoritative and fail closed on unknown
  categories; optionally surface the provider's own auto-review as an
  additional signal.

---

## 7. Workstream E — Scheduled automations (proposed addition)

**Reference (BB).** An automation is a scheduled task on a project with a
trigger (cron + timezone, or one-shot date/delay) and an execution in one of
two modes: `agent` (spawn or re-prompt a thread with a pinned
provider/model/reasoning/permission) or `script` (stored bash/sh/node/python3
with recorded stdout/stderr/exit). Scheduling is a background sweep inside the
server process; management is a CLI/panel with run history
(`plugins/automations/PLUGIN_OVERVIEW.md`, `src/service.ts`).

**Constraint to state up front.** Automations run on the machine that hosts the
daemon, so **the computer must be running** for a run to fire. There is no cloud
scheduler. The UI must say this plainly, and define what happens to runs missed
while the machine was off (skip vs catch-up — an open question below).

**E1. Trigger model.**
- Recurring: cron expression + IANA timezone. One-shot: absolute timestamp or a
  relative delay (`2h`, `1d`).
- Compute and persist `nextRunAt`; validate cron/timezone and reject
  invalid/expired one-shots at creation and on resume.
- Acceptance: schedule validation and next-run computation unit tests,
  including DST boundaries.

**E2. Execution modes.**
- `agent`: bind a blob/session target plus provider, model, effort, approval
  mode; either spawn a new session per run or re-prompt an existing one.
- `script`: store a script and a working-directory policy
  (`automation-storage` | `project` | absolute daemon-host path); capture
  stdout/stderr/exit; a run that prints nothing is a silent tick, and
  `{"wakeAgent": false}` explicitly skips.
- Acceptance: fake-provider agent run and sandboxed script run both record a
  run row with status, timings, and output.

**E3. Lifecycle and safety.**
- Pause/resume, manual run with an idempotency key, run history with paging,
  and consecutive-failure tracking that resets on resume.
- **Recursion guard**: a session spawned by an automation cannot create
  automations.
- Execute unattended under the daemon's existing budgets, kill switch, and
  approval policy; default to the safest approval mode; persist an audit event
  per run.
- Acceptance: recursion rejected, pause halts scheduling, kill switch stops a
  running automation.

**E4. Surface.**
- Daemon RPCs mirroring `create/list/show/update/pause/resume/run/runs/delete`,
  plus a panel and per-automation run history. Keep everything `--json`-able
  for the CLI/agents.
- Acceptance: mounted UI test for create/edit/pause/run and a run-history view.

**Risk.** Automations run real commands and prompts with no human present, so
E3's safety rails are mandatory, not optional.

---

## 8. Cross-cutting: evidence and testing

- Every change ships with deterministic tests using fake peers (existing
  pattern: `fake_acp_peer`, `fake_codex_server`).
- Distinguish, in docs, source-only implementation from verified live behavior.
- Add regression tests for: ladder reconciliation, Ultracode advertisement with
  workflows off, OpenCode `thought_level` parsing and selection, Codex `ultra`
  pass-through, dictation provider selection/fallback, and remote-provider
  consent.
- No provider credentials or tokens in tests, fixtures, docs, or logs.

---

## 9. Suggested phasing

| Phase | Contents | Notes |
| --- | --- | --- |
| 1 | A1 shared ladder; A2 Claude Ultracode; A3 Codex `ultra` | Highest user-visible correctness; low risk |
| 2 | A4/A5/A6 OpenCode effort read + gate/evidence fix | Fixes the reported OpenCode gap |
| 3 | C1 `SpeechProvider`; C2 Codex-auth remote dictation | Removes the download blocker |
| 4 | B1/B2 status + retry; C3 BYO-key; C4/C5 selection/consent | Resilience and choice |
| 5 | B3/B4 robustness audit; D1–D4 permissions | Hardening |
| 6 | E1–E4 scheduled automations | New capability; needs the safety rails in E3 |

Each phase is independently reviewable and revertible.

---

## 10. Risks and open questions

- The ChatGPT transcription endpoint is private and can change; treat C2 as
  best-effort with a local fallback, and never block dictation on it.
- OpenCode's ACP config-option naming may vary by version; support
  `thought_level` plus id fallbacks and read the option name for labels.
- Advertising Ultracode for all `xhigh` models must still be rejected at send
  time if the CLI reports workflows unavailable, so we do not fabricate
  capability.
- Confirm with the Director whether effort descriptions/labels (A5) are in
  scope for the current UI.
- **Automations (E):** decide the missed-run policy when the machine was off at
  the trigger time — skip, or catch up once on next start. BB only advances
  `nextRunAt`, so a sleeping host silently misses runs; Bitbots should pick and
  document one behavior.
- **Automations (E):** decide whether Bitbots ever wants an always-on
  scheduler. Without a hosted daemon, "the computer must be on" is inherent;
  keep it out of scope unless the Director wants a hosted option.

---

## 11. Appendix — Deferred: mobile

Mobile is intentionally out of scope for this plan. For reference, BB's model
is a thin native Expo shell around the same web UI, reaching the user's machine
through an outbound tunnel (`@bb/tunnel-client` + the `apps/connect` relay),
with QR pairing (`@bb/connect-client`), a desktop-session cookie gate, Expo
push, and universal links. If Bitbots later wants a phone client, the
proportionate path is to serve the existing UI over LAN as a PWA (gated by the
existing capability system) with QR pairing, rather than a native app plus a
hosted tunnel/account service. This is recorded here only so the decision is
not lost; it is not part of this plan.

---

## 12. Appendix — Account and hosted services (reference)

Bitbots is deliberately account-less and local-first. This appendix records what
BB's getbb.app account adds, so the Director can decide later whether any of it
is worth an optional hosted tier.

**With a BB account:**
- Remote access via an outbound tunnel (server dials the getbb.app gate, giving
  `https://<handle>.getbb.app` from any browser and enabling mobile pairing).
- Hosted AI (`bb cloud`): thread titles, commit messages, and voice
  transcription, metered against a daily quota.
- A dashboard that lists servers, revokes machines/devices, and mints pairing
  codes; one account-scoped credential covers every server.

**Without an account (everything local still works):**
- The daemon, agents via the user's own CLI logins (Claude Code, Codex,
  OpenCode), the local UI, on-device dictation, the Codex-auth dictation path
  (C2), LAN/Tailscale access, and scheduled automations while the machine runs.

**Implications for this plan.**
- Workstreams A–D and E require **no** account; they rely on the user's existing
  CLI logins, consistent with Bitbots' invariants.
- If Bitbots ever wants phone access or hosted dictation without a CLI login,
  that is the point at which an optional account + relay + quota would be
  needed. Keep it strictly optional and off by default; do not reintroduce
  copied provider credentials or a mandatory sign-in.
