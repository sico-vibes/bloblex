---
name: Bloblex blobs and analytics
overview: End-to-end plan to turn Bloblex's one-blob-per-CLI shell into a roster of configurable blobs (name, colour, specialty, instructions, runtime, model, thinking, speed), with per-blob project/session trees, Grok Bot-style settings, Multica-style cost analytics, the new logo, and the remaining native/release gates. Multica is reimplemented clean-room; its licence forbids copying code.
todos:
  - id: store-plan
    content: Save this plan as docs/E2E_PLAN_V2.md and link it from SESSION_HANDOFF.md and AGENTS.md
    status: pending
  - id: logo
    content: "Phase 1: transparent logo master, regenerate bloblex.ico/PNGs/tray.png, use logo in sidebar header"
    status: pending
  - id: agents-backend
    content: "Phase 2: agents table + migration/backfill, agent.* RPCs, ExecOptions in agent-core, session.new by agentId, exec_snapshot"
    status: pending
  - id: adapter-exec
    content: "Phase 2: map model/thinking/speed/instructions/args/env per adapter (Claude, Codex, OpenCode) with blocklists and tests"
    status: pending
  - id: model-catalog
    content: "Phase 2: runtime.models RPC (codex debug models, claude list_models/fallback, opencode models) with cache and refresh"
    status: pending
  - id: concurrency-usage
    content: "Phase 2: per-blob concurrency limit; agent_id on usage_events; ACP usage where available"
    status: pending
  - id: blob-ui
    content: "Phase 3: blob roster, create/edit/duplicate/archive, blob page tabs, colour swatches, execution settings UI"
    status: pending
  - id: session-tree
    content: "Phase 4: expandable per-blob project/session tree in sidebar, new-session-in-project, persistence"
    status: pending
  - id: analytics
    content: "Phase 5: usage.analytics RPC and Analytics view (cards, chart toggles, leaderboard, errors, lower-bound notation)"
    status: pending
  - id: settings-redesign
    content: "Phase 6: Grok Bot-style settings modal with only working controls"
    status: pending
  - id: native-release
    content: "Phase 7: native verification pass and remaining release gates from implementation-status.md"
    status: pending
isProject: false
---

# Bloblex E2E plan: configurable blobs, sessions tree, analytics, release

## Starting point (verified 1 Oct 2026, 22:40)

- **UI:**
  - The character engine, the companion island and the OpenMausBot-style shell are done (78/78 tests passing).
  - The sidebar lists one blob per detected CLI (`runtimeRows` in [apps/desktop/src/ui/App.tsx](apps/desktop/src/ui/App.tsx)).
- **Daemon:**
  - `session.new` takes only `{ runtimeId, projectPath, title }`.
  - [crates/bloblex-agent-core/src/lib.rs](crates/bloblex-agent-core/src/lib.rs) `NewSessionRequest` / `PromptRequest` carry no model, effort, speed or instructions.
  - `runtime.profile.*` holds launcher profiles (executable and fixed args), not personas.
- **Adapters:** all launch with fixed args.
  - Claude: `-p --output-format stream-json ...`
  - Codex: `app-server --listen stdio://`, with `thread/start` = cwd, approval and sandbox only.
  - OpenCode: `acp --cwd`. It reports no usage.
- **Storage** ([crates/bloblex-storage/src/lib.rs](crates/bloblex-storage/src/lib.rs)):
  - `sessions.project_path` exists.
  - `usage_events` already holds model and tokens, plus `usage_valuations` by basis.
  - `usage.summary` only returns global totals. There is no breakdown by agent, day or model.
- **Discovery:** `discover()` in [crates/bloblex-runtime/src/lib.rs](crates/bloblex-runtime/src/lib.rs) does not list models.
- **Icons:**
  - The new `assets/icon/bloblex.png` is 960 px on an opaque white background.
  - `bloblex.ico` and `tray.png` are still the old ones. `tray.png` is embedded via `include_bytes!` at [apps/desktop/src-tauri/src/lib.rs](apps/desktop/src-tauri/src/lib.rs) around line 1361.
