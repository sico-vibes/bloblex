# Phase 3 implementation spec: blob roster and editor

This is the implementation contract for Phase 3 of [E2E_PLAN_V2.md](E2E_PLAN_V2.md). Phase 3 replaces the runtime-per-row sidebar with one row per blob, and adds the blob editor. It depends only on Phase 2a, as specified in [PHASE_2A_SPEC.md](PHASE_2A_SPEC.md). Execution fields may be displayed. They must not be described as working.

Line citations are the source this spec was written against. Phase 2a may land beside this document; where this spec names a type, RPC, or event, implement that shape from PHASE_2A_SPEC.md rather than from an older TypeScript file. Do not edit Rust. Do not copy another product's layout, labels, or assets. Multica is a clean-room behavioural reference only ([THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) lines 37–39, [E2E_PLAN_V2.md](E2E_PLAN_V2.md) line 13). The shell to extend is the one already in the repo: OpenMausBot / Midnight chat chrome in [apps/desktop/src/ui/shell.css](../apps/desktop/src/ui/shell.css) lines 1–4, with Bloblex's own circular faces.

## 1. Scope and non-scope

Phase 3 ships the roster, the create / edit / duplicate / archive flows, agent colour on every blob face, and `session.new` by `agentId`. It renders Phase 2a data and nothing past it.

Phase 2a delivers persisted agents, `agent.list` / `get` / `create` / `update` / `delete` / `reorder`, `agent.changed`, snapshot `agents` (including archived rows), and `session.new` with exactly one of `agentId` or `runtimeId` ([E2E_PLAN_V2.md](E2E_PLAN_V2.md) line 5 and lines 81–89, [PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) lines 102–171). Columns `model`, `thinking`, `service_tier`, `custom_args`, `custom_env`, and `max_concurrency` are stored and inert: no adapter receives them, and `session.new` accepts no execution options ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) lines 3 and 85). Phase 3 displays those execution fields as unavailable. It does not enable them when [docs/runtime-capabilities.md](runtime-capabilities.md) says a CLI could accept a flag. That file is the Phase 2b record, not a Phase 3 picker source.

In scope:

- Sidebar roster of non-archived agents, ordered as specified in section 2.
- Search over agent names and session titles.
- Context menu: New session, Edit blob, Duplicate, Archive.
- Header "+" creates a blob. New session stays on the row menu, the chat header, the empty conversation, and the companion.
- Blob page with Overview, Sessions, Usage, and Settings, replacing the chat pane.
- Profile edits saved through `agent.create` / `agent.update`. Archive through `agent.delete` (soft archive).
- Agent colour on roster, chat, inspector, and companion faces, including minis and pills.
- Fixture agents and mounted tests. No daemon process.

Explicitly deferred. Do not build these in Phase 3:

| Deferred | Where it belongs | What Phase 3 shows instead |
|---|---|---|
| Live model, thinking, and speed pickers, including refresh and custom model IDs | Phase 2b ([E2E_PLAN_V2.md](E2E_PLAN_V2.md) lines 91–148) | Disabled controls, reason "Available in a later update." |
| Concurrency enforcement | Phase 2b | The stored `maxConcurrency` number, disabled, same reason |
| Custom args and custom env editors | Phase 2b allowlists are empty for user args ([E2E_PLAN_V2.md](E2E_PLAN_V2.md) lines 117–121). Showing editors would imply they are sent. | Not rendered. One sentence: "Custom arguments and environment are not available yet." |
| Per-blob project / session tree, chevron, expanded state | Phase 4 ([E2E_PLAN_V2.md](E2E_PLAN_V2.md) lines 189–200) | Flat session list on the blob Sessions tab, and the existing header `<select>` |
| Usage tab analytics, charts, leaderboard, per-blob totals | Phase 5 ([E2E_PLAN_V2.md](E2E_PLAN_V2.md) lines 202–227) | "Not available yet." No zeros, no global `usage.summary` presented as this blob's usage |
| Settings sheet redesign | Phase 6 | Leave `SettingsSheet` and its pages as they are |
| Drag reorder | Not in the Phase 3 plan. `agent.reorder` exists in 2a ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 148) but Phase 3 does not call it | Roster order is display-only. A later phase can send the full active id list for one runtime |
| Restore of an archived blob | 2a has no restore. `agent.update` on an archived row returns `conflict` ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 146) | Archived agents are hidden. See section 2 |

The Phase 3 gate in the plan ("two blobs on the same CLI run independently with different settings", [E2E_PLAN_V2.md](E2E_PLAN_V2.md) line 183) means two agents can share a `runtimeId` and differ in name, colour, description, instructions, and default project, with sessions linked by `agentId`. It does not mean different models are applied. Phase 3 must not claim that.

## 2. Information architecture

The sidebar keeps the current shell: brand, search, scrollable list, Usage link, Find agents, connection line, settings button ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 410–446). Rows stop being runtimes.

### Roster membership and order

One row per agent with `archived === false`. Archived agents stay in snapshot state and are omitted here ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) lines 175–177).

`sortOrder` is a zero-based dense order among active agents of one runtime, not a global order ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) lines 81 and 143). Two agents on different runtimes can both have `sortOrder` 0. The roster therefore groups by `runtimeId`, and inside a group orders by `sortOrder`, then `createdAt`, then `id`. Groups themselves follow `runtimeId` ascending, which is the `agent.list` sort. Do not sort the whole roster by `sortOrder` alone.

Render a group label (the runtime's `labelize(provider)` plus its version when `runtime.version` is a non-empty string) only when the visible roster contains more than one distinct `runtimeId`. A single runtime has no heading, so the list stays as flat as today's `runtimeRows` ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 397–400). Headings are not focusable and are skipped by the arrow keys. Hide a group whose agents are all filtered out by search.

### Row anatomy

Reuse `.bot-row` ([apps/desktop/src/ui/shell.css](../apps/desktop/src/ui/shell.css) lines 41–48). Each row is a `<button>` with `aria-current="true"` on the selected agent. Contents, top to bottom:

1. `BlobCanvas` at 42px, `color` set to the resolved agent hex (section 4), `mood` from `deriveCompanionStatus` for this agent's runtime and this agent's latest session, `label` set to the agent name. Face state already comes from that helper ([apps/desktop/src/ui/companionStatus.ts](../apps/desktop/src/ui/companionStatus.ts) lines 4–32). Pass `connected`, the runtime, and the latest session. Do not pass `composing` on a roster row.
2. Name (`agent.name`, not the provider) and, when the latest session has `updatedAt`, the existing `shortTime` ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 586–592). Omit `<time>` when there is no session.
3. Preview line. Use `latestPreview` ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 573–578) on the latest session whose `agentId` equals this agent. If none, and the daemon is connected, show the status label from `deriveCompanionStatus`. If the daemon is disconnected, show "Daemon disconnected". When search matched a session title and did not match the name, show that title as `Session: {title}` instead of the latest preview, so the hit is visible. If several titles match, use the matching session with the greatest `updatedAt`.
4. A third line, new class `bot-row-meta`: the runtime label (`labelize(provider)`) and the status text, separated by a middle dot. Examples: "Claude · Online", "Codex · Runtime offline". The provider is this label, never the face colour ([E2E_PLAN_V2.md](E2E_PLAN_V2.md) lines 180–181, [DESIGN.md](../DESIGN.md) lines 9 and 29). Keep the existing `.status-dot` as a supplement to the text, using `statusClass` ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 1388–1392). Do not convey status by colour alone ([PRODUCT.md](../PRODUCT.md) line 38).

Latest session means the session with `agentId === agent.id` and the greatest `updatedAt`, tie-broken by `id`. Do not pick a session merely because it shares `runtimeId`. Legacy sessions with `agentId` null are not this agent's latest session.

### Search

