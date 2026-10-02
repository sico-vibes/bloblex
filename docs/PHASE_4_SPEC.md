# Phase 4 implementation spec: per-blob project and session tree

This is the implementation contract for Phase 4 of [E2E_PLAN_V2.md](E2E_PLAN_V2.md). Phase 4 adds an expandable project and session tree under each blob row in the sidebar. It depends on Phase 2a and on the Phase 3 roster. It does not depend on Phase 2b. Line citations are the committed tree this spec was written against. Re-open a cited line before treating it as current if a later edit moves it.

Do not edit Rust. Do not add a projects table, a session-list RPC, or an expanded-state RPC. Projects are groups derived from `snapshot.sessions`. Expanded state is `localStorage`. Multica and Claude Desktop are behavioural references only: folder-then-session grouping is the behaviour; the paint stays Bloblex Midnight ([THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) lines 37–39, [E2E_PLAN_V2.md](E2E_PLAN_V2.md) lines 13 and 194). Copy no third-party layout, label set, icon, or asset.

## 1. Scope and non-scope

Phase 3 shipped one flat button per active agent ([apps/desktop/src/ui/AgentRoster.tsx](../apps/desktop/src/ui/AgentRoster.tsx) lines 107–138), a header `<select>` for that agent's sessions ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 743), and a flat Sessions tab ([apps/desktop/src/ui/BlobSessions.tsx](../apps/desktop/src/ui/BlobSessions.tsx) lines 17–24). Phase 4 keeps those and adds the tree the plan describes ([E2E_PLAN_V2.md](E2E_PLAN_V2.md) lines 189–200).

In scope:

- A chevron on the right of each blob row. Activating it expands an indented tree under that row.
- Project rows derived from that blob's sessions, each with its own chevron and a "+" that starts a session in that project.
- Session rows with a status dot, a visible state word, a title, and `shortTime`.
- The resolved selected session highlighted when its row is rendered.
- "New session" from the blob context menu, from a project "+", and from the header, offering recent projects and then "Choose folder...".
- Expanded and collapsed state per blob and per project in `localStorage` key `bloblex.roster.expanded`. Phase 3 reserved that key ([docs/PHASE_3_SPEC.md](PHASE_3_SPEC.md) line 393).
- The header `<select>` stays, including the disabled option "Not linked to a blob" ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 743).
- The companion chat follows the selected session. Companion pills still switch blobs.
- Pure selectors, fixture sessions, and tests. No daemon process.

Explicitly deferred. Do not build these in Phase 4:

| Deferred | Where it belongs | What Phase 4 shows instead |
|---|---|---|
| Live model, thinking, speed, concurrency, custom args, custom env | Phase 2b | Unchanged disabled execution card |
| Usage analytics, charts, per-blob totals | Phase 5 | Unchanged "not available yet" usage tab and the existing global Usage link |
| Settings sheet redesign | Phase 6 | Unchanged `SettingsSheet` |
| Full native pass | Phase 7 | Section 10 is an addition to the Phase 3 smoke checklist, not a replacement |
| Drag reorder, `agent.restore`, editing an archived blob | No RPC for restore ([docs/PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 146) | Archived blobs stay off the roster. Their sessions stay in the snapshot and off the tree |
| A daemon `projects` table or path canonicalisation | Not required. Phase 2a stores the caller string and does not canonicalise ([docs/PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 166) | UI grouping key only. `session.new` receives a stored or picked string |
| Virtualised windowing, a new npm dependency | Sidebar lists are small once capped (section 2) | A "Show N more" treeitem |
| Turning the blob Sessions tab into this tree | The tab is the Phase 3 flat list | `BlobSessions` stays a flat list. Its status dot class switches to `sessionDotClass` so the dot matches the tree |
| Removing the header `<select>` | The plan keeps it for keyboard users ([E2E_PLAN_V2.md](E2E_PLAN_V2.md) line 198) | The select stays beside the tree |
| Sidebar resize, a third tree level, drag-and-drop of sessions between projects | Out of the plan | Two levels under the blob: project, then session |

The Phase 4 gate ([E2E_PLAN_V2.md](E2E_PLAN_V2.md) line 200) means one blob can show several sessions in one project and sessions in more than one project; choosing a row selects that session; Resume and Cancel on a session row's menu call the existing `session.resume` and `session.cancel`; keyboard covers arrows, Enter, and the context menu. It does not mean a new daemon method.

Depth stops at the session. [PRODUCT.md](../PRODUCT.md) line 22 lists nested navigation trees among anti-references. This tree is the one planned grouping under the existing rail, two levels deep, on the Midnight roster. It is not a second app navigation system.

## 2. Data derivation

Every project and session row comes from `snapshot.sessions` and `snapshot.agents`. There is no projects table ([docs/PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) lines 34–73). `Session.projectPath`, `agentId`, `runtimeId`, `title`, `state`, `updatedAt`, `resumable`, and `id` are already on the desktop session ([apps/desktop/src/types.ts](../apps/desktop/src/types.ts) lines 63–77) and on the snapshot DTO ([docs/ipc-contract.md](ipc-contract.md) lines 93 and 104–106). `app.snapshot` already includes `sessions` and `agents`. The header select already lists those sessions ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 743). Phase 4 assumes that array is the full persisted session list, which is how Phase 3 already behaves. [docs/ipc-contract.md](ipc-contract.md) line 104 allows later paging of long transcripts, not of the session list.

Owned sessions for a blob are `agentSessions` ([apps/desktop/src/ui/rosterSelectors.ts](../apps/desktop/src/ui/rosterSelectors.ts) lines 28–30): `session.agentId === agent.id`, ordered by `bySessionRecency` (lines 15–18): `updatedAt` descending, then `id` ascending. Keep that comparator. Legacy sessions are `legacySessions` (lines 32–36): `agentId` null or missing, same `runtimeId`, same recency order. An empty-string `agentId` is not legacy.

### Path key

`projectKey(path)` returns the grouping key, or `null` when `path` is not a string or trims to empty.

1. Trim. Replace every `/` with `\`.
2. If the string starts with `\\`, keep that two-character prefix and collapse every run of `\` in the remainder to a single `\`. Otherwise collapse every run of `\` in the whole string to a single `\`.
3. If the result matches a drive root `^[A-Za-z]:\\$`, leave that trailing slash in place. Otherwise strip trailing `\`.
4. Return `toLocaleLowerCase('en')`.
5. Do not resolve `.` or `..`. Do not strip a `\\?\` prefix. Do not call a filesystem canonicaliser. Phase 2a persists the supplied path with `PathBuf`'s string conversion and does not canonicalise ([docs/PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 166). The key is a display grouping. `session.new` never receives the key.

Worked keys:

| Stored `projectPath` | `projectKey` |
|---|---|
| `C:/work/site` | `c:\work\site` |
| `C:\work\site\` | `c:\work\site` |
| `c:\work\site` | `c:\work\site` |
| `C:\\work\\\\site` | `c:\work\site` |
| `C:\` | `c:\` |
| `C:\work\site\..\site` | `c:\work\site\..\site` |
| `\\?\C:\work\site` | `\\?\c:\work\site` |
| `\\server\share\site\` | `\\server\share\site` |
| `  ` or missing | `null` |

Case-folding is a Windows UI decision ([PRODUCT.md](../PRODUCT.md) line 9). NTFS lookups are case-insensitive, and the daemon will have stored whatever string the picker or an older client sent. Two different folders that differ only by case on a case-sensitive volume would share a row. That risk is accepted. The stored string sent back to `session.new` keeps its original casing, slashes, and trailing slash.

### Projects

For one agent, group `agentSessions` by `projectKey`. Sessions whose key is `null` form one group labelled "Project path unavailable" (`projectFolderName` already returns that sentence, [apps/desktop/src/ui/rosterSelectors.ts](../apps/desktop/src/ui/rosterSelectors.ts) lines 109–112). That group has no "+".

The representative path of a group is `projectPath` of the first session in `bySessionRecency` order, unmodified. That is the string a later `session.new` sends for that project.

Project order: the group's newest `updatedAt` descending (empty string when missing), then `projectKey` ascending with `localeCompare`, then the representative path ascending. The null-key group uses key `''` for that tie-break and still sorts by its newest `updatedAt` first.

### Colliding folder names

The base label is `projectFolderName(representativePath)` ([apps/desktop/src/ui/rosterSelectors.ts](../apps/desktop/src/ui/rosterSelectors.ts) lines 109–112). Within one blob, compare those labels with `toLocaleLowerCase('en')`. When two groups share a label, append ` · ` and the nearest ancestor segment from the representative path, using that path's own casing. Split the representative path on `/` or `\`, drop empty segments, and walk from the parent toward the root until every label in the blob is unique. If ancestors run out, append the full representative path in parentheses.

`C:\client\site` and `D:\other\site` render `site · client` and `site · other`. `C:\work\site` and `D:\work\site` render `site · work · C:` and `site · work · D:`. `C:/work/site` and `c:\work\site\` are one group, so they have one label. The `title` attribute on the project row is the representative path. The accessible name is `{label}, project`.

### Sessions inside a project

`bySessionRecency`. The row title is `formatUnknownSafe(session.title, 'New session')` ([apps/desktop/src/types.ts](../apps/desktop/src/types.ts) lines 249–251). A session created with no title comes back as `New chat` ([docs/PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 166) and displays `New chat`. The fallback "New session" is only for a missing or blank title. Do not slice the title in JavaScript. CSS ellipsis truncates it. The `title` attribute is the full display title.

### Legacy sessions

Show them once, under a level-2 node labelled "Other sessions", as a sibling after that blob's project rows. The host blob is `agentsForRuntime(agents, runtimeId)[0]` ([apps/desktop/src/ui/rosterSelectors.ts](../apps/desktop/src/ui/rosterSelectors.ts) lines 24–26), the first active agent of that runtime in roster order. Codex is the host for `runtime-codex`; Invoice helper is not. A second blob on the same CLI does not repeat the rows.

This node is not a project and is not merged into the host's projects. Phase 2a leaves `agentId` null on purpose so a runtime-only session is not attached to one of several agents on that runtime ([docs/PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) lines 75 and 165). Merging the rows into the default agent would present them as that blob's conversations. The header already separates them with "Not linked to a blob" ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 743). The tree uses the same split, drawn once.

Selecting a legacy row sets `selectedSessionId` to that session. When the current agent has the same `runtimeId`, the current agent stays selected. When it does not, the host agent becomes selected. No RPC writes `agentId`. That matches `listenForActiveSession` ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 397–402) and `sessionBelongsToAgent` ([apps/desktop/src/ui/rosterSelectors.ts](../apps/desktop/src/ui/rosterSelectors.ts) lines 177–180).

### Archived agents

Archived agents stay in `snapshot.agents` and stay off the roster (`activeAgents`, [apps/desktop/src/ui/rosterSelectors.ts](../apps/desktop/src/ui/rosterSelectors.ts) lines 20–22). Their sessions have a non-null `agentId`, so they are not legacy and do not move to "Other sessions" or to another blob. They remain on the snapshot, resumable if a later restore shows the blob ([docs/PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) lines 147 and 168). Phase 4 adds no row and no restore control. A session whose `agentId` matches no agent row is treated the same way: hidden, not filed under "Other sessions".

### Offline runtime

Keep the blob and its tree. `deriveCompanionStatus` already labels the blob row "Runtime offline" when the runtime status is `offline`, `error`, or `disconnected` ([apps/desktop/src/ui/companionStatus.ts](../apps/desktop/src/ui/companionStatus.ts) lines 4–7). Session rows keep their own session state. New session and Resume stay disabled when `runtimeUsable` is false ([apps/desktop/src/ui/rosterSelectors.ts](../apps/desktop/src/ui/rosterSelectors.ts) lines 114–117). The chevron still expands.

### Status dot

Add `sessionDotClass(state?: string)` next to `runtimeDotClass` ([apps/desktop/src/ui/rosterSelectors.ts](../apps/desktop/src/ui/rosterSelectors.ts) lines 119–126). Compare the lowercased state. Return one of the four classes already painted by `.status-dot` ([apps/desktop/src/ui/shell.css](../apps/desktop/src/ui/shell.css) lines 70–74). The visible word is `labelize(state, 'Idle')` ([apps/desktop/src/types.ts](../apps/desktop/src/types.ts) lines 104–107). The dot is not the only signal ([PRODUCT.md](../PRODUCT.md) line 38).

| Lowercased state | Class | `labelize` word |
|---|---|---|
| `completed` | `good` | Completed |
| `starting`, `working`, `cancelling`, `waiting_permission`, `waiting_user` | `busy` | Starting, Working, Cancelling, Waiting Permission, Waiting User |
| `error`, `offline`, `failed` | `bad` | Error, Offline, Failed |
| `idle`, `cancelled`, `canceled`, `closed`, missing, anything else | `muted` | Idle, Cancelled, Canceled, Closed, or `labelize` of the unknown word |

The authoritative daemon vocabulary is the list in [docs/ipc-contract.md](ipc-contract.md) line 123. `failed` and `canceled` are display aliases already used by the face helper ([apps/desktop/src/ui/companionStatus.ts](../apps/desktop/src/ui/companionStatus.ts) line 12 and line 15). Do not copy the Sessions tab's current mapping, which sends every state other than `error`, `failed`, and `working` through the runtime "online" bucket ([apps/desktop/src/ui/BlobSessions.tsx](../apps/desktop/src/ui/BlobSessions.tsx) line 19). Point that dot at `sessionDotClass` so an idle session is muted in both places. Leave the tab a flat list.

`runtimeDotClass` and `statusClass` ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 1659–1664) stay the runtime-status helpers. Session rows do not call them.

### Time

Use `shortTime` ([apps/desktop/src/ui/rosterSelectors.ts](../apps/desktop/src/ui/rosterSelectors.ts) lines 93–100). A timestamp from today renders as a local time; any other valid timestamp renders as a short month and day; an invalid timestamp returns `''`. Omit the `<time>` element when `updatedAt` is missing or `shortTime` returns `''`. Do not add a "5 minutes ago" formatter. The blob row already uses `shortTime` ([apps/desktop/src/ui/AgentRoster.tsx](../apps/desktop/src/ui/AgentRoster.tsx) line 134), and the tree uses the same clock.

### Caps

No virtualisation library and no new dependency. The rail is a vertical scroller ([apps/desktop/src/ui/shell.css](../apps/desktop/src/ui/shell.css) line 40).

- Render at most 12 project rows per blob, the newest groups first. Then a treeitem "Show {n} more projects" when some groups are hidden.
- Render at most 30 session rows per project, the newest first. Then a treeitem "Show {n} more conversations".
- "Other sessions" is not part of the 12. Its sessions use the same 30 cap and the same show-more treeitem.
- Enter or a click on a show-more treeitem raises that cap to unlimited for the rest of this page load. The raised cap lives in component state. It is not written to `localStorage`.
- While the search query is non-empty and the blob is visible because of a title match, render every matching session and do not hide it behind the cap. Non-matching sessions stay out of the tree for that query (section 6).

## 3. Row and tree anatomy

The aside keeps the brand row, the roster, and the footer ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 719–734). Search stays outside the tree ([apps/desktop/src/ui/AgentRoster.tsx](../apps/desktop/src/ui/AgentRoster.tsx) lines 75–76). The list element is `<nav class="bot-list runtime-list" aria-label="Blobs" role="tree">`. Runtime headings stay non-focusable `.roster-group-label` elements ([apps/desktop/src/ui/shell.css](../apps/desktop/src/ui/shell.css) line 50) and stay outside the treeitem set. They render only when the visible blobs span more than one `runtimeId`, which is the current rule ([apps/desktop/src/ui/AgentRoster.tsx](../apps/desktop/src/ui/AgentRoster.tsx) lines 30 and 77–80).

The sidebar column is 272px ([apps/desktop/src/ui/shell.css](../apps/desktop/src/ui/shell.css) lines 27–28). There is no new breakpoint and no sidebar resize. [DESIGN.md](../DESIGN.md) line 25's practical minimum still uses this rail. Rows use `min-width: 0` and single-line ellipsis, the same treatment as `.bot-row-top strong` ([apps/desktop/src/ui/shell.css](../apps/desktop/src/ui/shell.css) line 46).

### Blob row

Keep `<button class="bot-row">` with `data-agent-id`, `aria-current="true"` on the selected agent, and the roving `tabIndex` ([apps/desktop/src/ui/AgentRoster.tsx](../apps/desktop/src/ui/AgentRoster.tsx) lines 107–114). Add `role="treeitem"`, `aria-level="1"`, `aria-expanded`, `aria-setsize`, `aria-posinset`, and `aria-selected="false"`. `aria-current` remains the roster's selected-blob signal so the existing mounted query `.bot-row` ([apps/desktop/src/ui/App.agent.mounted.test.tsx](../apps/desktop/src/ui/App.agent.mounted.test.tsx) lines 233–234) still means blob rows only. Project and session rows must not use the class `bot-row`.

Contents, left to right:

1. The existing 42px `BlobCanvas` ([apps/desktop/src/ui/AgentRoster.tsx](../apps/desktop/src/ui/AgentRoster.tsx) line 132). `.blob-canvas` is `flex: 0 0 auto` ([apps/desktop/src/ui/shell.css](../apps/desktop/src/ui/shell.css) line 25).
2. The existing `.bot-row-copy` block: name, `shortTime`, preview, runtime meta (lines 133–136).
3. A trailing chevron, `<span class="tree-chevron" aria-hidden="true">`, `flex: 0 0 28px`, 28×28, painted with the lucide `ChevronRight` when collapsed and `ChevronDown` when expanded. It is the last flex item. The face is the first. The copy column is `min-width: 0; flex: 1`. The chevron occupies its 28px even when invisible, so the face never moves and the glyph never covers the canvas.

The chevron's opacity is 0 until any of these is true: the blob row is hovered, the blob row is `:focus-within`, `aria-expanded="true"`, or the media query `(hover: none)` matches. Touch and `(hover: none)` keep the glyph visible so it is discoverable without a pointer hover. Keyboard users see it when the row is focused, and `aria-expanded` is how a screen reader hears the state. Right arrow expands; the glyph is not a second tab stop.

Pointer: a click on `.tree-chevron` toggles expansion and stops propagation so the button's select handler does not run. A click on the rest of the button runs today's select ([apps/desktop/src/ui/AgentRoster.tsx](../apps/desktop/src/ui/AgentRoster.tsx) line 115), which selects that agent and a session (section 6). Expansion and selection are separate.

When the group is expanded, set `aria-owns` to the id of the sibling group element. The group is a sibling, not a child of the button, because the button cannot contain the project "+" buttons. Unmount the group when collapsed and remove `aria-owns`.

Empty expanded blob: the group contains one non-treeitem paragraph, "No conversations yet." It is not focusable. No fake treeitem.

### Project row

A wrapper `div.tree-project` holds:

- `div.tree-project-item` with `role="treeitem"`, `aria-level="2"`, `aria-expanded`, `aria-selected="false"`, `data-project-key` set to the `projectKey` (the null-key group uses `data-project-key=""`), `data-tree-kind="project"`. Padding-left 16px. Contents: the same chevron span, then the disambiguated label in an ellipsis element. Accessible name `{label}, project`.
- `button.tree-new` with `type="button"`, `tabIndex={-1}`, `aria-label="New session in {label}"`, a lucide `Plus`. It is a sibling of the treeitem, not inside it. It is absent on the null-key group. Opacity follows the same hover, focus-within, expanded, and `(hover: none)` rules as the chevron. It is not in the roving tabindex. A pointer click calls the project create flow. If keyboard focus is on the button because it was clicked, Arrow keys move the tree (section 7) so focus is not trapped.

The project's session group is a sibling `role="group"` owned via `aria-owns` when expanded.

### Other sessions

Same anatomy as a project row with `data-tree-kind="other"`, `aria-level="2"`, accessible name "Other sessions", and no "+" button. It renders only on the host blob, and only when `legacySessions` for that runtime is non-empty. It sits after the project rows and after "Show N more projects".

### Session row

`div.tree-session` with `role="treeitem"`, `aria-level="3"`, `data-session-id`, `data-tree-kind="session"`, padding-left 32px. Contents, left to right, all `min-width: 0` where text can grow:

1. `<i class="status-dot {sessionDotClass}">`.
2. The state word in `.tree-session-state`, colour `var(--ink-3)`.
3. The title in an ellipsis element.
4. `<time>` with `shortTime` when that returns a non-empty string.

`aria-selected="true"` when `session.id` equals the resolved selected session id (section 6). Every other session treeitem has `aria-selected="false"`. The selected row uses the same background as `.bot-row.selected`, which is `var(--raised)` ([apps/desktop/src/ui/shell.css](../apps/desktop/src/ui/shell.css) line 43). Hover background extends the existing `.bot-row:hover` rule ([apps/desktop/src/ui/shell.css](../apps/desktop/src/ui/shell.css) line 42) to `.tree-project-item` and `.tree-session` so no new colour literal is introduced.

Accessible name: `{title}, {state word}, {shortTime or "time unavailable"}`.

### Show-more rows

`role="treeitem"`, `data-tree-kind="more"`, `aria-selected="false"`, `aria-level` 2 for projects and 3 for sessions. The accessible name is the visible sentence ("Show 4 more projects", "Show 1 more conversation", with the count and the singular "conversation" when the count is 1).

### Reduced motion

Do not animate expand or collapse. Mounting and unmounting the group is instant. Do not transition the chevron's rotation; swap the icon. Do not add a `transition` on `.tree-group` or `.tree-chevron`. The global stylesheet already collapses animation and transition durations under `prefers-reduced-motion: reduce` ([apps/desktop/src/ui/styles.css](../apps/desktop/src/ui/styles.css) lines 253–255). Phase 4 does not rely on that query to hide a motion path, because it adds none.

### Narrow width

At 272px the flex math is: 6px list padding each side, 10px row padding each side, 42px face, 11px gap, flexible copy, 28px chevron. The face and the chevron are on opposite ends of the row. Labels ellipsize. The tree does not add a horizontal scrollbar on a row (`overflow: hidden` on the label, the list keeps vertical overflow only).

## 4. New session flows

Every Bloblex-initiated create goes through `sessionNewParams` ([apps/desktop/src/ui/rosterSelectors.ts](../apps/desktop/src/ui/rosterSelectors.ts) lines 193–196), which returns exactly `{ agentId, projectPath }`. Omit `runtimeId` and omit `title`. Sending both ids is `invalid_argument` ([docs/PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 162, [docs/ipc-contract.md](ipc-contract.md) line 64). The daemon stores a blank title as `New chat` ([docs/PHASE_2A_SPEC.md](PHASE_2A_SPEC.md) line 166). Phase 3's `newSession` already calls this helper ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 603–624).

`openProjectFolder` is the existing picker ([apps/desktop/src/tauri.ts](../apps/desktop/src/tauri.ts) lines 12–14). A cancel returns null, and the caller returns without an RPC, which is what `newSession` does today (lines 612–614).

Errors use `daemonCodeOf` plus `messageForDaemonCode(code, 'session.new')` ([apps/desktop/src/ui/agentForm.ts](../apps/desktop/src/ui/agentForm.ts) lines 119–124 and 126–149). Show that sentence, not the daemon's message text. The sentences Phase 4 needs are already there: `conflict` → "This blob is archived, so a new session cannot be started."; `not_found` → "That blob is no longer available. Refresh and try again."; `invalid_argument` → "Choose a project folder that exists on this device."; `unauthorized` → "Bloblex could not reach the local daemon. Reconnect and try again."; any other code → "The local daemon request failed."

Enabled when the daemon is connected, `busy` is false, and `runtimeUsable` is true for that blob's runtime. That is the menu flag already computed in [apps/desktop/src/ui/AgentRoster.tsx](../apps/desktop/src/ui/AgentRoster.tsx) lines 89–90 and `canStartSession` in [apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 694.

### Recent projects

`recentProjects(sessions, agent, limit)` takes owned sessions only. Group by `projectKey`, drop `null` keys, order like project groups, and return at most `limit` entries. Each entry is `{ key, path, label }` where `path` is the representative stored string and `label` is the disambiguated folder label. The chooser uses limit 8. The tree uses the section 2 caps, not this limit.

When `agent.defaultProject` trims to a non-empty string, pin that path as the first chooser row. Send the trimmed `defaultProject` string, not a rewritten key. If some session group has the same `projectKey`, that row is the pinned one and it is not repeated. Its label gains the suffix ` · Default`. The settings helper changes to: "Shown first when you start a session. Leave blank to pick from recent folders." The current sentence says a new session starts in that folder immediately ([apps/desktop/src/ui/BlobSettings.tsx](../apps/desktop/src/ui/BlobSettings.tsx) line 67). Phase 4 shows the folder first and still requires a click, so the helper matches the chooser. `defaultProject` stays a UI hint. Phase 2a does not read it inside `session.new` ([docs/PHASE_3_SPEC.md](PHASE_3_SPEC.md) line 386).

### Who opens the chooser

The blob context menu item "New session" ([apps/desktop/src/ui/AgentContextMenu.tsx](../apps/desktop/src/ui/AgentContextMenu.tsx) line 39), the header pill "Session" ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 746), the header more-menu "New session" (line 752), the empty-conversation button (`EmptyConversation` calls `onNewSession`, [apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 803–809), and the companion plus and its empty-chat "New session" ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 687 and 1606) all open the same chooser for that blob.

The chooser is a `role="menu"` using the existing `.runtime-context-menu` ([apps/desktop/src/ui/styles.css](../apps/desktop/src/ui/styles.css) lines 163–167). Focus the first enabled item. Arrow Up and Down, Home, and End move inside it. Escape and an outside pointer close it and return focus to the control that opened it. Entries are at most 8 path rows, with the default pinned first when it is set and not repeated, then "Choose folder...". Activating a path row calls `session.new` with `sessionNewParams(agent.id, path)`. Activating "Choose folder..." calls `openProjectFolder()` and returns with no RPC when the user cancels.

When the trimmed default is empty and `recentProjects` is empty, skip the menu and call `openProjectFolder()` directly. That is the zero-history path.

On `invalid_argument`, if the path that was sent is the trimmed `defaultProject`, show the mapped sentence and then open `openProjectFolder()` for one second `session.new`, and do not clear `defaultProject`. That is today's fallback ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 619–623). On `invalid_argument` for a recent path or a picked path, show the mapped sentence and do not open the picker again.

### Project "+"

No chooser. Call `sessionNewParams(agent.id, representativePath)` with that group's stored representative path. On `invalid_argument`, show the mapped sentence only. The user asked for that project; a different folder is the blob-level chooser.

### After success

Keep the current success path ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 625–633): unwrap the session, select its active `agentId` when present, set `selectedSessionId`, refresh the tray, refresh the snapshot. Also set that blob open and that project's key open in the expanded state, persist it, raise the in-memory cap if the new row would be hidden, and focus `[data-session-id="…"]` once the row exists. Announce on the existing polite region ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 724): `Started {title} in {label}.` Use the display title from section 2.

Resume and Cancel are not create flows. They stay available from the session row's context menu (section 7) and from the header and composer, which already call `session.resume` and `session.cancel` with `{ sessionId }` ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 647–655, 748, and 777).

## 5. Persistence

One key: `bloblex.roster.expanded`. No other new key. `bloblex.selectedAgentId` stays as `readStoredAgentId` / `writeStoredAgentId` ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 836–845). The companion window does not read or write the expanded key.

Schema, version 1:

```ts
type ExpandedState = {
  v: 1
  blobs: Record<string, { open: boolean; projects: Record<string, boolean>; other: boolean }>
}
```

`blobs[agentId].open` is the blob chevron. `projects[projectKey]` true means that project is expanded. `other` true means "Other sessions" is expanded on the host blob. A missing agent, a missing project key, or a missing `other` means collapsed. The first visit is all collapsed. Do not auto-expand the selected blob on boot or when the selection changes. The mounted Arrow Down test focuses the second `.bot-row` from the first ([apps/desktop/src/ui/App.agent.mounted.test.tsx](../apps/desktop/src/ui/App.agent.mounted.test.tsx) lines 320–328), which is true only while blob rows start collapsed and project rows are not `.bot-row`.

`parseExpandedState(raw: string | null): ExpandedState` is pure and does not throw. `null`, invalid JSON, a non-object, or `v` other than the number `1` returns `{ v: 1, blobs: {} }`. Ignore entries whose `open` is not boolean. Ignore project values that are not boolean. Ignore `other` when it is not boolean. Drop unknown agent fields rather than failing the whole document.

Storage access in `App.tsx` matches the guarded helpers:

```ts
function readRosterExpanded(): ExpandedState {
  try { return parseExpandedState(localStorage.getItem('bloblex.roster.expanded')) }
  catch { return { v: 1, blobs: {} } }
}
function writeRosterExpanded(state: ExpandedState) {
  try { localStorage.setItem('bloblex.roster.expanded', JSON.stringify(state)) }
  catch { /* A blocked Storage API must not break the tree. */ }
}
```

A throwing `getItem` leaves every blob collapsed and the roster still renders. A throwing `setItem` leaves the in-memory chevron where the user put it and does not surface an error. Read once into React state on mount. Writes persist that React state. Do not re-read between a click and its write.

`garbageCollectExpanded(state, agents, sessions)` is pure. Drop a blob id that is absent from `snapshot.agents` or whose agent has `archived === true`. For each remaining blob, drop project keys that are not in that blob's current `projectKey` set, including the `''` key when a null-path group exists. Set `other` to false when this blob is not the host of its runtime or when that runtime has no legacy sessions. Keep a blob entry that is still `open` even if every project key was dropped. If garbage collection changes the value, write it back. Run it when the snapshot's agents or sessions change. Do not drop keys because search is hiding rows, and do not persist search auto-expand (section 6).

Creating a session writes the ancestor open bits (section 4). Collapsing a row writes `false` for that bit. Deleting a bit and setting it false are the same on the next read, because missing means collapsed; garbage collection is what removes dead ids.

Do not store titles, message text, colours, instructions, or draft fields.

## 6. State model and selectors

Agents and sessions stay on the single snapshot `applyEvent` updates ([apps/desktop/src/types.ts](../apps/desktop/src/types.ts) lines 135–141 for `session.changed`, lines 144–158 for `agent.changed`). Do not add a second session store. `session.changed` already replaces the matching session in `snapshot.sessions`. The tree re-derives on that render. A new `projectPath` moves the row to the matching group. A removed id disappears. If the resolved selection pointed at a missing id, `sessionForSelection` already falls through to that agent's latest owned session ([apps/desktop/src/ui/rosterSelectors.ts](../apps/desktop/src/ui/rosterSelectors.ts) lines 182–191). Highlight and the chat both use that resolved session.

Put the new functions in `rosterSelectors.ts`. Leave `rosterRows` behaviour as it is, including "project paths do not match search" ([apps/desktop/src/ui/rosterSelectors.test.ts](../apps/desktop/src/ui/rosterSelectors.test.ts) lines 30–41). `treeModel` is the function the roster renders.

| Function | Inputs | Output |
|---|---|---|
| `projectKey` | `path: string \| null \| undefined` | `string \| null` |
| `sessionDotClass` | `state?: string` | `'good' \| 'busy' \| 'bad' \| 'muted'` |
| `projectGroups` | `sessions`, `agentId` | `{ key, path, label, sessions }[]` in section 2 order, labels already disambiguated |
| `recentProjects` | `sessions`, `agent`, `limit` | `{ key, path, label }[]` |
| `treeModel` | `agents`, `sessions`, `query` | `{ groups: { runtimeId, rows: TreeRow[] }[] }` |
| `parseExpandedState` | `raw: string \| null` | `ExpandedState` |
| `garbageCollectExpanded` | `state`, `agents`, `sessions` | `ExpandedState` |

`TreeRow` is `{ agent, latest, matchedTitle, projects, other, forceOpen }`. `projects` is the `projectGroups` result filtered by the search rule below. `other` is the legacy list for the host blob, or `null` for every other blob. `forceOpen` is `{ blob: boolean, projects: Record<string, boolean>, other: boolean }` and is derived only from the query. It is not stored.

`treeModel` starts from the same membership and order as `rosterRows` ([apps/desktop/src/ui/rosterSelectors.ts](../apps/desktop/src/ui/rosterSelectors.ts) lines 48–63). It then adds the host blob of a runtime when a legacy session title matches the query and `rosterRows` would have dropped that blob. The preview line for that added row is `Session: {title}` via the same shape as `matchedTitle`. An owned title match still wins over a legacy title match.

Search rules, query trimmed and compared with `toLocaleLowerCase('en')`, same as `containsQuery` (lines 44–46):

- Empty query: every active blob, all of its projects, all of its sessions subject to the cap, and the host's "Other sessions" when legacy sessions exist. `forceOpen` is all false. Expansion comes from `ExpandedState`.
- Name match (`agent.name` contains the query): the blob stays. `forceOpen.blob` is false. Children are whatever the stored expansion says, and they are not filtered down to title hits. A name match that also hits a title is this case, matching today's `matchedTitle` rule which sets the title preview only when the name missed (lines 58–61).
- Title match on an owned session, name missed: the blob stays, `forceOpen.blob` is true, `forceOpen.projects[key]` is true for each project that contains a hit, and the rendered children are the matching sessions only. Sibling projects with no hit are omitted. The cap does not hide a hit.
- Legacy title match, name missed, no owned title hit: same, with `forceOpen.other` true, on the host blob only.
- Project paths, descriptions, instructions, and runtime labels do not match. `C:/parser` still matches nothing, which is the existing test.

Clearing the query drops `forceOpen` and shows the stored expansion again. Auto-expand is not written to `localStorage`.

Memoisation: `AgentRoster` wraps `treeModel(agents, sessions, query)` in `useMemo` with those three dependencies. The pure functions do not keep a module-level cache. Expanded state is applied during render from the memoised model plus the `ExpandedState` object; do not bake `forceOpen` into the persisted object.

### Selection

Keep `selectedAgentId` and `selectedSessionId`. The chat's session is `sessionForSelection` when an active agent is selected ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 132–134). Pass that resolved `selectedSession?.id ?? null` into the tree as the highlight id, so the highlighted row is the conversation on screen.

`selectAgent` ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 696–704) stays the blob-row click: that agent, its latest owned session, `setActiveRuntime`, `setActiveSession`, and close the blob page when it is open for a different agent. A blob click does not toggle the chevron.

`selectSession(session)`:

- When `session.agentId` is an active agent's id, select that agent and this session. Do not replace the session with that agent's latest. Close the blob page when it is open for a different agent. Call `setActiveRuntime(agent.runtimeId)` and `setActiveSession(session.id)`.
- When `session.agentId` is an active id equal to the current agent, set `selectedSessionId` only, plus `setActiveSession`.
- When `agentId` is null or missing and the current agent shares `session.runtimeId`, keep the agent and set the session.
- When `agentId` is null or missing and the current agent does not share the runtime, select `agentsForRuntime(...)[0]` and set the session.
- When `agentId` points at an archived or unknown agent, do nothing. Those rows are not rendered.

The header `<select>` keeps `onChange` setting `selectedSessionId` only ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 743). The effect at lines 407–416 calls `setActiveSession` when the resolved session id changes. Choosing a header option does not expand the tree.

`listenForActiveSession` (lines 386–403) and `listenForActiveRuntime` (lines 352–361) stay. A tree click that calls `setActiveSession` is how the companion window hears the new id. `agent.changed` archive handling (lines 444–468) stays: the next active agent is selected, `selectedSessionId` becomes that agent's latest, the polite text is unchanged, and garbage collection drops the archived id's expanded entry. Focus the next blob's `[data-agent-id]` after that selection, or the Create blob button when no blob remains.

Boot stays collapsed even when `getActiveSession` restores a session ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 418–435). The header select shows that conversation while the tree is collapsed.

### Companion

The companion already renders the selected session. These paths stay readers of the `session` prop and must not grow a session list of their own:

- `companionSession` is the permission's session when one is pending, otherwise `selectedSession` ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 144–146). A pending approval keeps the companion on that session's card. Phase 4 leaves that priority in place.
- The overview title uses `session.title` (line 1594).
- The chat log and composer use `session` (lines 1602–1616).
- Pills are `companionPills` (line 1534) and render at lines 1599–1600. `companionPills` itself ([apps/desktop/src/ui/rosterSelectors.ts](../apps/desktop/src/ui/rosterSelectors.ts) lines 198–206) stays.
- The document Escape handler (lines 1375–1382) stays Escape-only and stays on the companion window.

The one call site that changes: the companion early return's `onSelectAgent` lambda ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 687) duplicates `selectAgent` and is unreachable by it because `selectAgent` is declared after the `if (companion) return`. Move `selectAgent` above that return and pass `onSelectAgent={selectAgent}`. A pill click selects that blob and that blob's latest owned session, which is what the lambda does today. The companion chat then shows that session because `companionSession` follows the selection. There is no per-blob session memory beyond the single `selectedSessionId` and the single `setActiveSession` slot ([apps/desktop/src/tauri.ts](../apps/desktop/src/tauri.ts) lines 51–53). A second map would disagree with `sessionForSelection`.

Clicking the pill for the agent that is already selected still runs `selectAgent` and therefore selects that agent's latest owned session. That is the current lambda. Leave it.

## 7. Accessibility and keyboard

Use the ARIA tree pattern with roving tabindex, one tab stop, on real elements. Do not use `aria-activedescendant`. Phase 3 already moves DOM focus ([apps/desktop/src/ui/AgentRoster.tsx](../apps/desktop/src/ui/AgentRoster.tsx) lines 53–64), and the mounted test asserts `document.activeElement` (lines 320–328). `aria-activedescendant` would throw that test away.

Selection does not follow arrow focus. Arrows move the roving tabindex. Enter and Space activate. That is the Phase 3 contract (lines 124–129) carried into the tree. The tree pattern supplies `aria-expanded`, levels, set size, and position. The blob's selected state stays `aria-current` because that is what the roster tests assert. The session's selected state is `aria-selected`. Project rows and blob rows set `aria-selected="false"`. A collapsed tree can have a selected session that is not mounted; the header `<select>` still exposes it.

`aria-setsize` and `aria-posinset` count siblings at that level. Blob items count visible blob treeitems across the whole tree, runtime headings excluded. Project-level items count that blob's rendered projects, its show-more-projects item when present, and "Other sessions" when present. Session-level items count the rendered sessions in that group plus its show-more item when present.

The key handler is on the tree (`keydown` on the nav), not on `document`. If `event.target` is an `input`, `textarea`, or `select`, return without handling. The search field is outside the nav ([apps/desktop/src/ui/AgentRoster.tsx](../apps/desktop/src/ui/AgentRoster.tsx) line 75). The chat composer is a textarea in the conversation pane ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 776) and already consumes Enter to send. The companion composer does the same (line 1616). Typing in either must not move the tree. Do not register a window listener for arrows, letters, or Space.

Visible treeitems, in order: each blob, and when that blob is expanded (stored open or `forceOpen.blob`), its rendered project rows, each project's sessions when that project is expanded, show-more items, and "Other sessions" with its sessions when that node is expanded. Collapsed parents omit their children from this list.

| Key | When focus is on a treeitem |
|---|---|
| Arrow Down | Next visible treeitem. From the last, wrap to the first. Does not change `aria-current` or `aria-selected`. |
| Arrow Up | Previous visible treeitem, wrapping. Does not change selection. |
| Home | Focus the first visible treeitem. |
| End | Focus the last visible treeitem. |
| Arrow Right | Collapsed blob or project or Other: expand, keep focus on it. Expanded blob or project or Other: move focus to the first child. Session or show-more: do nothing. |
| Arrow Left | Expanded blob or project or Other: collapse, keep focus on it. If focus was inside a group that this collapse unmounts, focus the parent that collapsed. Already-collapsed blob: do nothing. Session or show-more: focus the parent project, Other node, or blob. |
| Enter | Blob: `selectAgent`. Project or Other: toggle expand. Session: `selectSession`. Show-more: raise that cap. |
| Space | Same as Enter. `preventDefault` so the page does not scroll. |
| ContextMenu, Shift+F10 | Open the menu for the focused row (below). `preventDefault`. |
| Type-ahead | A printable character with no Ctrl, Alt, or Meta appends to a prefix. After 700ms of quiet the prefix clears. Focus moves to the next visible treeitem, wrapping, whose primary label starts with the prefix under `toLocaleLowerCase('en')`. Primary labels are the agent name, the project label, "Other sessions", the session title, and the show-more sentence. Type-ahead does not change selection. |
| Escape | Closes an open menu and returns focus to the treeitem. It does not collapse the tree. |

Up and Down keep the wrap Phase 3 uses ([apps/desktop/src/ui/AgentRoster.tsx](../apps/desktop/src/ui/AgentRoster.tsx) lines 57–59) so the roster and the tree are one list. While every blob is collapsed, Arrow Down from the first blob still lands on the second blob, which is the existing test.

Context menus reuse `.runtime-context-menu` and the existing key pattern ([apps/desktop/src/ui/AgentContextMenu.tsx](../apps/desktop/src/ui/AgentContextMenu.tsx) lines 15–39): focus the first enabled item, arrows, Home, End, Escape, outside pointer.

| Focused row | Menu items |
|---|---|
| Blob | Unchanged: New session, Edit blob, Duplicate, Archive ([apps/desktop/src/ui/AgentContextMenu.tsx](../apps/desktop/src/ui/AgentContextMenu.tsx) lines 39–42). New session opens the chooser (section 4). |
| Project | One item, "New session", enabled when that blob can create. It runs the project "+" path. The null-key project has no menu item. |
| Other sessions | No menu. |
| Session | "Resume conversation" and "Cancel turn". |

Resume is enabled when `session.resumable` is true, the daemon is connected, `busy` is false, the session's runtime passes `runtimeUsable`, and the state is not `working`, `starting`, or `waiting_permission`. That is the header button's condition ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 691 and 748). Cancel is enabled when the state is `working` or `waiting_permission`, matching the composer cancel state `turnLive` (lines 692 and 777). Activating either runs `selectSession` for that row and then the existing `session.resume` or `session.cancel` call with `{ sessionId }` only (lines 647–655). Do not send `turnId`. Do not add a new error mapper; the existing `doRpc` path surfaces the thrown message, including `unsupported` from `session.resume` ([docs/ipc-contract.md](ipc-contract.md) line 71).

Focus restoration:

- Search hides the focused id: move focus to the first visible treeitem, or to Create blob when none remain. Generalise the effect at [apps/desktop/src/ui/AgentRoster.tsx](../apps/desktop/src/ui/AgentRoster.tsx) lines 42–51 from blob ids to visible treeitem ids.
- After `session.new` succeeds: focus the new session row (section 4).
- After archive: focus the next blob row, or Create blob (section 6).
- After collapse: focus stays on the row that collapsed, or moves there from a child that unmounted.
- Opening the blob page still focuses Back. Closing it still focuses `[data-agent-id]` ([apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) lines 527–533).

Screen-reader names are the ones in section 3. The chevron and the decorative plus glyph are `aria-hidden` on the span; the "+" button's name is its `aria-label`. The polite region at [apps/desktop/src/ui/App.tsx](../apps/desktop/src/ui/App.tsx) line 724 keeps the archive sentence and gains the "Started {title} in {label}." sentence. Do not also announce every chevron toggle; `aria-expanded` carries that.

`div` treeitems use the same focus outline as buttons: `outline: 2px solid var(--blue-border); outline-offset: 2px` ([apps/desktop/src/ui/shell.css](../apps/desktop/src/ui/shell.css) line 162).

## 8. File-level change list

Create:

| File | Purpose |
|---|---|
| `apps/desktop/src/ui/SessionTree.tsx` | The group under one blob: projects, sessions, Other sessions, show-more, empty line, session menu |
| `apps/desktop/src/ui/ProjectChooser.tsx` | The recent-projects menu plus "Choose folder..." |

Modify:

| File | Purpose |
|---|---|
| `apps/desktop/src/ui/rosterSelectors.ts` | `projectKey`, groups, labels, `sessionDotClass`, `recentProjects`, `treeModel`, parse and garbage-collect expanded state |
| `apps/desktop/src/ui/rosterSelectors.test.ts` | Pure tests in section 9 |
| `apps/desktop/src/ui/AgentRoster.tsx` | Tree semantics on the blob button, chevron, `SessionTree`, visible-treeitem keyboard |
| `apps/desktop/src/ui/App.tsx` | Expanded state, `selectSession`, chooser wiring, `selectAgent` shared with the companion pill |
| `apps/desktop/src/ui/shell.css` | Tree row layout using existing tokens. No new colour literal |
| `apps/desktop/src/ui/BlobSettings.tsx` | The default-project helper sentence in section 4 |
| `apps/desktop/src/ui/BlobSessions.tsx` | Status dot uses `sessionDotClass`. The list stays flat |
| `apps/desktop/src/preview/fixtureBridge.ts` | The extra sessions in section 9 |
| `apps/desktop/src/ui/App.agent.mounted.test.tsx` | New mounted cases, and the two header "Session" cases updated to go through the chooser |

Do not modify Rust, Tauri commands, `package.json`, or CSS token values. `main.tsx` already imports `shell.css` ([apps/desktop/src/main.tsx](../apps/desktop/src/main.tsx) lines 4–7). Tree rules live in `shell.css` beside `.bot-row`. No new stylesheet.

### Component props

Names and fields only.

- `SessionTree`: `agentId`, `projects` (`key`, `path`, `label`, `sessions`), `otherSessions` (`Session[] | null`), `openProjects` (`Record<string, boolean>`), `otherOpen`, `selectedSessionId`, `canCreate`, `sessionLimit`, `projectLimit`, `onToggleProject` (`key`), `onToggleOther`, `onSelectSession` (`session`), `onNewSessionInProject` (`path`), `onResume` (`session`), `onCancel` (`session`), `onShowMoreProjects`, `onShowMoreSessions` (`key`).
- `ProjectChooser`: `agentName`, `options` (`key`, `path`, `label`), `position` (`x`, `y`), `onChoose` (`path`), `onBrowse`, `onClose`.
- `AgentRoster` gains `selectedSessionId`, `expanded` (`ExpandedState`), `onToggleBlob` (`agentId`), `onToggleProject` (`agentId`, `key`), `onToggleOther` (`agentId`), `onSelectSession`, `onNewSessionInProject` (`agent`, `path`), `onResumeSession`, `onCancelSession`. Existing props stay.

`SessionTree` is presentational. `App` owns selection, RPCs, and storage.

### CSS

Add `.tree-chevron`, `.tree-group`, `.tree-project`, `.tree-project-item`, `.tree-session`, `.tree-session-state`, `.tree-new`, `.tree-more`, and `.tree-empty` to `shell.css`. Use `var(--ink)`, `var(--ink-2)`, `var(--ink-3)`, `var(--raised)`, `var(--panel)`, `var(--hairline)`, and `var(--blue-border)`. Selected session background is `var(--raised)`. Hover reuses the existing `.bot-row:hover` declaration. Status colours stay the existing `.status-dot.good`, `.busy`, `.bad`, and `.muted`. Do not add a hex, an `oklch`, or an alpha literal for the tree. Indent is 16px on project-level rows and 32px on session-level rows. The chevron box is 28×28 with `flex: 0 0 28px` and `opacity` 0 or 1 and no transition. `.tree-empty` uses the same type size and `var(--ink-2)` as `.rail-empty` ([apps/desktop/src/ui/shell.css](../apps/desktop/src/ui/shell.css) line 51).

## 9. Fixtures and tests

Add these sessions in [apps/desktop/src/preview/fixtureBridge.ts](../apps/desktop/src/preview/fixtureBridge.ts) beside the current four (lines 25–38). Keep the current four. The fixture `session.new` already accepts `{ agentId, projectPath }` and rejects both ids (lines 149–168). `openProjectFolder` already returns null (line 175); mounted tests keep mocking it.

| id | agentId | runtimeId | projectPath | title | state | Why it is here |
|---|---|---|---|---|---|---|
| `session-claude-2` | `agent-claude` | `runtime-claude` | `c:\work\site\` | `Hero follow-up` | `idle` | Same folder as `session-claude` (`C:/work/site`) after normalisation, second session |
| `session-claude-web` | `agent-claude` | `runtime-claude` | `C:\work\web` | `Pricing page` | `completed` | A second project on Claude |
| `session-claude-dotdot` | `agent-claude` | `runtime-claude` | `C:\work\site\..\site` | `Dotdot path` | `idle` | Must stay its own project |
| `session-invoice-a` | `agent-invoice` | `runtime-codex` | `C:\client\site` | `North site` | `idle` | Collides on the folder name `site` |
| `session-invoice-b` | `agent-invoice` | `runtime-codex` | `D:\other\site` | `South site` | `working` | The other `site` |
| `session-retired` | `agent-old` | `runtime-codex` | `C:\old\repo` | `Archived chat` | `idle` | Archived owner's session, hidden |
| `session-codex-many-1` … `session-codex-many-31` | `agent-codex` | `runtime-codex` | `C:\work\korus` | `Bulk {n}` | `idle` | 31 sessions in one project so the cap hides the oldest |

Give `session-claude-2` a newer `updatedAt` than `session-claude`. Give the 31 bulk sessions `updatedAt` values that increase with `n`, so `Bulk 31` is newest. `session-legacy` (`agentId: null`, title `Untied notes`) is already in the fixture (line 37). `?offline=1` already marks `runtime-codex` offline (lines 51–53). Do not add a query flag.

The desktop package runs Vitest through the root scripts ([package.json](../package.json) lines 8–10). Mounted tests follow `App.agent.mounted.test.tsx`: the `happy-dom` banner, `createRoot` plus `act`, and `vi.mock` of `../tauri`. Pure tests have no banner. None of these start the daemon or set `BLOBLEX_DB_PATH`.

Update the two existing mounted tests that click the header "Session" button and expect an immediate RPC ([apps/desktop/src/ui/App.agent.mounted.test.tsx](../apps/desktop/src/ui/App.agent.mounted.test.tsx) lines 523–530 and 533–539). Claude has a session, so Phase 4 opens the chooser. The payload test activates the recent row for `site` and still expects `{ agentId: 'agent-claude', projectPath: 'C:/work/site' }` with exactly those keys. The `invalid_argument` test activates that same row and still expects the sentence "Choose a project folder that exists on this device." The Arrow Down test (lines 320–328) stays as written: blobs start collapsed, and `.bot-row` is still only blob buttons.

Each test below fails under the bug named on its last line.

Pure tests in `rosterSelectors.test.ts`:

- Grouping and ordering. Claude's `C:/work/site` and `c:\work\site\` are one group whose sessions are `session-claude-2` then `session-claude`. The web project sorts after that group when its `updatedAt` is older. Bug: alphabetical project order, or a session sort that puts the older session first.
- Collision. Invoice's two groups render `site · client` and `site · other`. Bug: both labels are `site`.
- Path normalisation. The three strings in the worked-key table that share `c:\work\site` are one group. `C:\work\site\..\site` is a second group. `\\?\C:\work\site` is a third. `C:\` stays `c:\` and does not become `c:`. A blank path is `null`. Bug: resolving `..`, stripping `\\?\`, or splitting one folder into three because of slash or case differences.
- Expand state. `parseExpandedState` of a valid v1 document returns the blob open bit. `parseExpandedState('{"v":2,"blobs":{"agent-claude":{"open":true}}}')` returns no open blobs. `parseExpandedState('{')` returns empty. `garbageCollectExpanded` drops an archived id and a project key with no current session, and keeps a live project key. Bug: honouring `v: 2`, throwing on bad JSON, or retaining `agent-old`.
- `recentProjects` pins a trimmed `defaultProject` first, does not duplicate it when a session shares the key, and returns the stored session string rather than the key. Limit 8 drops the ninth. Bug: sending the lowercased key, or listing the default twice.
- `sessionDotClass('working')` is `busy`, `sessionDotClass('idle')` is `muted`, `sessionDotClass('error')` is `bad`, `sessionDotClass('completed')` is `good`. Bug: the Sessions-tab mapping that paints idle as online.
- `treeModel` with query `untied` returns the Codex row, `forceOpen.other` true, and does not return Invoice helper. Query `C:/work/korus` returns no rows. Query `parser` still returns Codex through the owned title and sets `forceOpen` on that project. A name query `Invoice` sets `forceOpen.blob` false. Bug: legacy rows under every Codex blob, a path match, or persisting a force-open bit into `ExpandedState` (assert `forceOpen` is on the model and `parseExpandedState` was not involved).

Mounted tests in `App.agent.mounted.test.tsx`:

- Collapsed roster. On first paint, blob buttons have `aria-expanded="false"` and no `[data-session-id]` is mounted. Bug: boot auto-expand, which also breaks Arrow Down onto a project row.
- Keyboard. Right on Claude sets `aria-expanded="true"` and leaves `aria-current` on Claude. Arrow Down focuses the first project treeitem and leaves `aria-current` on Claude. Enter on that project expands it. Enter on a session sets `aria-selected="true"` on that `data-session-id` and `aria-current` on that session's blob. Left collapses the project and leaves focus on the project. Bug: arrows changing `aria-current`, or Right moving focus into the child instead of expanding in place.
- Selection sync. Expand Invoice helper, activate `session-invoice-b`. `aria-current` is on Invoice helper and `aria-selected` is on that session, while `session-invoice-a` is `aria-selected="false"`. `setActiveSession` is called with `session-invoice-b`. Bug: the blob click path that substitutes the latest session.
- Legacy selection. Expand Codex, activate `Untied notes`. The session is selected and Codex stays current when Codex was already current. Invoice helper's tree has no "Other sessions" node. Bug: duplicating the legacy row under Invoice helper, or calling an RPC that sets `agentId`.
- New-session payload. In the mounted snapshot the Claude session path is `C:/work/site` ([apps/desktop/src/ui/App.agent.mounted.test.tsx](../apps/desktop/src/ui/App.agent.mounted.test.tsx) line 85). Project "+" on that group calls `session.new` with exactly `{ agentId: 'agent-claude', projectPath: 'C:/work/site' }`. The header chooser's "Choose folder..." uses the picker result and the same two keys. A pure test on the fixture pair asserts the representative is the newer stored string `c:\work\site\`, not the key `c:\work\site`. Bug: a third key `runtimeId`, or sending the normalised key.
- Default project. Set Claude's `defaultProject` to `C:/work/site`. The chooser's first item label ends with `Default`. Activating it sends that trimmed string. A fixture `invalid_argument` on that call shows "Choose a project folder that exists on this device." and then calls `openProjectFolder`. Bug: skipping the mapped sentence, or clearing `defaultProject`.
- Search auto-expand. Query `follow-up` sets Claude's `aria-expanded="true"` and the site project's `aria-expanded="true"` without `localStorage.setItem` having been called with `bloblex.roster.expanded`. Clearing the query removes those session rows when stored state is collapsed. Query `Invoice` leaves Invoice helper `aria-expanded="false"`. Bug: writing the search expansion, or failing to expand a title hit.
- Persistence. Seed `getItem` to return a v1 document with Claude open. After mount, Claude is expanded before any click. Toggle the chevron closed and expect `setItem` with `open: false`. Replace `setItem` with a function that throws, toggle again, and expect `aria-expanded="true"` with the roster still mounted. Replace `getItem` with a function that throws and expect four collapsed blob rows. Bug: an exception escaping the toggle, or a throw on read blanking the roster.
- Cap. Expand the Korus project. Exactly 30 session rows plus one "Show 1 more conversation" treeitem are mounted, and `Bulk 31` is among the 30. Enter on show-more mounts `Bulk 1`. Bug: rendering all 31 immediately, or hiding the newest.
- Offline. With the `?offline` snapshot, Codex's sessions still mount after Right, and the blob menu's "New session" is disabled. Bug: dropping offline blobs' children, or leaving New session enabled.
- Archived. The text `Archived chat` is absent, and `Retired` is absent. Bug: rendering `agent-old`'s session under Codex or under Other sessions.
- Composer isolation. Focus the chat textarea, dispatch Arrow Down and the letter `c`, and expect `document.activeElement` to stay the textarea and the first blob's `aria-current` to stay put. Bug: a document-level tree shortcut.
- Companion sync. In the main window, `selectSession` on `session-claude-2` calls `setActiveSession` with `session-claude-2`. Remount with `?companion=1` and `getActiveSession` resolving to `session-claude-2`: the overview `.tool` text is `Hero follow-up`. Click the Codex pill: `setActiveSession` is called with Codex's latest owned id, not `session-claude-2`. Bug: the pill leaving the previous session selected, or the companion building a different title than `session.title`.

### Gate

From the repository root, after implementation:

```powershell
npm run typecheck
npm test
npm run build
```

Those scripts delegate to `apps/desktop` ([package.json](../package.json) lines 8–10). Do not run `cargo`. Do not point any command at the live inspection database. Passing these commands is not the native smoke test.

## 10. Native smoke additions

Run the Phase 3 checklist in [docs/PHASE_3_SPEC.md](PHASE_3_SPEC.md) section 9 first, on an isolated database, before treating Phase 4 as ready to smoke. Do not edit that section. Phase 4 adds the following steps in the same session, with the same `$env:BLOBLEX_DB_PATH` under `$env:TEMP`, the same refusal to open the live database or its `-wal` and `-shm` sidecars, and the same record in `SESSION_HANDOFF.md`. The isolation rules are Phase 3 steps 1–5 and the quit/relaunch rules are steps 12–14 of that section. This list does not replace Phase 7.

1. On the fresh smoke database, expand the default Claude blob. The face stays fully visible at the left of the row and the chevron sits at the right edge. Collapse it. The face does not shift between the two states.
2. Start two sessions for that blob in one folder, and a third session in a different folder, using the project "+" for the second session in the first folder and "Choose folder..." for the other folder. The tree shows one project with two sessions and a second project. The session that is on screen has the selected background. The header `<select>` shows the same session.
3. If two folders used in step 2 share a folder name, the project labels differ by a parent segment. If they do not, skip this step and rely on the collision unit test. Do not rename a folder on disk to force the case.
4. Collapse one project, leave the blob expanded, and quit from the header menu. Start `npm run desktop:dev` again with the same `BLOBLEX_DB_PATH`. The blob is expanded and that project is collapsed. The other project keeps the state it had at quit.
5. Arrow Right on a collapsed blob expands it. Arrow Down moves to a project. Enter on a session selects it. Shift+F10 on that session opens a menu that contains Resume conversation and Cancel turn. Escape returns focus to the session row.
6. A fresh smoke database has no "Other sessions" row. Legacy null-`agentId` placement is covered by the unit tests. Do not hand-edit the smoke database to insert one.
7. Change the companion's blob with a pill. The companion name and the chat follow that blob's latest session. Select a non-latest session in the main window's tree. The companion overview title becomes that session's title.
8. Record pass or fail per step, the temp database path, and `git rev-parse HEAD`, in `SESSION_HANDOFF.md`. Delete the temp database only after that note exists.

## 11. Risks, open questions, and out of scope

Risks:

- Case-folding merges two real directories that differ only by case. The product is Windows, and the alternative is duplicate rows for `C:/Work` and `c:\work` that the daemon treats as one directory check.
- `C:\work\site\..\site` stays a separate project because the daemon did not canonicalise the stored string. A user can see two rows for what Explorer shows as one folder. Sending the stored string still passes the daemon's directory check when that path exists.
- `aria-owns` pointing at a missing id breaks the screen-reader tree. The group element and the attribute appear and disappear together.
- Moving `selectAgent` above the companion return is a behaviour-preserving move only when the function body stays the latest-session selection. Folding `selectSession` into it would make a blob click keep an older session.
- The header "Session" tests click straight through to `session.new` today. Leaving them unchanged fails the gate once the chooser exists.
- A document-level key listener would steal Arrow Down from the composer. The handler belongs on the tree.
- Show-more state resets on reload. A blob with hundreds of sessions needs another Enter after each launch. That is the cap, not a virtualiser.
- `App.tsx` is already large. `SessionTree` and `ProjectChooser` exist so the tree does not land as more inline JSX.
- Search `forceOpen` written into `localStorage` would leave every title hit expanded after the query is cleared.
- The face helper knows moods Phase 4 does not paint as dots (`rate_limited`, `sleeping`). Unknown session states stay muted with a `labelize` word, so a new daemon state cannot look like "completed".

Open questions for the Director: none that block Phase 4. The choices above are closed on purpose.

### Out of scope

- Any Rust, migration, IPC, or Tauri command change, including a projects table, path canonicalisation, and `setActiveAgent`.
- Phase 2b execution settings and Phase 5 analytics.
- Rebuilding `BlobSessions` as a tree, removing the header `<select>`, or resizing the sidebar.
- Restore of archived blobs, drag reorder, and drag-and-drop of a session onto another project.
- Assigning a legacy session to a blob, or showing archived agents' sessions under a living blob.
- A virtualisation dependency, Testing Library, or any new npm package.
- Per-blob remembered sessions beyond the single `selectedSessionId`.
- A "minutes ago" clock, a third tree level, and copied Claude Desktop or Multica layout, copy, or assets.
- The live inspection database.