- **Multica licence:** Apache 2.0 plus extra conditions. These forbid embedding it in distributed products and require Multica branding on any derived UI. All Multica behaviour below is a clean-room reimplementation, and no Multica code is copied.

## Target data model

```mermaid
flowchart LR
  Blob["Blob: name, colour, description, instructions"] -->|uses| Runtime["Runtime: detected CLI"]
  Blob -->|"exec: model, thinking, speed, args, env, concurrency"| ExecOpts[ExecOptions]
  Blob --> Project["Project: folder path"]
  Project --> Session[Session]
  Session --> Turn["Turn = run"]
  Turn --> Usage[UsageEvent]
  Usage --> Valuation["Valuation: actual or estimate or unknown"]
  ExecOpts -->|"applied at session.new / resume / turn"| Adapter["CLI adapter"]
```



**New `agents` table (the blobs):**

- **Profile:** `id`, `name`, `description` (up to 255 characters), `instructions` (long text), `color` (one of 12 swatches or hex).
- **Execution:** `runtime_id`, `model` (null = CLI default), `thinking` (null = default), `service_tier` (null / `standard` / `fast`), `custom_args` (JSON), `custom_env` (JSON, non-secret keys only), `max_concurrency` (1–50).
- **Housekeeping:** `default_project`, `sort_order`, `archived`, `created_at`, `updated_at`.

**Changes to existing tables:**

- `sessions` gains `agent_id`, plus `exec_snapshot` (JSON). The snapshot records what was actually applied, so the history stays honest after a blob's settings change.
- `usage_events` gains `agent_id`, copied from the session at insert time.
- **Migration:** create one default blob per existing runtime, then backfill `sessions.agent_id` from `runtime_id`.

## Phase 1: Logo and icons (small, independent)

- Add `scripts/prepare-logo.ps1` (System.Drawing). It flood-fills from the corners so the near-white pixels touching the border become transparent, then writes `assets/icon/bloblex-master.png` at 1024 px. Keep the user's `bloblex.png` as the original.
- Generate `bloblex.ico` (16/24/32/48/64/128/256) and the PNG set with `npx tauri icon assets/icon/bloblex-master.png -o assets/icon/generated`. Copy the ico over `assets/icon/bloblex.ico`.
- Produce `tray.png` at 32 px from the master, plus a 16 px variant if the tray code supports it.
- Replace the CSS `BlobMark` in the sidebar header with the logo image.
- **Gate:** icons visible in the build, the installer and the tray, with no white halo on a dark taskbar.

## Phase 2: Blobs as first-class agents (daemon and storage)

**Storage:**

- Add the `agents` migration, `agent.list/get/create/update/delete/reorder` RPCs and `agent.changed` events. Include agents in `app.snapshot`.

**Agent core:**

- Add `ExecOptions { model, thinking, service_tier, instructions, extra_args, env }` to `NewSessionRequest`, the resume request and `PromptRequest`.
- `session.new` takes `{ agentId, projectPath, title? }`. `runtimeId` stays accepted for backward compatibility.

**Per-adapter mapping:** confirm each one against the installed CLI's help text or schema at discovery time, and record what each runtime supports.

- **Claude:**
  - `--model <id>` and `--effort <level>`.
  - Instructions go through `--append-system-prompt-file <app-local temp file>`, so prompt text stays out of argv. If that flag is unsupported, prepend the instructions to the first stdin message inside a clear delimiter.
  - Speed: no native tier, so the picker is hidden.
- **Codex:**
  - `thread/start.model`.
  - Effort: `config.model_reasoning_effort` on `thread/start` and `thread/resume`, and `effort` on `turn/start`.
  - Speed: `serviceTier`.
  - Instructions: the developer-instructions field of `thread/start`. Confirm the field name with `codex app-server generate-json-schema`.