Keep the existing input ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 415), including `aria-label="Search agents and conversations"`. Match a row when the trimmed query is empty, or when `agent.name` contains the query, or when any session with that `agentId` has a non-empty `title` containing the query. Compare with `toLocaleLowerCase('en')` on both sides. Do not match description, instructions, project paths, message bodies, or the runtime label. Today's filter falls back to `projectPath` ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 400); Phase 3 stops doing that, because the plan names titles only ([E2E_PLAN_V2.md](E2E_PLAN_V2.md) line 156) and a path match would hit every session on a drive letter.

No matches, while connected and at least one active agent exists: keep `Nothing matches “{search}”.` ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 433).

### Context menu

Replace the runtime menu items ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 516–546). Keep the menu behaviour: open on `contextmenu`, on `ContextMenu`, and on Shift+F10 ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 422–423); focus the first enabled item; Arrow Up/Down, Home, End; Escape and outside pointer close and return focus to the row ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 518–539). Reuse `.runtime-context-menu` ([apps/desktop/src/ui/styles.css](../apps/desktop/src/ui/styles.css) lines 163–168). The title is the agent name.

| Item | Enabled when | Action |
|---|---|---|
| New session | Connected, not busy, and the runtime is usable (section 2, runtime offline) | `session.new` with `{ agentId, projectPath }` as in section 5. Never send `runtimeId` as well |
| Edit blob | Always, including when the runtime is offline | Open the blob page on that agent |
| Duplicate | Connected and not busy | `agent.create` with the copy described below |
| Archive | Connected and not busy | Confirm, then `agent.delete` |

Remove Resume session, Runtime settings, and Stop active session from this menu. Resume and stop stay on the chat header, where they already live ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 460 and 488). Runtime settings stay in the settings sheet.

Duplicate sends `agent.create` with `name` from the copy algorithm below, and the source's `runtimeId`, `description`, `instructions`, `color`, `model`, `thinking`, `serviceTier`, `customArgs`, `customEnv`, `maxConcurrency`, and `defaultProject`. Copying the inert execution fields preserves them for Phase 2b; the new blob still shows those controls disabled. The daemon assigns `id`, timestamps, and `sortOrder` ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 145). Do not send `archived`.

Copy name: start from `Copy of {trimmed source name}`. If that active name is taken, use `Copy of {trimmed source name} (2)`, then `(3)`, and so on. "Taken" is a local hint only: compare `trim` plus `toLocaleLowerCase('en')` against other non-archived names. Rust uses Unicode `to_lowercase()` ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 132), which is not identical to JavaScript for every character. The daemon `conflict` result is authoritative; the local check exists so the common case does not round-trip. Fit the result in 60 Unicode scalar values (section 3): if `Copy of {name}` is longer than 60, drop scalars from the end of the source name until it fits; if a numeric suffix is required, reserve the suffix's scalars and shorten the source name further. Never send an empty name.

Archive confirmation, exact copy: title "Archive {name}?", body "It leaves the roster. Its conversations stay saved. Restoring a blob is not available yet." Buttons: Archive (destructive, class `danger-menu-item` colour is not required on the dialog; use the existing secondary button for Cancel and the primary button for Archive) and Cancel. Focus Cancel first. Escape and Cancel do nothing. Archive calls `agent.delete`. Repeated archive is idempotent on the daemon ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 147); the UI still hides the row once `archived` is true. Do not call `agent.update` to archive.

### "+" create

The sidebar header button is "New session" today ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 413). Change it to Create blob: `aria-label="Create blob"`, `title="Create blob"`. It opens the blob page in create mode. Disable it when disconnected, busy, or when `runtimes.length === 0` (a blob requires a stored runtime, and a missing runtime is `not_found` ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 135)).

New session remains on the context menu, the header pill ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 458), the empty-conversation button, the header more-menu, and the companion plus control.

### Empty state

Connected, no runtimes: keep "No coding CLIs detected yet." and Scan again ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 432). Do not offer Create blob.

Connected, runtimes exist, no active agents: "No blobs yet." and a button "Create blob" that opens create mode. This is separate from the zero-runtime state, because discovery can succeed after every blob has been archived.

### Daemon disconnected

Today a disconnected shell renders both the rows and "Connect to your local runtime to see installed agents." ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 417–434). Phase 3 keeps the last snapshot's active rows when `snapshot.agents` is non-empty, with offline mood, and does not also render that empty sentence. Create, Duplicate, Archive, and New session are disabled. The sidebar foot already says "Runtime offline" / "No agent state available" ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 443); leave that copy. When there is no snapshot yet, show only "Connect to your local runtime to see installed agents."

### Runtime offline, daemon connected

A runtime row may be offline and still be a valid agent identity ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 135). Keep the agent in the roster. Status text is "Runtime offline" when `deriveCompanionStatus` returns that label (runtime status `offline`, `error`, or `disconnected`, [apps/desktop/src/ui/companionStatus.ts](../apps/desktop/src/ui/companionStatus.ts) line 6). New session is disabled. Edit blob stays enabled. The runtime picker on the blob page still lists that runtime.

Usable for New session means: daemon connected, the runtime object is present, and its status is not `offline`, `error`, or `disconnected` (case-insensitive). `online`, `ready`, `available`, and `connected` are usable, matching `statusClass` ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 1388–1392). An unknown status is not usable.

### Archived agents are hidden and not restorable

Phase 3 does not show archived agents, does not offer Restore, and does not send an update that clears `archived`. The 2a contract returns `conflict` for edits of archived rows and says restore exists only if a later phase specifies it ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 146). Archive does not delete the agent or its sessions ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 75 and line 147). Sessions that already exist stay linked and resumable ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 168).

A later phase must add an explicit restore RPC (name it `agent.restore` when that phase is specified) that sets `archived` false, appends `sortOrder` on that runtime, and emits `agent.changed`. Until that RPC exists, no menu item should call `agent.update` on an archived id. Phase 3's only archive UX is the confirm dialog above. Selection fallback when the selected agent becomes archived is in section 5.

## 3. The Blob page

Opened by the chat-title control or by Edit blob ([E2E_PLAN_V2.md](E2E_PLAN_V2.md) line 160). The chat title today is a `<strong>` plus a face ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 451–453). Wrap the face and the name in one `<button>` with `aria-label="Edit {name}"`. Activating it sets the page to edit mode for the selected agent. The session `<select>` stays outside that button ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 455).

The page replaces the conversation pane's scroll and composer. The sidebar stays visible. Back returns to the chat. The settings sheet is not this page.

Create mode uses the same page. Tabs are all visible. Sessions reads "Save this blob to start conversations." Usage reads the same unavailable state as edit mode. Overview shows the draft preview. Settings holds the form. The header Save button says "Create blob".

### Tabs

Four tabs, `role="tablist"`, keyboard pattern copied from the context pane ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 496–497): Arrow Left/Right, Home, End, roving `tabIndex`. Labels, in order: Overview, Sessions, Usage, Settings. Do not reuse another product's tab captions or card arrangement. Lay the page out as a single column on `--app` ([apps/desktop/src/ui/shell.css](../apps/desktop/src/ui/shell.css) line 95), max width matching the chat column, with cards on `--card` ([apps/desktop/src/ui/shell.css](../apps/desktop/src/ui/shell.css) line 10).

One draft is shared by Overview and Settings. The header holds Back, the agent name (or "New blob"), Save, and Cancel. Save and Cancel apply on every tab.

#### Overview

- `BlobCanvas` at 96px, draft colour, mood from `deriveCompanionStatus` for the selected runtime and this agent's selected session (create mode: `idle` when connected, `offline` when not).
- Name and description. Empty description renders the muted sentence "No description".
- Runtime: provider label, status dot, status text.
- Model: the label "Model" and the value "CLI default" when `model` is null, otherwise the stored string, plus the sentence "Bloblex does not send a model until a later update." Do not call this the applied snapshot. Phase 2a stores no execution snapshot ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 85).
- Status: the `deriveCompanionStatus` label.
- Quick usage: the label "Usage" and the value "Not available yet." Do not read `usage.summary`, do not show token counts, and do not show `$0` ([PRODUCT.md](../PRODUCT.md) line 32).
- The 12-swatch grid from section 4, no shapes ([E2E_PLAN_V2.md](E2E_PLAN_V2.md) line 164). Choosing a swatch updates the draft and marks it dirty. It does not save by itself. A swatch is a profile edit, and Phase 3 has one save path, so Overview and Settings cannot diverge.

#### Sessions

Flat list of sessions with `agentId` equal to this agent, `updatedAt` descending, tie-break `id`. Each row shows the title (`formatUnknownSafe(title, "New session")`), the project folder name (last path segment, or "Project path unavailable"), `shortTime(updatedAt)`, a status dot, and `labelize(state)`. Clicking a row selects that session and goes Back to the chat. This is not the Phase 4 tree: no project chevrons, no per-project plus, no localStorage expanded keys.

Empty: "No conversations yet." and, when the runtime is usable, a "New session" button.

Legacy sessions (`agentId` null) are not listed here. If any session has `agentId` null and `runtimeId` equal to this agent's runtime, show one footer line: "Conversations not linked to a blob stay in the header list." The header list rule is in section 5.

#### Usage

A single card: heading "Usage", body "Usage for this blob is not available yet." No chart, no range control, no leaderboard, no call to `usage.analytics` or `usage.summary`. The sidebar Usage button still opens the existing global sheet ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 381–389 and 439). That sheet is not per-blob and must not be embedded here as if it were.

#### Settings — Profile card

| Field | Control | Rules |
|---|---|---|
| Colour | `SwatchGrid` plus a custom hex text field | Section 4. The grid and the field edit the same draft colour |
| Name | Single-line text | Trimmed, 1–60 Unicode scalar values, unique among other non-archived agents ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 132). No `maxLength` attribute, because it counts UTF-16 code units. Show the error under the field when invalid. No `0/60` counter |
| Description | Text area | 0–255 Unicode scalar values, empty allowed. Counter `{n} / 255` with spaces around the slash, `n` from `scalarLength` below. At `n <= 255` the counter uses `var(--ink-3)`. Above 255 it uses `var(--bad)` from [apps/desktop/src/ui/styles.css](../apps/desktop/src/ui/styles.css) line 18 |
| Instructions | Text area | Empty allowed. No length cap in 2a. Reject a NUL (`U+0000`). Helper, exact: "Saved with this blob. Bloblex does not send instructions to the CLI until a later update." |

`scalarLength` is `Array.from(value).length`. That counts Unicode code points and matches Rust `chars().count()` for the well-formed text a browser puts in an input. Do not use `String.length`.

#### Settings — Execution card

Helper under the card title, exact: "These options apply to new sessions in a later update. This update only saves the runtime and the default project."

| Field | Phase 3 control |
|---|---|
| Runtime | Enabled `<select>` of every `snapshot.runtimes` entry. Each option shows a `.status-dot` (good when `statusClass` is `good`, bad when `bad`, muted otherwise) and the text `{labelize(provider)}` plus ` · {version}` when version is non-empty. If two options would share that text, append ` · {runtime.id}`. Changing runtime is allowed. Helper, exact: "New sessions use this runtime. Existing conversations stay on the runtime that started them." That matches 2a ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 146) |
| Model | Disabled. Visible value "CLI default" when `model` is null, otherwise the stored string. Reason beside it: "Available in a later update." |
| Thinking | Disabled. Visible value "Runtime default" when `thinking` is null, otherwise the stored string. Same reason |
| Speed | Disabled, shown for every runtime. Visible value "Runtime default" when `serviceTier` is null, otherwise the stored string. Same reason. Phase 3 does not hide Speed per CLI. Support is a Phase 2b catalog fact ([E2E_PLAN_V2.md](E2E_PLAN_V2.md) lines 105 and 116), and guessing it here would hide a stored value the user cannot see |
| Concurrency | Disabled number showing `maxConcurrency` (1 when missing). Same reason |
| Default project | Enabled text field. Trim. Empty becomes `null`. Not checked for existence on save; `session.new` checks the directory later ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 166). Helper, exact: "New sessions start in this folder when it exists. Leave blank to choose a folder each time." |
| Custom args, custom env | Not rendered. Under the card, exact: "Custom arguments and environment are not available yet." |

Default project is shown because the UI, not the adapter, passes it as `projectPath` (section 5). Custom args and env are hidden because 2a does not apply them and Phase 2b starts from empty user allowlists. Duplicate still copies the stored arrays so a later phase does not lose them.

The chat header model pill is a status group, not a button. Today it is a button that opens runtime settings ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 459). Phase 3 removes that click so the pill is not a second editor. It shows the agent colour dot, the runtime label, and either "CLI default" or `session.model` when that string is non-empty. `title` on the group, exact: "Reported by the session. Bloblex does not choose the model until a later update." Do not say the model was applied.

### Save, cancel, dirty, validation

Dirty fields are `name`, `description`, `instructions`, `color`, `runtimeId`, and `defaultProject`. Colour uses `colorsEquivalent` (section 4), so a migrated `#F38C6F` blob is not dirty merely because the coral swatch is the same paint. Disabled execution fields are not in the dirty set.

Edit mode: Save disabled when not dirty, when client validation fails, or while a save is in flight. Cancel hidden when not dirty. Cancel reverts the draft to the last confirmed agent and stays on the page. Back, when dirty, asks "Discard unsaved changes?" with Discard and Keep editing. Focus Keep editing. Escape is Keep editing. Discard returns to the chat. Back, when clean, returns immediately.

Create mode: Save is labelled "Create blob" and is disabled until client validation passes. The draft is dirty only when a field differs from the defaults below, so a freshly opened create page goes Back without a prompt. Back and Cancel both use the discard prompt when any field differs from those defaults, and both leave the page. They do not stay on the page the way edit-mode Cancel does, because there is no saved agent to revert to. Defaults: name `""`, description `""`, instructions `""`, colour `mint` (the schema default, [PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 41), `runtimeId` of the selected agent when that runtime still exists, otherwise the first usable runtime, otherwise the first runtime, `defaultProject` null. Do not send `model`, `thinking`, `serviceTier`, `customArgs`, `customEnv`, or `maxConcurrency` on create-from-scratch; the daemon defaults them ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) lines 119–122 and 145). Duplicate is the exception and sends the copied values.

`agent.update` sends only fields that are dirty. Omitted fields keep their stored values ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 146). Send `defaultProject: null` when the user cleared it. Send colour as a swatch key when the value maps to one, otherwise as uppercase `#RRGGBB`.

Client messages, shown under the field and used as the save error when that is the only failure:

| Condition | Message |
|---|---|
| Trimmed name empty | Enter a name. |
| Name longer than 60 scalars | Use 60 characters or fewer for the name. |
| Description longer than 255 scalars | Use 255 characters or fewer for the description. |
| Instructions contain NUL | Instructions cannot include a null character. |
| Colour not a swatch key and not six-digit hex | Enter a colour as #RRGGBB, or choose a swatch. |
| No runtime | Choose a runtime. |
| Local active-name collision, excluding this agent | Another blob already uses this name. |

Daemon codes are mapped below. The desktop bridge currently throws `"${code}: ${message}"` ([apps/desktop/src-tauri/src/lib.rs](../apps/desktop/src-tauri/src/lib.rs) lines 358–363). Parse the code as the substring before the first `": "`. Show the table sentence, not the daemon's message text. Phase 2a requires messages to be safe ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 137) and does not fix their wording; the UI sentences stay stable and cannot echo a future message that included instruction text.