- **OpenCode (ACP):**
  - Model, plus instructions as an agent prompt, go into `OPENCODE_CONFIG_CONTENT` (a JSON env var).
  - Effort maps to a variant where the model exposes one.
  - Speed: none.
- **Safety rules:**
  - Custom args can't override protocol, permission or output flags (keep a per-adapter blocklist).
  - Custom env rejects secret-looking keys, matching the existing `settings.set` rule.
  - Never log env values or instructions in raw events.

**Model catalog:**

- New `runtime.models { runtimeId, refresh? }` RPC with a 60 s cache:
  - Codex: `codex debug models`, which returns slugs, reasoning levels, default level and service tiers.
  - Claude: stream-json `list_models` where supported, otherwise a static fallback marked `fallback: true`.
  - OpenCode: `opencode models --verbose`.
- Typing a custom model ID is always allowed.

**Concurrency:**

- The daemon counts active turns per blob and rejects work beyond `max_concurrency` with an actionable error. Queueing is deferred.

**Usage capture:**

- Add OpenCode/ACP usage where the protocol emits it; otherwise count the run as unreported.
- Set `agent_id` on every usage event.

**Gate:** real Codex and Claude sessions start with each setting and the `exec_snapshot` shows it, verified by provider-side evidence such as the model name in the usage events. The tests must assert argv, JSON-RPC and env per adapter.

## Phase 3: Blob roster and editor (UI)

**Sidebar rows:**

- Each row shows the blob's own colour, name, last-message preview and time. Search covers blob names and session titles.
- Right-click actions: New session, Edit blob, Duplicate, Archive.
- "+" in the sidebar header opens Create blob.

**Blob page:** opened by clicking the header name or choosing "Edit blob". It replaces the chat pane, and Back returns to the chat. Four tabs, styled like Multica's agent page:

- **Overview:**
  - The live blob preview at 96 px, plus name, description, runtime, model, status and quick usage.
  - The Grok Bot-style swatch grid: the same 12 colours, no shapes.
- **Sessions:** the full project/session list for this blob.
- **Usage:** the blob-scoped analytics described in Phase 5.
- **Settings:** the Profile card and the Execution card.
  - **Profile card:** colour, Name, Description with a "92 / 255" counter, and Instructions.
  - **Execution card:**
    - Runtime dropdown listing detected CLIs with an online dot.
    - Searchable Model picker with refresh and custom ID entry.
    - Thinking picker using the runtime's own levels, plus "Runtime default".
    - Speed: Standard, Fast or "Runtime default". It is hidden where unsupported.
    - Concurrency.
  - **Advanced:** custom args, environment and default project.
- Settings apply to new sessions and new turns. The UI says so, and the chat header model pill shows the snapshot actually applied.

**Engine:**

- `BlobCanvas` already accepts any `color`. Swap `providerColor(runtime)` for `agent.color` everywhere: the sidebar, chat, companion and minis.
- The provider stays visible as a small runtime label, not as the blob's colour.

**Gate:** create, edit, duplicate and archive persist across restarts. Two blobs on the same CLI run independently with different settings.

## Phase 4: Per-blob project and session tree (sidebar)

- A chevron sits on the right edge of each blob row, revealed on hover or focus. It never overlaps the face.
- Expanding the row shows an indented tree beneath it, styled like Claude desktop's grouping:
  - Projects, named by folder, each with its own chevron and a "+" for "New session in this project".
  - Under each project, sessions with a status dot, title and relative time. The active session is highlighted.
- "New session" offers this blob's recent projects first, then "Choose folder...".
- **Persistence:** keep expanded state per blob in localStorage. The header conversation switcher stays for keyboard users.
- The companion's chat tab follows the blob's selected session. Its pills switch between blobs.
- **Gate:** the same blob can hold several sessions in one project and in multiple projects. Selection, resume and cancel work from the tree, and the keyboard flow is arrow keys, Enter and context menu.

## Phase 5: Cost and usage analytics (Multica-style, clean-room)

**Daemon:**

- New `usage.analytics { from, to, bucket: day|week, tz, projectPath?, agentId? }`. It returns:
  - Totals: cost, tokens (input, output, cache read, cache write), run time, runs and failed runs.
  - A series per bucket for each of those metrics.
  - A leaderboard per blob: tokens, cost, time, runs, `unreportedRuns` and `unpricedModels`.
- Runs are turns. Run time is `completed_at - created_at`, and a failed run is a turn in the `error` state.

**Cost rule:**

- Cost = provider-reported actual cost + an API-rate estimate from `pricing_rules` / user overrides for the uncosted tokens.
- Unknown prices stay unknown, never $0.
- Prefix "≥" whenever any run is unreported or any model is unpriced, and show "N runs did not report usage".
- Subscription fees are shown separately and never mixed into usage cost.

**UI:** an Analytics view opened from the sidebar "Usage" link, with the same component reused on the blob Usage tab.

- Range picker (7d / 30d / 90d) and project filter.
- Four summary cards: Cost, Tokens, Run time, Runs.
- A bar chart with a Tokens / Cost / Time / Runs toggle and a Daily / Weekly toggle. Draw it with plain SVG; no chart dependency.
- The leaderboard with bars and the "≥" notation.
- An Errors tab listing failed turns.

**Gate:** the totals reconcile with the raw `usage_events` in fixture tests, partial data is labelled correctly, and timezone bucketing is tested.

## Phase 6: Settings redesign (Grok Bot style)

- Restyle `SettingsSheet` as a modal: a 200 px left nav with icons, and content laid out as titled groups of rounded card rows. Each row has a label on the left and a control on the right (a pill select or a toggle).
- **Pages:**
  - **General:**
    - Appearance: theme and language, set to "Follow system" or Dark only until implemented.
    - System: start with Windows, close to tray, companion monitor.
    - Companion: show the companion, sounds.
  - **Agents:** the blob list, with links to each blob page.
  - **Runtimes:** detected CLIs, launcher profiles, auth state.
  - **Usage and Billing:** budgets, pricing overrides, subscriptions, currency.
  - **Permissions:** default approval policy.
  - **Updates:** version, plus an honest "not configured" until signing and the updater exist.
- Keep only controls that have a working consumer. Anything else shows an "Unavailable" state, per the existing AGENTS.md rule.
- **Gate:** every visible control persists and has an effect, and the existing settings tests stay green.

## Phase 7: Native verification and release hardening

- `npm run desktop:dev`, with an isolated DB, against the real app:
  - companion transparency, free drag, DPI and multiple monitors, and resize timing;
  - real file drop;
  - approvals in both windows;
  - the tray, including Pause all;
  - keyboard and focus;
  - reduced motion;
  - Quit and process-tree cleanup.
- Carry over the open items from [docs/implementation-status.md](docs/implementation-status.md): installer, signing, updater, clean-VM install, and WSL.
- **Later options:** a Pi adapter (`--model`, `--thinking`, `-p --mode json`), task queueing beyond the concurrency limit, and avatar upload or generation.

## Cross-cutting rules

- Prompts and instructions travel only via stdin, protocol fields or temp files, never as large argv strings.
- No credentials appear in logs or docs.
- The daemon owns state. React only renders normalized data.
- Each phase ships with:
  - unit and mounted tests;
  - fixture-preview pages (extend [apps/desktop/src/preview/fixtureBridge.ts](apps/desktop/src/preview/fixtureBridge.ts));
  - an updated [SESSION_HANDOFF.md](SESSION_HANDOFF.md).
- Record the clean-room note for Multica in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Store this plan as `docs/E2E_PLAN_V2.md` and link it from `SESSION_HANDOFF.md` and `AGENTS.md`.

## Suggested order

Phase 1 → 2 → 3 → 4 → 5 → 6 → 7. Phase 1 and the Phase 6 visual shell can run in parallel with Phase 2.