| Code | When | User-facing message |
|---|---|---|
| `conflict` | `agent.create`, or `agent.update` that sent `name` | Another blob already uses this name. |
| `conflict` | `agent.update` when this client already has `archived === true` for that id | This blob is archived and cannot be edited. |
| `conflict` | `session.new` | This blob is archived, so a new session cannot be started. |
| `not_found` | `agent.create` (missing runtime) | That runtime is no longer available. Refresh and choose another. |
| `not_found` | `agent.get`, `agent.update`, `agent.delete`, `session.new` | That blob is no longer available. Refresh and try again. |
| `invalid_argument` | `agent.create` or `agent.update` | Check the name, description, colour, and runtime, then try again. |
| `invalid_argument` | `session.new` | Choose a project folder that exists on this device. |
| `invalid_argument` | `agent.reorder` (Phase 3 does not call it; keep the sentence for the mapper) | The roster order is out of date. Refresh and try again. |
| `not_found` | `agent.reorder` | That runtime is no longer available. |
| `internal` | any `agent.*` save or archive | Bloblex could not save that change. Nothing was applied. |
| `unauthorized` | any of the above | Bloblex could not reach the local daemon. Reconnect and try again. |
| any other code | any of the above | The local daemon request failed. |

`agent.delete` does not use `conflict` for a second archive; the daemon returns the archived row ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 147). Treat that as success.

On save failure, leave the draft dirty and do not change snapshot agents.

### Confirmed updates and `agent.changed`

Do not write the draft into the snapshot before the RPC returns. The daemon is the source of truth ([PRODUCT.md](../PRODUCT.md) line 30).

On success, merge the returned `Agent` into `snapshot.agents` immediately. Create mode then switches to edit mode for the new id, selects that agent, and marks the draft clean. Edit mode stays on the page and marks the draft clean from the returned agent. Archive closes the page and runs the selection fallback in section 5.

`agent.changed` is handled by the Phase 2a reducer, then a fetch ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) lines 154–158 and 177):

1. Ignore the event when `sequence` is less than or equal to `snapshot.sequence`, as `applyEvent` already does ([apps/desktop/src/types.ts](../apps/desktop/src/types.ts) lines 100–104).
2. Patch the matching row's `runtimeId`, `updatedAt`, `archived`, and `sortOrder` from the payload. Keep the row when `archived` becomes true. The payload has no name, colour, or instructions ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 156).
3. Call `agent.get` for that `agentId`. Replace the row with the result.
4. If `agent.get` fails, keep the previous full row merged with the four patched fields. Do not blank name, colour, or instructions.
5. If the blob page is editing that id and the draft is clean, replace the draft from the fetched agent.
6. If the draft is dirty, do not touch the inputs. Show this notice: "This blob changed elsewhere. Save will overwrite those fields, or cancel to load the latest."
7. If the event says `archived` and that id is the selected agent, or the open editor's agent, leave the page if it is open, run the fallback in section 5, and show "Archived “{name}”. Its conversations stay saved. Restoring a blob is not available yet."

Always call `agent.get` after the patch, including after this client's own save. The extra get is how a projection becomes a full row. A save that already merged the RPC result still accepts the get result afterwards.

Phase 3 does not invent a second reducer. If `applyEvent` does not yet handle `agent.changed` because Phase 2a has not merged, add the behaviour in the paragraph above and in PHASE_2A_SPEC.md "Snapshot, events and desktop types", including `Snapshot.agents` and `Session.agentId`. Do not add fields Phase 2a does not list.

## 4. Colour system

Phase 2a stores either one of 12 lowercase keys or a six-digit hex, and it leaves the rendered hex of the keys to Phase 3 ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) lines 41–45 and 77). These are the Midnight values. They are the only new colour literals, and they live in the TypeScript map in `agentColor.ts`, not in CSS.

| Key | Hex | Contrast on sidebar `#111111` | Contrast on chat `#070707` |
|---|---|---|---|
| coral | `#F38C6F` | 7.91:1 | 8.43:1 |
| orange | `#F0A05A` | 8.88:1 | 9.48:1 |
| amber | `#E8C15A` | 10.98:1 | 11.71:1 |
| lemon | `#E4D56A` | 12.61:1 | 13.45:1 |
| lime | `#A8D45C` | 11.00:1 | 11.74:1 |
| mint | `#89D6B3` | 11.09:1 | 11.83:1 |
| teal | `#5EBEB0` | 8.51:1 | 9.08:1 |
| cyan | `#6EC8E0` | 9.89:1 | 10.55:1 |
| sky | `#7EB6F0` | 8.84:1 | 9.44:1 |
| blue | `#82AAFF` | 8.22:1 | 8.77:1 |
| violet | `#BF9CFF` | 8.47:1 | 9.03:1 |
| pink | `#F0A0C4` | 9.47:1 | 10.10:1 |

[DESIGN.md](../DESIGN.md) line 13 describes the main background as a deep blue-gray and does not give a hex. The implemented Midnight surfaces are `--app: #070707` and `--panel: #111111` ([apps/desktop/src/ui/shell.css](../apps/desktop/src/ui/shell.css) lines 6–7). The sidebar element uses `--panel` (line 31). The conversation pane uses `--app` (line 95). A selected row uses `--raised: #2f2f2f` (lines 8 and 43), which is the lightest surface a roster face sits on. Companion faces sit on the capsule `#000` ([apps/desktop/src/ui/companion.css](../apps/desktop/src/ui/companion.css) line 22); the window behind the capsule is transparent (line 21).

Contrast uses WCAG 2 relative luminance. For each 8-bit channel `c`, `lin(c) = c/255/12.92` when `c/255 <= 0.04045`, otherwise `((c/255 + 0.055) / 1.055) ^ 2.4`. `L = 0.2126*lin(R) + 0.7152*lin(G) + 0.0722*lin(B)`. The ratio is `(Llighter + 0.05) / (Ldarker + 0.05)`.

Worked example, coral `#F38C6F` on the sidebar `#111111`: `L(#F38C6F) = 0.389586`, `L(#111111) = 0.005605`, `(0.389586 + 0.05) / (0.005605 + 0.05) = 0.439586 / 0.055605 = 7.9055`, reported as 7.91:1. That pair is the minimum in this palette. Every swatch is at least 4.5:1 on `#111111` and on `#070707`, so each fill clears both the 3:1 non-text requirement and the 4.5:1 text requirement against those two backgrounds. The same formula on the other surfaces a face actually sits on, minimum still coral `#F38C6F`: selected row `#2F2F2F` (`L = 0.028426`) is 5.61:1, editor card `#262626` (`L = 0.019382`) is 6.34:1, companion capsule `#000000` (`L = 0`) is 8.79:1.

These ratios are for the flat swatch. `BlobCanvas` paints that hex as `bodyColor` ([apps/desktop/src/blob/BlobCanvas.tsx](../apps/desktop/src/blob/BlobCanvas.tsx) lines 77 and 98). Idle and online states use tint 0 ([apps/desktop/src/blob/blobEngine.ts](../apps/desktop/src/blob/blobEngine.ts) lines 91–92), so a resting face is the swatch. Other moods mix a state tint on top; Phase 3 does not change that mix.

### Provider migration map

`providerColor` is Claude `#f38c6f`, Codex `#82aaff`, OpenCode `#bf9cff`, everything else `#89d6b3` ([apps/desktop/src/types.ts](../apps/desktop/src/types.ts) lines 87–93). Phase 2a writes those exact hex values onto the default agents ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 92). The schema accepts either case ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 44). RPC writes uppercase ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 134). Compare hex case-insensitively.

| Stored provider hex | Swatch key | Why the default blob looks unchanged |
|---|---|---|
| `#F38C6F` | coral | Coral is defined as that hex |
| `#82AAFF` | blue | Blue is defined as that hex. Codex is the blue in [DESIGN.md](../DESIGN.md) line 9. Do not map Codex to sky |
| `#BF9CFF` | violet | Violet is defined as that hex |
| `#89D6B3` | mint | Mint is defined as that hex, and it is the schema default |

Rendering uses the stored string. A migrated `#f38c6f` is painted as `#F38C6F` without rewriting the row. The swatch grid shows coral selected because the hex equals coral. Saving some other dirty field does not send `color` (partial update). Choosing coral explicitly and saving sends the key `coral`.

### Custom hex

Accept input that is `#` plus six hex digits, or six hex digits without `#`. On blur, display uppercase `#RRGGBB`. Reject `#RGB`, eight-digit hex, alpha, and colour names; 2a rejects those ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 134). While the field is invalid, keep the preview on the last valid colour and show "Enter a colour as #RRGGBB, or choose a swatch." A valid hex that equals a swatch selects that swatch and stores the key, not the hex. Any other valid hex stores uppercase `#RRGGBB` and selects no swatch. The preview `BlobCanvas` uses `agentColorHex`.

`agentColorHex` returns the map hex for a known key, the uppercase hex for a valid hex, and `#89D6B3` only when the string is neither. That last branch is a display fallback for a corrupt fixture, not a second palette. The daemon will not return an unknown colour.

`hexToRGB` already parses a leading `#` and expands three-digit hex ([apps/desktop/src/blob/blobEngine.ts](../apps/desktop/src/blob/blobEngine.ts) lines 115–120). Phase 3 still refuses three-digit values before they reach the canvas, so a rejected draft cannot preview as a different colour. Do not change `hexToRGB`.

### Where colour is passed

Set `--agent-accent` on the shell from the selected agent's resolved hex. It already feeds `--accent` ([apps/desktop/src/ui/styles.css](../apps/desktop/src/ui/styles.css) line 20, [apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 409). The companion root sets the same variable ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 1277).

Direct `providerColor(...)` calls to replace with the agent hex, except the runtime settings dots:

| Call | Becomes |
|---|---|
| [apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 74, `accent` | Selected agent's resolved hex. Empty selection uses no accent and the empty state below |
| [apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 425, roster `BlobCanvas` | That row's agent hex |
| [apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 647, details pane `BlobCanvas` | Selected agent's hex. The heading becomes the agent name; the protocol line stays the runtime's `protocolFamily` |
| [apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 1262, companion `color` | Selected agent's hex |
| [apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 1283, mini `BlobCanvas` | That peer agent's hex |
| [apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 1329, pill `--pill` and pill `BlobCanvas` (two calls on that line) | That agent's hex |

Derived uses of `accent` or companion `color` that follow those assignments and must keep receiving the agent hex, all in [apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx): line 452 (header face), line 459 (pill mark), line 473 and line 513 (empty conversation, when an agent is selected), line 477 (first-run face), line 481 (working face), line 560 (`MessageItem`), line 1275 (`focusBlob`), line 1286 (welcome face), and line 1307 (who-dot). The who-dot is a status pip tinted with the agent colour; the status text beside it stays.

Keep [apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 981 on `providerColor`. Those dots are runtimes in the settings sheet, not blobs. Keep line 513's `#e6e9ee` for the no-agent empty canvas only. That literal is already there; do not add another. It matches the engine idle grey (`C.idle` at [apps/desktop/src/blob/blobEngine.ts](../apps/desktop/src/blob/blobEngine.ts) line 71) and the character sheet's first swatch ([apps/desktop/src/preview/main.tsx](../apps/desktop/src/preview/main.tsx) line 12). It is not one of the 12 keys.

Character sheet calls [apps/desktop/src/preview/main.tsx](../apps/desktop/src/preview/main.tsx) lines 13–16 go through the 12-key map instead of `providerColor`. Claude, Codex, OpenCode, and Other then paint coral, blue, violet, and mint, which are the same four hexes.

`providerColor` stays exported for the runtime dots and for any non-UI caller. Blob faces do not call it.

### Companion

The companion follows the selected agent, not the selected runtime's provider colour.

- Island focus face, compact face, welcome face, and chat face use the selected agent's hex (the `color` variable above).
- Minis are up to four other active agents, roster order, excluding the selected id. Replace the runtime filter at [apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 1264.
- Pills list up to four active agents in roster order. If the selected agent is outside that window, replace the fourth pill with the selected agent so the current blob is always one of the pills. Pill label is `agent.name`. Clicking a pill selects that agent and its latest session, and calls `setActiveRuntime` with the agent's `runtimeId` plus `setActiveSession` with the session id or null. This replaces `onSelectRuntime` ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 393 and line 1329).
- The companion name string becomes the agent name. The runtime remains available as the status line when there is no session title.

Phase 4 will tie the companion chat to the tree's selected session. Phase 3 already selects an agent and a session; the companion reads those.

## 5. State model and data flow

Agents live on the snapshot. `Snapshot.agents` is the Phase 2a array, including archived rows ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) lines 175–178). The React state remains the single `snapshot` value `applyEvent` updates ([apps/desktop/src/types.ts](../apps/desktop/src/types.ts) lines 100–129). Do not keep a second agent store.

The `Agent` interface is the one in [PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 178: `id`, `name`, `description`, `instructions`, `color`, `runtimeId`, `model`, `thinking`, `serviceTier`, `customArgs`, `customEnv`, `maxConcurrency`, `defaultProject`, `sortOrder`, `archived`, `createdAt`, `updatedAt`. `Session.agentId` is `string | null | undefined`. `Session.runtimeId` stays required.

### Selectors

Put these in `agentRoster.ts` as pure functions:

- `activeAgents(agents)`: `archived === false`, ordered by `runtimeId`, `sortOrder`, `createdAt`, `id`.
- `agentsForRuntime(agents, runtimeId)`: the active subset for that runtime, same order.
- `agentSessions(sessions, agentId)`: `session.agentId === agentId`, `updatedAt` descending, then `id`.
- `legacySessions(sessions, runtimeId)`: `agentId` null or missing, and `runtimeId` equal.
- `rosterRows(agents, sessions, query)`: active agents in roster order, with `latest` and `matchedTitle`, filtered by section 2 search.

### Selection

Add `selectedAgentId: string | null`. Keep `selectedSessionId`. Derive the runtime from the selected agent (`runtimes.find(id === agent.runtimeId)`), not from a click on a runtime row. Continue calling `setActiveRuntime` and `setActiveSession` ([apps/desktop/src/tauri.ts](../apps/desktop/src/tauri.ts) lines 51–64) so the main window and companion keep sharing the native selection ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 272–313).

Initial choice, once the snapshot is available:

1. `localStorage` key `bloblex.selectedAgentId` when that id is an active agent.
2. Otherwise the first `agentsForRuntime` entry for `getActiveRuntime()`, when that returns an id.
3. Otherwise the first `activeAgents` entry.
4. Otherwise null.

Then the session: `getActiveSession()` when that session's `agentId` equals the selected agent, or when it is a legacy session on the selected agent's runtime. Otherwise the latest `agentSessions` entry, or null.

`listenForActiveRuntime`: if the id differs from the selected agent's runtime, select the first active agent on that runtime and that agent's latest session. If the runtime has no active agent, leave the agent selection unchanged.

`listenForActiveSession`: if the session has an `agentId`, select that agent when it is active. If `agentId` is null, keep the session selected and select the first active agent on the session's runtime when the current agent is on a different runtime.

Header session `<select>` options, in order: this agent's sessions (`agentSessions`), then, under a disabled option "Not linked to a blob", the legacy sessions for this runtime. Choosing either kind sets `selectedSessionId` only. Do not retarget a legacy session onto the agent.

Clicking a roster row selects that agent, its latest session (or null), and closes the blob page if the open page is a different agent.

### Selected agent archived

When the selected id is missing or `archived` becomes true:

1. Take the pre-change roster order (the order that still contains the archived id).
2. Let `next` be the following active agent in that order, wrapping to the first active agent. If none remain, `next` is null.
3. Set `selectedAgentId` to `next`. Clear `selectedSessionId` so the new agent's chat does not inherit the archived agent's conversation.
4. `aria-live="polite"` on the sidebar: `Archived {name}. Now showing {next name}.` or `Archived {name}. No blobs left.`
5. Persist `bloblex.selectedAgentId` as the new id, or remove the key when null.

### Selected runtime goes offline

Keep the agent selected. Mood and status follow `deriveCompanionStatus`. Disable New session, the composer send control, and Resume. Leave Edit blob enabled. Do not switch to another agent.

### `session.new`

Every Bloblex-initiated create uses `{ agentId, projectPath }` and omits `runtimeId`. Sending both is `invalid_argument` ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 162). Omit `title` so the daemon stores `New chat` ([PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 166).

Paths that change from `{ runtimeId, projectPath }` ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 329–335):

- Context menu New session, for that row's agent.
- Header pill "Session", more-menu New session, and the empty-conversation button, for the selected agent.
- Companion plus and its empty-chat New session, for the companion's selected agent.

`projectPath`: if the agent's `defaultProject` is a non-empty string, pass it and do not open the folder picker. If the daemon returns `invalid_argument`, show "Choose a project folder that exists on this device." and then open `openProjectFolder()`. A chosen folder is sent on a second `session.new` and does not clear `defaultProject`. If `defaultProject` is null, keep today's picker ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 333–335) and return without an RPC when the user cancels. Phase 2a does not read `default_project` inside `session.new`; the UI supplies `projectPath`.

After success, select the returned session, select its `agentId` when present, refresh, and refresh the tray, as the current function does.

Do not remove the daemon's legacy `runtimeId` form. The UI simply stops calling it.

### localStorage

Existing keys stay, with the same values: `bloblex.runtimeExplainer.dismissed` and `bloblex.inspector.open` ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 51–52, 406, and 471). Add `bloblex.selectedAgentId` only. Write it when the selected agent changes, and remove it when the selection is null. Do not store colour, instructions, or drafts. Do not add `bloblex.roster.expanded`; that key is Phase 4's ([E2E_PLAN_V2.md](E2E_PLAN_V2.md) line 198). There is no existing agent key to migrate.

There is no `setActiveAgent` IPC. Do not add a Tauri command. Cross-window sync stays on `setActiveRuntime` and `setActiveSession`.

## 6. Accessibility and keyboard

Roster:

- The list is a `<nav aria-label="Blobs">`. Rows remain buttons.
- Roving tabindex: the selected row is `tabIndex={0}`; other visible rows are `-1`. If nothing is selected, the first visible row is `0`.
- Arrow Up and Arrow Down move focus across visible rows and move the roving tabindex with it. They do not change which agent is selected. Enter and Space activate the focused row (Space is the button default) and select that agent. Home and End move focus to the first and last visible rows.
- When search hides the focused row, move focus to the first visible row, or to Create blob when none are visible.
- Context menu keys stay as they are today (section 2).

Blob page:

- On open, focus the Back button. That is the way out, and it is the first control.
- On close, focus the roster button for that agent. If the row is gone, focus Create blob. After a successful create, focus the new row.
- Archive and discard dialogs: focus the non-destructive button first (Cancel, or Keep editing), trap Tab inside the dialog, and restore focus to the control that opened the dialog if the page stays up.
- Swatch grid: `role="group"` with `aria-label="Blob colour"`. Each swatch is a button, `aria-pressed`, accessible name `"{Name}"` or `"{Name}, selected"`. Visible text under the swatch is the key, capitalised (`Coral`, `Orange`, …). Six columns, two rows, schema order left to right, top to bottom. Arrow keys move inside the grid. Home and End move to the first and last swatch. Enter or Space selects.
- The custom hex field's label is "Custom colour".
- Description counter is tied to the textarea with `aria-describedby`.
- Disabled execution controls use the HTML `disabled` attribute and the visible reason "Available in a later update." in an element referenced by `aria-describedby`. The reason is not only a tooltip.
- Status on a row includes the text, not only `.status-dot` ([PRODUCT.md](../PRODUCT.md) line 38).

Reduced motion: do not add a motion path. `BlobCanvas` already sets `engine.reducedMotion` from `prefers-reduced-motion` ([apps/desktop/src/blob/BlobCanvas.tsx](../apps/desktop/src/blob/BlobCanvas.tsx) lines 130–151) and skips the idle loop when motion is reduced (lines 163–165). The global stylesheet already collapses animations ([apps/desktop/src/ui/styles.css](../apps/desktop/src/ui/styles.css) lines 253–255). Roster faces, the 96px preview, and companion faces all go through `BlobCanvas`, so they follow that flag. Do not bypass it for the editor preview.

Swatch selection contrast, same luminance formula, both hexes named:

| Foreground | Background | Ratio | Use |
|---|---|---|---|
| `#FCFCFC` (`L = 0.973445`) | `#E4D56A` (`L = 0.651231`) | 1.46:1 | White mark on lemon. Below 3:1. Do not draw this |
| `#FCFCFC` | `#F38C6F` | 2.33:1 | White mark on coral. Below 3:1. Do not draw this |
| `#111111` | `#F38C6F` | 7.91:1 | 2px ring on the swatch edge. This is the minimum; every other swatch is higher because it matches that swatch's sidebar ratio |
| `#FCFCFC` | `#262626` (`L = 0.019382`) | 14.75:1 | 2px outer ring against the card gap, not against the fill |
| `#459FFE` | `#262626` | 5.51:1 | Existing focus outline, `var(--blue-border)` ([apps/desktop/src/ui/shell.css](../apps/desktop/src/ui/shell.css) line 17 and line 158) |

Do not draw a `#FCFCFC` mark on the swatch fill. Draw the `#111111` ring on the swatch, then the `#FCFCFC` ring outside it so the white ring's neighbour is the card.

## 7. File-level change list

Create:

| File | Purpose |
|---|---|
| `apps/desktop/src/ui/agentColor.ts` | The 12-key map and `agentColorHex`, `swatchForColor`, `colorsEquivalent`, `parseCustomHex`. The only new hex literals |
| `apps/desktop/src/ui/agentColor.test.ts` | Map, provider-hex equivalence, custom hex accept/reject |
| `apps/desktop/src/ui/agentRoster.ts` | Selectors, search, duplicate name, archive fallback, `scalarLength` |
| `apps/desktop/src/ui/agentRoster.test.ts` | Order, search, fallback, duplicate names, scalar length |
| `apps/desktop/src/ui/agentForm.ts` | Draft, dirty, client validation, daemon-code messages |
| `apps/desktop/src/ui/agentForm.test.ts` | Every validation message in section 3 |
| `apps/desktop/src/ui/AgentRoster.tsx` | Sidebar list, search, empty states |
| `apps/desktop/src/ui/AgentContextMenu.tsx` | The four menu items |
| `apps/desktop/src/ui/BlobPage.tsx` | Header, tabs, save bar, discard and archive dialogs |
| `apps/desktop/src/ui/BlobOverview.tsx` | Overview tab |
| `apps/desktop/src/ui/BlobSessions.tsx` | Sessions tab |
| `apps/desktop/src/ui/BlobUsage.tsx` | Unavailable usage tab |
| `apps/desktop/src/ui/BlobSettings.tsx` | Profile and Execution cards |
| `apps/desktop/src/ui/SwatchGrid.tsx` | Twelve swatches and the custom hex field |
| `apps/desktop/src/ui/blobPage.css` | Page layout using existing tokens only |
| `apps/desktop/src/ui/App.agent.mounted.test.tsx` | Mounted roster, page, colour, keyboard, events |

Modify:

| File | Purpose |
|---|---|
| `apps/desktop/src/ui/App.tsx` | Selected agent, roster, blob page, `session.new` by `agentId`, companion agent colour |
| `apps/desktop/src/ui/shell.css` | `.bot-row-meta` and `.roster-group-label`, using `var(--ink-3)` and existing type size. No new hex |
| [apps/desktop/src/main.tsx](../apps/desktop/src/main.tsx) lines 4–6 | Import `blobPage.css` after `shell.css` |
| `apps/desktop/src/types.ts` | Only if Phase 2a has not added `Agent`, `Snapshot.agents`, `Session.agentId`, and the `agent.changed` branch. Add those exactly as [PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) lines 173–178. No extra fields |
| `apps/desktop/src/preview/fixtureBridge.ts` | Fixture agents, `agentId`s, and in-memory `agent.*` / `session.new` |
| `apps/desktop/src/preview/main.tsx` | Character sheet palette uses the 12 keys |
| `SESSION_HANDOFF.md` | Implementer records what landed and the smoke database path. This spec does not edit that file |

Do not modify Rust, Tauri commands, or `providerColor`'s four hexes.

### Component props

Names and fields only.

- `AgentRoster`: `agents`, `sessions`, `runtimes`, `connected`, `selectedAgentId`, `query`, `onQueryChange`, `onSelect`, `onCreate`, `onNewSession`, `onEdit`, `onDuplicate`, `onArchive`.
- `AgentContextMenu`: `agent`, `enabled` (`newSession`, `duplicate`, `archive`), `position` (`x`, `y`), `onClose`, `onNewSession`, `onEdit`, `onDuplicate`, `onArchive`.
- `BlobPage`: `mode` (`create` or `edit`), `agent`, `draft`, `runtimes`, `sessions`, `connected`, `saving`, `error`, `remoteNotice`, `onDraftChange`, `onBack`, `onSave`, `onCancel`, `onArchive`.
- `BlobOverview`: `draft`, `runtime`, `session`, `connected`, `onColorChange`.
- `BlobSessions`: `agent`, `sessions`, `legacyCount`, `canCreate`, `onOpenSession`, `onNewSession`.
- `BlobUsage`: no data props.
- `BlobSettings`: `draft`, `runtimes`, `errors`, `onDraftChange`.
- `SwatchGrid`: `value`, `onChange`, `disabled`.
- `AgentDraft`: `name`, `description`, `instructions`, `color`, `runtimeId`, `defaultProject`.

### CSS

`blobPage.css` uses `var(--app)`, `var(--panel)`, `var(--card)`, `var(--raised)`, `var(--inset)`, `var(--hairline)`, `var(--ink)`, `var(--ink-2)`, `var(--ink-3)`, `var(--bad)`, `var(--blue-border)`, and `var(--agent-accent)`. Swatch fills are inline `style={{ background: hex }}` from `agentColor.ts`. Do not put swatch hex in `shell.css`, `styles.css`, `companion.css`, or `blobPage.css`. Do not add a new palette in CSS. The selection rings are `#111111` and `#fcfcfc`, which are the existing `--panel` and `--ink` tokens; use the variables, not fresh literals.

## 8. Fixture preview and tests

The preview harness aliases `../tauri` to [apps/desktop/src/preview/fixtureBridge.ts](../apps/desktop/src/preview/fixtureBridge.ts) ([apps/desktop/vite.preview.config.ts](../apps/desktop/vite.preview.config.ts) lines 9–15). The fixture `rpc` currently takes only a method ([apps/desktop/src/preview/fixtureBridge.ts](../apps/desktop/src/preview/fixtureBridge.ts) lines 40–43). Change it to `(method, params)` so it matches [apps/desktop/src/tauri.ts](../apps/desktop/src/tauri.ts) lines 7–9. Keep the stand-in comment: values are visual fixtures, not product data.

Seed agents:

| id | name | color | runtimeId | sortOrder | archived | notes |
|---|---|---|---|---|---|---|
| `agent-claude` | Claude | `#f38c6f` | `runtime-claude` | 0 | false | Migrated hex, must paint as coral |
| `agent-codex` | Codex | `#82aaff` | `runtime-codex` | 0 | false | Must paint as blue |
| `agent-invoice` | Invoice helper | `lemon` | `runtime-codex` | 1 | false | Second blob on Codex, after Codex |
| `agent-opencode` | OpenCode | `violet` | `runtime-opencode` | 0 | false | Swatch key |
| `agent-old` | Retired | `pink` | `runtime-codex` | 2 | true | Hidden |

Point the existing fixture sessions at `agent-codex`, `agent-claude`, and `agent-opencode`. Add a legacy session `{ id: 'session-legacy', runtimeId: 'runtime-codex', agentId: null, title: 'Untied notes' }`. Give Invoice helper no sessions. One Codex session title must contain a word that is not in any agent name, so search can hit the title only (`Invoice parser tests` already does, once it is linked to `agent-codex`).

Query flags, same style as `?approval` and `?companion` ([apps/desktop/src/preview/fixtureBridge.ts](../apps/desktop/src/preview/fixtureBridge.ts) line 32, [apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 25):

- `?empty=1` — runtimes present, `agents: []`.
- `?offline=1` — `runtime-codex.status = 'offline'`.
- `?disconnected=1` — `listenForDaemonConnection` reports false and the snapshot still has agents.

In-memory fixture mutations: `agent.create`, `agent.update`, `agent.delete`, `agent.get`, `agent.list`, and `session.new` update the module-level arrays and return the Phase 2a result shape. `agent.delete` sets `archived` true. `session.new` requires `agentId` or `runtimeId` but not both, and appends a session. After a mutation, the next `fetchSnapshot` returns the new arrays. No real daemon.

Character sheet ([apps/desktop/src/preview/main.tsx](../apps/desktop/src/preview/main.tsx) lines 11–17): replace the provider palette with the 12 keys, labels capitalised, colours from `agentColorHex`. Keep the mood grid.

### Tests

The desktop package runs Vitest ([apps/desktop/package.json](../apps/desktop/package.json) lines 6–11) with no Testing Library dependency. Mounted tests follow [apps/desktop/src/ui/App.lifecycle.mounted.test.tsx](../apps/desktop/src/ui/App.lifecycle.mounted.test.tsx): the `// @vitest-environment happy-dom` banner (line 1), `createRoot` plus `act` (lines 96–107), and a `vi.mock` of `../tauri`. The default Vitest environment is node; pure tests omit the banner. Do not change the lifecycle file's `BlobCanvas` mock (lines 53–62). The new mounted file mocks `BlobCanvas` as a span with `data-color` and `data-label` so colour can be asserted.

None of these tests start the daemon, open a database, or set `BLOBLEX_DB_PATH`.

Pure tests:

- Roster order: Codex (`sortOrder` 0) before Invoice helper (`sortOrder` 1) inside the same runtime; groups follow `runtimeId`.
- Search hits a name, hits a title, ignores a project path, and drops non-matching groups.
- Duplicate name: `Copy of Claude`, then `Copy of Claude (2)`, and a 60-scalar truncation.
- `scalarLength('👋')` is 1.
- Archive fallback: archiving the middle agent selects the next; archiving the last wraps; archiving the only agent yields null.
- Create validation messages for every row of the client table in section 3, plus each daemon code row (`conflict` name, `conflict` archived update, `conflict` session.new, `not_found` runtime, `not_found` blob, `invalid_argument` agent, `invalid_argument` session, `internal`, `unauthorized`).
- Dirty is false when stored colour `#f38c6f` is compared with swatch `coral`. Dirty is true when the name changes. Cancel restores the confirmed name.
- `parseCustomHex` accepts `f38c6f` and `#f38c6f`, returns `#F38C6F`, and rejects `#F38`, `#F38C6F80`, and `red`.
- `agentColorHex('coral')`, `agentColorHex('#82aaff')`, and `agentColorHex('mint')` equal the table.

Mounted tests in `App.agent.mounted.test.tsx`:

- Renders one row per non-archived agent and hides Retired.
- Row order is Claude group, then Codex before Invoice helper, then OpenCode. Assert the accessible names.
- Create flow: "+" opens the page, empty save shows "Enter a name.", a 61-scalar name and a 256-scalar description show their messages, a duplicate name shows "Another blob already uses this name.", a NUL in instructions shows its message, a bad hex shows its message, and a fixture `not_found` on create shows the runtime message.
- Edit, dirty, cancel: change the name, Cancel restores it, Back while dirty asks "Discard unsaved changes?", Keep editing stays, Discard leaves.
- Duplicate calls `agent.create` with the copied colour, runtime, and execution fields, and a `Copy of` name.
- Archive confirms, calls `agent.delete`, and the row disappears.
- Swatch selection sets `aria-pressed` and a custom hex of `abc` shows the validation message; `F0A0C4` selects pink.
- The selected roster `data-color` is `#F38C6F` for the Claude fixture. The header face and the companion pill use that hex, not `#82aaff`, when Claude is selected.
- Search "parser" leaves the Codex row visible via the session title.
- Arrow Down moves focus and does not change `aria-current` until Enter.
- An `agent.changed` event with a higher sequence, followed by the mocked `agent.get`, updates the row's name. An event at or below the snapshot sequence does not.
- Archiving the selected agent through an event moves `aria-current` to the next row and announces the fallback.
- `?offline` equivalent snapshot: the Codex row shows "Runtime offline" and New session is disabled.

### Gate

From the repository root, after implementation:

```powershell
npm run typecheck
npm test
npm run build
```

Those scripts delegate to `apps/desktop` ([package.json](../package.json) lines 8–10). Do not run `cargo`, and do not point any command at the live inspection database. Record exit codes. Passing these commands is not the native smoke test.

## 9. Native smoke test

Run this after the Phase 3 diff is in the tree and before Phase 4 ([E2E_PLAN_V2.md](E2E_PLAN_V2.md) lines 11 and 185–187). It is manual or automatable. It is not part of `npm test`.

The live inspection database is `%LOCALAPPDATA%\Bloblex\bloblex.db`, or `%TEMP%\Bloblex\bloblex.db` when `LOCALAPPDATA` is unset. `BLOBLEX_DB_PATH` overrides both ([crates/bloblex-daemon/src/main.rs](../crates/bloblex-daemon/src/main.rs) lines 1065–1072, [PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 26). Never set the variable to that live file, and never open, copy, or delete its `-wal` or `-shm` sidecars.

1. Record `git rev-parse HEAD` and the date. Do not stop, restart, or kill the running inspection app.
2. If the live database file exists, record its last-write time and size. Do not open it.
3. In a new PowerShell session, set `$env:BLOBLEX_DB_PATH` to a new file under `$env:TEMP`, for example `$env:TEMP\bloblex-phase3-smoke.db`. The file must not already exist. The dev script does not unset this variable ([scripts/dev-windows.ps1](../scripts/dev-windows.ps1) lines 1–31). The desktop process starts `bloblexd` without clearing the environment ([apps/desktop/src-tauri/src/lib.rs](../apps/desktop/src-tauri/src/lib.rs) lines 239–243), so the child inherits the variable.
4. From the repository root, run `npm run desktop:dev` ([package.json](../package.json) line 14). Wait until the main window and the companion are up.
5. Confirm the temp database file now exists and is non-empty. Confirm the live database's last-write time and size are unchanged.
6. Roster: one row per discovered runtime's default agent. Claude's face is coral `#F38C6F`, Codex is blue `#82AAFF`, OpenCode is violet `#BF9CFF`, any other runtime is mint `#89D6B3`. The small line under the preview names the runtime. The face is not the only place the provider appears.
7. Edit the Claude blob. Change its colour to pink. Save. The sidebar row, the chat header face, an agent message avatar (open or start a session if needed), the companion island face, a companion mini, and the companion chat face all show pink. Quit is not required for this step.
8. Tray-visible state: open the tray menu. Active sessions still list, and "Pause all agents…" is still present ([apps/desktop/src-tauri/src/lib.rs](../apps/desktop/src-tauri/src/lib.rs) lines 1226–1286). The tray image stays `assets/icon/tray.png` ([apps/desktop/src-tauri/src/lib.rs](../apps/desktop/src-tauri/src/lib.rs) line 1361). A colour change does not recolour that icon. The companion, which is the tray-adjacent surface, is the colour check from step 7. Show the companion from the tray if it was hidden, and confirm the face is still pink.
9. Drag the companion by its drag region. The island body stays opaque and rounded. The native window around it stays transparent (no rectangular plate). Release it somewhere other than the default and confirm it stays there.
10. Create a second blob on the same runtime as Claude, name it "Pink sibling", colour pink, description "Second blob.". Save. Both rows show. Their faces differ if you set the original Claude blob back to coral first; if Claude was left on pink, give the sibling lemon instead so the two faces differ. Start a session on each with two different folders, or the same folder twice. Each blob's header session list shows its own session, not the other's.
11. Archive "Pink sibling". Confirm the copy in section 2. The row disappears. Restart is next, so do not restore it; there is no restore control.
12. Quit Bloblex from the header menu. The inspection app, if it was running, is still running.
13. Start `npm run desktop:dev` again in the same session so `BLOBLEX_DB_PATH` is unchanged. The edited name, the pink (or lemon) colour, the description, and the archived row's absence all survive. The archived blob's session is not offered as a new-session target.
14. Record the temp database path, the git revision, and a pass/fail line per step in `SESSION_HANDOFF.md`. Delete the temp database only after that note exists. Do not copy it over the live database.

## 10. Risks, open questions, and out of scope

Risks:

- `App.tsx` is already large. The new components in section 7 exist so the page does not land as more inline JSX. The lifecycle mounted test must stay green without taking a new `data-color` dependency.
- A partial `agent.update` that accidentally sends `model: null` would wipe a stored value. Send only dirty profile fields.
- JavaScript `toLocaleLowerCase('en')` can disagree with Rust `to_lowercase()`. The UI treats `conflict` as the real answer.
- Migrated colours may be lowercase hex. Equivalence is case-insensitive, or a default blob looks like a custom colour and the coral swatch does not show selected.
- Calling `session.new` with `runtimeId` creates an unowned session (`agentId` null, [PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) lines 164–165). Any leftover call site splits history away from the blob.
- `agent.changed` payload has no colour. Painting from the payload alone leaves the old face until `agent.get`.
- The fixture `rpc` signature is one argument today. Leaving it that way makes the preview ignore create and gives a false sense that the page works.
- Mood tints in the engine shift the body colour while working. Contrast numbers in section 4 are the resting fill.

Open questions for the Director: none that block Phase 3. The choices in this spec are closed on purpose. A later phase still has to specify restore, reorder, and the execution pickers.

### Out of scope

- Phase 2b execution: applying model, thinking, service tier, instructions, custom args, custom env, or concurrency; model catalogs; `exec_snapshots`.
- Phase 4 session tree, expanded-state localStorage, and companion pills that follow the tree rather than the four-agent window in section 4.
- Phase 5 analytics and any per-blob usage numbers, including zeros.
- Phase 6 settings restyle. Phase 7's full native pass. This spec's smoke test does not replace Phase 7.
- `agent.reorder` UI, `agent.restore`, and any edit of an archived row.
- Changing `providerColor`, `hexToRGB`, the engine mood palette, or the tray icon.
- Rust, migrations, and the live inspection database.
- Multica layout, copy, or assets.
- New npm dependencies, including a chart library or Testing Library.
- A Tauri command for the selected agent.

## Implementation notes (accepted deviations)

The Director accepted these without a code change:

- F4: component props beyond the tables in section 7 (`busy`, `onScan`, `mode`, `model`, `execution`, and the page dirty/ready flags).
- F5: the extra "Archive blob" button on the Settings tab, in addition to the roster context menu.
- F8: a benign extra `agent.get` after this client's own save. The fetch still replaces the row with the daemon's agent.

Selectors live in `apps/desktop/src/ui/rosterSelectors.ts` (tests in `rosterSelectors.test.ts`). `agentRoster.ts` was renamed so it does not collide with `AgentRoster.tsx` on a case-insensitive filesystem.
