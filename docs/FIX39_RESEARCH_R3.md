# FIX39 research — lane R3

Owner feedback items **21–24** from `docs/FIX39_FEEDBACK.md` (18 October 2026, after beta.33).

Lane: OpenCode `deepseek-v4.1-flash` (high), research only. **No code and no existing file was changed**; the only file written is this report. No `git commit` was run. Nothing in Tailscale was reconfigured: only `tailscale version`, `tailscale status --json`, `tailscale serve status --json` and `tailscale serve --help` (all read-only) were run on this machine.

Evidence below comes from three places: the repository (`file:line`), the machine's real Tailscale CLI output, and the app's own persisted history in `%LOCALAPPDATA%\Bitbots\bloblex.db` (`app_events`, `settings`), read read-only. Items 21 and 22 are design questions; item 23 is a live, reproducible failure with a proven cause; item 24 is a layout gap.

---

## Item 21 — The Manager as orchestrator: projects and tags

### 1. What the owner sees
The Manager must **know the projects in the user's workspace**, and projects should be **taggable** so the Manager knows **which bots to use for which job**.

### 2. Evidence

**Projects exist and are already visible to the Manager, in a thin form.**
- Storage table: `crates/bloblex-storage/src/lib.rs:423-432` — `projects(id, name, path, description, sort_order, collapsed, created_at, updated_at)`. The row shape handed to the UI is built in `project_rows` at `crates/bloblex-storage/src/lib.rs:5281-5283` (`id, name, path, description, sortOrder, collapsed, createdAt, updatedAt`).
- Types: `apps/desktop/src/types.ts:185-191` (`Project` extends a loose `JsonRecord`, so extra fields travel through the snapshot, and `project.changed` events are merged at `apps/desktop/src/types.ts:491-499`).
- Manager tools: `crates/bloblex-daemon/src/team.rs:216-218` — only the Manager gets `list_projects` and `update_blob`; `crates/bloblex-daemon/src/proposals.rs:28-57` adds `propose_project`, `propose_bot`, `assign_task`, `project_status`.
- What the Manager actually reads back today: `crates/bloblex-daemon/src/team.rs:359-371` `list_projects` prints `name (id …) · path` plus the description; `list_blobs` (`team.rs:312-333`) prints each bot's `provider`, `project` **name**, busy/available and description; `project_status` (`proposals.rs:232-251`) prints a project's bots with their latest conversation title, state and time.
- The Manager is told to use them: `crates/bloblex-daemon/src/team.rs:147-150` ("You work across all projects (list them with `list_projects`)…").

**There is no tag concept for projects or bots.** `grep` finds `tags` only in memory records: `crates/bloblex-storage/src/lib.rs:578` (`memory_records.tags TEXT NOT NULL DEFAULT '[]'`), validated at `crates/bloblex-storage/src/lib.rs:952-…` (`memory_validate_tags`), read back at `lib.rs:908-916`. `project_update` accepts only `name`, `path`, `description`, `collapsed`, `sortOrder` (`crates/bloblex-storage/src/lib.rs:1712-1740`), and `agent_set_team`/`agent_update` carry no tag field (`agents` columns verified in the live DB: `id, name, …, role, leader, hidden, look, notification_level, system_role`).

**On this machine the owner has exactly one project** (`71a0255c…`, "crewspan", `C:\Users\Sico Vibes\Desktop\DevCN\crewspan`, empty description) — so "the Manager must know the projects" is a small data set today, and the real gap is the **routing vocabulary** (tags), not discovery of the list.

**There is no "scan my workspace for projects" feature.** A project is created by the owner picking a folder (`apps/desktop/src/ui/App.tsx:2168-2175`) or by the Manager proposing one with `folder.mode: "new" | "existing"` (`proposals.rs:30-38`), approved by the owner in `apps/desktop/src/ui/ProposalCard.tsx:93-114`.

### 3. Causes
1. **No tag vocabulary anywhere** (projects or bots) — the Manager can see project *names* and bot *roles/descriptions*, which is all the routing signal that exists today (`team.rs:312-333`, `team.rs:359-371`).
2. **The Manager's project knowledge is a tool call away, not present at the start of a turn.** `runtime_instructions` (`team.rs:128-168`) names the project the *bot itself* belongs to and tells the Manager to call `list_projects`; the project index with its purpose is not in the prompt.
3. **A project's "purpose" is a single free-text `description`** (`lib.rs:1726-1729`, ≤255 chars) — not structured enough to answer "which bot for this job", and the Manager cannot read it per-tag.
4. **The Manager cannot edit a project at all.** `proposals.rs` can create one (via approval) and `update_blob` can change bots (`team.rs:375-396`), but no tool changes an existing project's description or tags, so a tag set could not be maintained by the Manager.

### 4. Proposed design

**Tags on both sides, owner-editable, Manager-readable.**
- **Storage** (`crates/bloblex-storage/src/lib.rs`): add `tags TEXT NOT NULL DEFAULT '[]'` to `projects` (next to the `CREATE TABLE` at `:423-432`, using the existing `ALTER TABLE … ADD COLUMN` loop pattern at `:433-…`) and the same column on `agents`. Add `project_rows`/`agent_read` JSON fields (`:5281-5283`, `agent_read`), accept `tags` in `project_update` (`:1712-1740`) with a shared validator modelled on `memory_validate_tags` (`:952`): array of strings, trimmed, lowercased, each ≤24 chars, ≤8 per item, de-duplicated, `[]` clears. `agents.tags` follows `agent_set_team`/`agent_update`.
- **Daemon tools** (`crates/bloblex-daemon/src/team.rs`): `list_projects` prints `name (id) · path · tags: a, b`; `list_blobs` appends `tags: …`; `project_status` prints the project's tags on its first line. New Manager-only `update_project` tool (allow `description`, `tags` only), registered in `team.rs:216-225` and dispatched at `team.rs:269-283` with the same Manager gate as `update_blob` (`team.rs:375-396`) — direct, not a proposal, because it matches `update_blob`'s existing precedent and is reversible; if the owner prefers approval for every Manager write, route it through `proposals::tool_schemas()` instead.
- **Manager instructions** (`team.rs:147-150`): one added line — "Projects carry tags; bots carry tags too. `list_projects` and `list_blobs` show them. Match the job's project tags to the bot's tags, and ask the owner when nothing fits." Keep it to one line so the instruction block stays cheap; do **not** inline the whole project index (it changes what the provider sees on every turn, and the tools already answer it in one call).
- **UI**: the project right-click menu in `apps/desktop/src/ui/TeamSidebar.tsx:176-182` gains **"Tags…"**, opening a small tag editor (chips + an input, suggestions drawn from tags already in use). Chips render in the sidebar project row in tertiary text (`ui/team.css`, tokens only, per `DESIGN.md` "say each thing once" and "monochrome chrome"); the same chips appear in the project's bot rows only inside the tag editor, not repeated on every row. No new icon shapes; reuse `Tag`/`Plus` from lucide (no star or sparkle anywhere).
- **Tests**
  - Storage unit test (Rust): tags round-trip, validation rejects a non-array/oversized/duplicate tag, `[]` clears, `project.changed` still carries the project.
  - Daemon tool test (Rust, in `main.rs`'s `mod … tests` beside the existing `boss-main` tests around `crates/bloblex-daemon/src/main.rs:9138-9303`): `list_projects` shows tags; a non-Manager calling `update_project` gets `non_manager_error`.
  - Mounted UI test: `apps/desktop/src/ui/TeamSidebar.*.mounted.test.tsx` (new file, pattern from `TeamSidebar.keyboard.mounted.test.tsx`) — chips render, menu opens the editor, saving calls `project.update` with `tags`.

**Files:** `crates/bloblex-storage/src/lib.rs`, `crates/bloblex-daemon/src/team.rs`, `crates/bloblex-daemon/src/proposals.rs` (only if the proposal route is chosen), `apps/desktop/src/types.ts` (`Project.tags`), `apps/desktop/src/ui/TeamSidebar.tsx`, `apps/desktop/src/ui/App.tsx` (`projectAction` wiring at `:2100-2141`), `apps/desktop/src/ui/team.css`, one new mounted test.

### 5. Size
**M** (schema + one tool + one dialog + tests). No dependency on other items. Touches `TeamSidebar.tsx`, which item 12 (model under the bot's name, another lane) also touches — the two can run in parallel if item 12's owner keeps to its own row-rendering branch.

### 6. Questions for the owner
1. **Tags on projects only, or on projects *and* bots?** Recommended: **both** — a project tag answers "what kind of work", a bot tag answers "what it is good at", and routing needs both sides.
2. **May the Manager set tags itself (directly), or only by proposing them for your approval?** Recommended: **directly** for tags and the description, matching `update_blob` today.

---

## Item 22 — An MCP that lets bots or the Manager control Bitbots

### 1. What the owner sees
"Can bots or the Manager control Bitbots itself through an MCP, the way T3 Code does? The owner wants to know whether this is possible."

### 2. Evidence

**Short answer: half of it exists already; the other half is new but clearly feasible. Details below.**

**(a) Bots and the Manager already get an MCP server — but it is private to them and stdio-only.**
- The daemon exposes `bitbotsd mcp-bridge` (`crates/bloblex-daemon/src/main.rs:4069-4072`), a newline-delimited JSON-RPC MCP server over **stdio**, protocol `2025-06-18` (`crates/bloblex-daemon/src/mcp_bridge.rs:1-49`).
- The daemon *is* the MCP client's transport: `team::attach` injects the spec into the provider's exec options (`crates/bloblex-daemon/src/team.rs:171-189`) with `BLOBLEX_DAEMON_ADDR` and a **per-session token** (`team.rs:41-54`).
- Authorisation path: the loopback API accepts any `mcp.*` method authorised by that team token instead of the daemon capability — `crates/bloblex-daemon/src/main.rs:359-368`, against the normal capability check at `main.rs:335-346` and `:370-379`. That is already a **scoped second auth path**, the exact shape an outside MCP client would need.
- Tools exposed today (`crates/bloblex-daemon/src/team.rs:196-231`, dispatch `:261-305`): every bot gets `list_blobs`, `list_conversations`, `message_blob`, `schedule_task`, `list_my_schedules`, `ask_user`, memory tools (when enabled) and the skills tools; the **Manager only** additionally gets `list_projects`, `update_blob`, `propose_project`, `propose_bot`, `assign_task`, `project_status` (`proposals.rs:28-57`) and the knowledge tools `remember_about_user`/`forget_about_user`/`recall_about_user`/`update_playbook` (`crates/bloblex-daemon/src/knowledge.rs:162-180`).
- So a bot **can** already: message teammates, open and continue side conversations, schedule a task (created disabled, awaiting owner approval), propose a project/bot/task, and read/write its own memory. It **cannot**: touch settings, other bots' runtime or permission mode, automations, files, sessions it does not own, or Remote. That "cannot" list is deliberate — `proposals.rs` exists precisely so consequential Manager actions need the owner's card (`team.rs:149-150`).

**(b) There is no MCP endpoint an outside agent could connect to.**
- The daemon's HTTP surface is loopback + capability only (`main.rs:347-379`); the capability is printed on stdout to the Tauri parent (`main.rs:4042-4050`) and is never written to disk, by design.
- The remote gateway is the only other HTTP surface: an axum router with `/api/ping` open and `/api/pair|login|me|rpc|events|logout` behind an Origin check (`crates/bloblex-daemon/src/remote/web.rs:81-100`, `:105-135`), reachable only over Tailscale `serve` (loopback bind) or Native TLS (`crates/bloblex-daemon/src/remote/mod.rs:737-819`, `crates/bloblex-daemon/src/remote/native.rs:515-529`). There is no `/mcp` route.
- The policy backbone for such a route already exists: `apps/desktop/src/remote/tiers.json` classifies **118 methods** (plus 50 events, an 8-entry settings allowlist and a sensitive-key pattern), and a parity test fails the build when a method has no row (`apps/desktop/src/remote/remoteTiers.parity.test.ts`).

**(c) What T3 Code actually does** (`https://github.com/pingdotgg/t3code`, `docs/user/outside-agents.md`): it runs a **remote MCP server over HTTP at `https://<environment>/mcp`**. Outside agents (Claude Code, Codex, ChatGPT, any MCP client) add that URL, sign in once through an OAuth flow whose approval happens on the host with a pairing code, and the owner chooses what the agent may do: **Read only** (default) → **Supervised** → **Full access**. The agent can "read projects and threads, start and message threads, and check which providers and models are available". Approved clients are listed in **Settings → Connections** and can be revoked; a sign-in lasts 30 days. That is the model the owner is pointing at, and it maps almost one-to-one onto machinery Bitbots already has (pairing code + owner approval + tiered policy + hashed tokens + activity log).

### 3. Causes
There is no bug here; the gap is a missing feature. Three concrete gaps:
1. **Transport:** MCP exists only over stdio, launched *by* Bitbots, so no outside agent can ever reach it.
2. **Identity:** the only tokens are per-session (created by the daemon) and per-device (created by pairing with a cookie). There is no owner-created, revocable "MCP client" credential, and no OAuth surface for hosted agents like ChatGPT.
3. **Policy:** `tiers.json` covers the *remote app's* verbs; there is no per-client access level, no tool-level exposure list, and no parity test for an MCP tool surface (the `mcp.*` path today is gated only by "is this token for a session").

### 4. Proposed design

**Feasibility: yes.** Two phases, both reusing existing seams.

**Phase 1 — a local MCP endpoint (M).**
- **Route:** mount `/api/mcp` on the existing gateway router (`crates/bloblex-daemon/src/remote/web.rs:81-100`) as a streamable-HTTP JSON-RPC endpoint (MCP `2025-06-18`, the same protocol id `mcp_bridge.rs:13` already uses). It reuses the router's `require_origin`/`security_headers`/`abuse_limit` layers unchanged, and it calls `remote::rpc`/`dispatch` **in-process**, exactly as the gateway does today ("it never reads, accepts or exposes the capability").
- **Identity:** a new **"MCP client"** credential, minted in Settings → Remote as a **pairing-style code** the connecting agent's owner approves on the desktop, choosing the access level. Token = 256 bits, stored as SHA-256 (`remote_devices` already stores only a hash; reuse the pattern in `crates/bloblex-daemon/src/remote/pairing.rs`), shown once, revocable, idle-expiring, with a content-free activity line (reuse `remote_activity`).
- **Tools (phase 1, all read-only by default):** `list_projects`, `project_status`, `list_blobs`, `list_conversations`, `get_conversation`, `list_automations`, `daemon_health`. With the *supervised* level only: `start_conversation`, `send_message`, `stop_turn`, `answer_permission_request` (only when the device tier allows approvals, mirroring the gate in `apps/desktop/src/remote/RemoteApp.tsx:292-293`). Consequential verbs stay out of phase 1 entirely.
- **Policy:** extend `apps/desktop/src/remote/tiers.json` with a `mcp` field per method (`"none" | "read" | "supervised" | "full"`), extend `remoteTiers.parity.test.ts` so every new MCP tool needs a row, and add a new `apps/desktop/src/remote/mcp.ts` (tool schemas + access-level resolution) with its own unit test.

**Phase 2 — hosted agents over OAuth (L).**
RFC 9728 protected-resource metadata plus dynamic client registration and PKCE on the same route, so ChatGPT/Cursor/Claude can connect by URL, with the approval screen reusing the pairing UI (owner picks the access level; `RemoteSettings.tsx:190-201` is the visual precedent). TLS only (Tailscale or Native), never plain HTTP.

**Safety model — required, in this order of importance.**
1. **Off by default, separately from Remote.** A new `remote.mcp.*` setting family; the endpoint does not exist (404) while it is off. All `remote.*` methods stay `never` remote.
2. **The capability is never exposed.** The MCP server runs inside the daemon and calls `dispatch()` in-process; no token file, no capability in any response or log.
3. **One policy, one table.** Every MCP tool maps to a `tiers.json` row; the parity test fails the build otherwise. Unknown method ⇒ refused.
4. **Read-only is the default.** Writes require an explicit access level chosen by the owner at approval time, per client.
5. **Consequential actions remain proposals**, even at "full": creating/deleting projects and bots, scheduling, memory writes and playbook edits still produce an approval card (`proposals.rs`, `knowledge.rs`), and a client that starts a conversation cannot make that conversation run with more permissions than the mode the owner set.
6. **Always refused over MCP:** `settings.set`, every `remote.*`, agent create/update/delete, runtime profile changes, runtime refresh, file revert, automation writes, memory writes directly, daemon shutdown and every native Tauri command — the existing "never remote" list, extended to MCP.
7. **Credentials:** hashed at rest, shown once, revocable in Settings, idle expiry, one token per client, never logged.
8. **Abuse limits:** per-client and per-IP rate limits, lockout after repeated failures and a global pause (reuse the gateway's limiter at `crates/bloblex-daemon/src/remote/mod.rs:428-…`).
9. **Content stays private:** no message text, project paths or prompt bodies in logs, activity lines or error payloads; results are redacted/allowlisted before they leave, as the gateway already does.
10. **Prompt-injection is the real risk and must be said out loud:** an outside agent that can send messages can cause bots to run commands on this machine. That is why "supervised"/"full" needs a conspicuous consent screen, why bots' own permission mode is never raised by MCP, and why approvals can stay desktop-only by default.
11. Origin/Host checks and TLS-only transport, as the gateway already enforces (`web.rs:105-135`).

**Tests**
- Rust unit: token mint/verify/revoke/expiry; the access-level resolver; policy refusals for a read-only client; `mcp.*` over the gateway route (extend `crates/bloblex-daemon/src/remote/tests.rs`); a negative test that a non-loopback, non-TLS request is refused.
- TypeScript: `remoteTiers.parity.test.ts` (new rows), `mcp.test.ts` (schemas + access levels), `RemoteSettings` mounted test for the clients list/approval card.
- End-to-end (manual, documented): `claude mcp add --transport http bitbots https://<host>/api/mcp` and `codex mcp add bitbots --url …` against a real host, plus a scripted JSON-RPC session for a negative case.

**Files (indicative):** `crates/bloblex-daemon/src/remote/web.rs`, `crates/bloblex-daemon/src/remote/mod.rs`, a new `crates/bloblex-daemon/src/remote/mcp.rs`, `crates/bloblex-daemon/src/remote/pairing.rs` (client credentials), `apps/desktop/src/remote/tiers.json`, new `apps/desktop/src/remote/mcp.ts`, `apps/desktop/src/ui/RemoteSettings.tsx`, `apps/desktop/src/remote/remoteContract.ts`.

### 5. Size
**Phase 1: M. Phase 2: L.** Depends on nothing shipped by another FIX39 item, but it edits `crates/bloblex-daemon/src/remote/*` and `RemoteSettings.tsx`, the same files item 23 touches — sequence those two, or keep item 23's changes inside `tailscale.rs` + `useRemote.ts`.

### 6. Questions for the owner
1. **Is phase 1 enough for now (agents on this machine or on your tailnet: Claude Code, Codex, Cursor, OpenCode), with ChatGPT-over-the-internet deferred to phase 2 OAuth?** Recommended: **yes**.
2. **Three access levels — Read only, Supervised, Full — with consequential actions still approved by you at every level?** Recommended: **yes** (that is T3's model plus Bitbots' proposal rule).
3. **Should the Manager itself get more control through this same policy (for example start/stop conversations, read a project's files), or stay with today's tools?** Recommended: **let the Manager use the phase-1 read tools plus `start_conversation`/`send_message`, all audited, and keep everything consequential as a proposal.**

---

## Item 23 — Tailscale will not turn on ("That did not work. Try again.")

### 1. What the owner sees
"Allow remote devices" with the Tailscale method answers **"That did not work. Try again."** The Direct (Native) method works.

### 2. Evidence

**The real error is recorded, and it is not a Tailscale problem.** From the app's own event log (`%LOCALAPPDATA%\Bitbots\bloblex.db`, `app_events`, `remote.changed`, read read-only):

```
2026-10-18T09:45:29.278Z  method=tailscale  link=error  "Tailscale is not connected. Open Tailscale and sign in."
2026-10-18T09:49:11.483Z  method=tailscale  link=online
2026-10-18T09:50:53.340Z  method=tailscale  link=off    "The installed Tailscale CLI does not document turning one serve handler off, …"   (older build)
2026-10-18T11:03:35.062Z  method=tailscale  link=error  "Port 48620 is already in use on this computer."
2026-10-18T11:43:13.205Z  method=tailscale  link=error  "Port 48620 is already in use on this computer."
2026-10-18T11:43:24.770Z  method=tailscale  link=error  "Port 48620 is already in use on this computer."
2026-10-18T11:43:25.286Z  method=native     link=error  (none)
2026-10-18T11:43:27.999Z  method=native     link=online
```

That message is produced at `crates/bloblex-daemon/src/remote/mod.rs:771-778` — the gateway's own loopback bind, *before* any `tailscale serve` call (the serve call is at `:787-803`).

**Who holds the port right now (proven on this machine).** `netstat -ano` + `Get-CimInstance Win32_Process`:

```
TCP  127.0.0.1:48620  LISTENING  18900   bitbotsd-6400-1acef00f….exe     (parent 6400 — no longer exists)
TCP  0.0.0.0:48621    LISTENING  11292   bitbotsd-14208-e2d3f7b4….exe    (parent Bitbots.exe 14208, the live app)
TCP  127.0.0.1:62812  LISTENING  18900   (that orphan's own API)
TCP  127.0.0.1:61799  LISTENING  11292   (the live daemon's API)
```

So an **orphaned daemon** from an earlier run of the app is still listening on the Tailscale gateway port. Its two `mcp-bridge` children (pids 14080, 18356) are alive too. Nothing in the daemon watches its parent, and there is no single-instance guard on the app:

- the daemon child is spawned and killed only on graceful exit — `apps/desktop/src-tauri/src/lib.rs:1711-1729` (`stop_daemon`, called from `RunEvent::Exit` at `:2538-2548` and from `Drop for AppState` at `:1737-1741`);
- no Job Object, no parent-pid watchdog, no `kill_on_drop` for the daemon itself (the only `kill_on_drop` in the codebase is for adapter children, `crates/bloblex-daemon/src/main.rs:1870`);
- no `tauri-plugin-single-instance` in `apps/desktop/src-tauri/Cargo.toml:21-28`, so a second launch makes a second daemon.

**The orphan is the thing the tailnet is currently serving.** Real CLI output on this machine (`tailscale version` → `1.104.1`):

```jsonc
// tailscale serve status --json
{ "TCP": { "443": { "HTTPS": true } },
  "Web": { "desktop-puf7ihb.tail64dae5.ts.net:443":
             { "Handlers": { "/": { "Proxy": "http://127.0.0.1:48620" } } } } }
```

The stored settings agree (`remote.servePort = 443`, `remote.enabled = true`, `remote.method = "native"`), so that handler was made by Bitbots and now points at the **orphan**. A phone that opens `https://desktop-puf7ihb.tail64dae5.ts.net` today reaches a daemon whose UI no longer exists — while `apps/desktop/src/remote/web.rs` and the pair-approval screen live in the *other* process. Both daemons resolve the same `bloblex.db`, so they are also writing one SQLite file.

**Tailscale itself is fine.** `tailscale status --json` → `"BackendState": "Running"`, `"CertDomains": ["desktop-puf7ihb.tail64dae5.ts.net"]`, `Health: []`, `CurrentTailnet.MagicDNSEnabled: true`; `tailscale serve status --json` exits 0 in 0.07 s and `tailscale status --json` in 0.12 s (so the 5 s `CLI_TIMEOUT` at `crates/bloblex-daemon/src/remote/tailscale.rs:25` is not the issue on this machine). Note the top level has **no `DNSName`** in 1.104.1 (only `Self.DNSName`) — the parser already handles that fallback at `tailscale.rs:344-346`, and `CertDomains` at the top level is read at `:347-352`. `parse_status_json`/`evaluate` therefore classify this machine as **Ready**, which is why the UI let the owner press the switch.

**The message the owner saw is the UI's fallback, not the daemon's text.** `apps/desktop/src/remote/useRemote.ts:141-145`:

```ts
} catch (reason) {
  const message = reason && typeof reason === 'object' && 'message' in reason ? String(…) : 'That did not work. Try again.'
```

`rpc()` calls Tauri's `invoke` (`apps/desktop/src/tauri.ts:21-24`), which rejects with the Rust `String` from `daemon_rpc` → `rpc_call` (`apps/desktop/src-tauri/src/lib.rs:462-476`, `:357-397`, which formats `"{code}: {message}"`). A string is not an object with `message`, so **the specific message is thrown away and the generic one is shown**. The same fallback pattern exists in `apps/desktop/src/ui/ManagerPage.tsx:99`, `apps/desktop/src/ui/MemoryPage.tsx:77` and `apps/desktop/src/ui/SchedulesView.tsx:129`.

**Two secondary causes visible in the log.**
- `tailscale.rs:264-269` maps **any** non-zero `tailscale status --json` to `logged_out` with "Tailscale is not running or is signed out. Open Tailscale and sign in." (`:270-277` does the same for unparseable output). That is what the 09:45 event says while the CLI was merely not up yet (Tailscale was online by 09:49). A `BackendState` of `Starting`/`Stopped`/`NeedsLogin`, a stopped `tailscaled`, or a pipe/permission failure all produce the same wrong instruction. The state enum has no "starting" (`tailscale.rs:160-182`) even though the UI's fix table is keyed on exactly these wire strings (`apps/desktop/src/ui/RemoteSettings.tsx:23-31`, `:137`; type at `apps/desktop/src/remote/remoteContract.ts:35`).
- A stale serve handler survives from builds that gated removal on `serve --help` text (the 09:50 event). The current code removes it directly (`tailscale.rs:449-457`, `mod.rs:836-849`) — verified against the real 1.104.1 help, whose USAGE lists only `status`, `reset`, `drain`, `clear`, `advertise`, `get-config`, `set-config` (no `off`), exactly as the comment at `tailscale.rs:452-454` says. Nothing removes the *orphan's* handler, so the tailnet keeps pointing at a dead UI.

### 3. Causes
1. **Fixed loopback port with no fallback or ownership check.** `DEFAULT_REMOTE_PORT = 48620` (`crates/bloblex-daemon/src/remote/mod.rs:37`, resolved by `remote_port` at `:631-638`) is bound directly (`:771-779`). Any other listener — an orphaned daemon, a second launch of Bitbots, an unrelated app — makes Tailscale enable fail with "Port 48620 is already in use on this computer." Native uses 48621 (`crates/bloblex-daemon/src/remote/native.rs:40-41`), which is why **Direct works**.
2. **The daemon outlives the app.** No parent watchdog, no Job Object, no single-instance guard (`lib.rs:1711-1741`, `:2538-2548`; `Cargo.toml:21-28`). One hard exit (crash, Task Manager, the updater replacing `Bitbots.exe`) leaves a daemon holding 48620 forever, plus its serve handler.
3. **The daemon's error text is discarded by the UI.** `useRemote.ts:141-145` + a String rejection from `daemon_rpc` (`lib.rs:462-476`).
4. **Status states are too coarse to explain the real situation**: any non-zero CLI answer becomes "signed out" (`tailscale.rs:264-277`), and a bind conflict does not set the `port_in_use` state the UI already has copy for (`RemoteSettings.tsx:27`); `evaluate` only ever sets `port_in_use` when 443 *and* 8443 are taken by someone else (`tailscale.rs:289-318`, `:321-329`).
5. **Two daemons share one database and one tailnet address.** `start_daemon` gives each daemon a private copy of the exe but no data-dir argument (`lib.rs:245-259`), so both resolve `%LOCALAPPDATA%\Bitbots\bloblex.db`; the survivor keeps serving the tailnet (`serve status --json` above). This is also a plausible contributor to cross-item symptoms such as item 20's lost context, and should be checked by that lane.

### 4. Proposed design

**Fix the message first (S, one file).** In `apps/desktop/src/remote/useRemote.ts:141-145` use the existing helper `rpcFailure(reason)` (`apps/desktop/src/executionContract.ts:103-108`), which already accepts a plain string and strips the leading `code: ` — `setState(… error: rpcFailure(reason).message)`. Sweep `ManagerPage.tsx:99`, `MemoryPage.tsx:77`, `SchedulesView.tsx:129` the same way in the same package. Test: extend `apps/desktop/src/remote/useRemote.test.tsx` (it already throws plain `Error`s at `:142`) with a string rejection asserting the exact daemon text reaches `state.error`.

**Then remove the conflict (M).**
- **Ownership probe instead of a blind bind** (`mod.rs:771-779`): before enabling, probe `http://127.0.0.1:<remote_port>/api/ping`. The route is already open and answers `{"ok":true}` (`web.rs:83`, `:565-…`); strengthen it to include an app marker rather than user data (for example `{"ok":true,"app":"bitbots","role":"remote-gateway"}`). If a **Bitbots gateway** answers and we are not the listener, do not enable: report `conflict` with an actionable message — *"Another copy of Bitbots is already serving Remote on this computer. Quit the other copy (or restart Bitbots), then try again."* — and set the status `tailscale` to `port_in_use` so the existing fix card renders (`RemoteSettings.tsx:23-31`, `:152-156`).
- **Fall back to the next free port** if the default is busy for any other reason: try 48620, then 48621…48629 (skipping whatever Native uses), else an OS-assigned port. The serve target already uses the *bound* port (`mod.rs:780-787` uses `addr.port()`), so only the bind step and the status/URL reporting need the change; persist the chosen value in `remote.port` as today (`:816`) so the next run is stable. Recommendation: fall back **and** report which port was used in the status block (`RemoteSettings.tsx:163-172`).
- **Stop leaking daemons** (`apps/desktop/src-tauri/src/lib.rs:213-346`): create the child in a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (so a hard exit of Bitbots also kills the daemon), and/or add a parent-liveness watchdog in the daemon (`main.rs::run`, beside the ready line at `:4042-4050`) that exits when its parent pid changes/repeats. Add a single-instance guard (`tauri-plugin-single-instance`) so a second launch focuses the running app instead of starting a second daemon and a second writer to `bloblex.db`.
- **Recover gracefully at boot**: `remote::start_at_boot` (`mod.rs:686-701`) currently calls `enable` and turns any error into a status line; add the ownership probe there too, so the owner sees the real reason on the Remote page without pressing anything.
- **Refine the Tailscale states** (`tailscale.rs:160-182`, `:264-286`): add `starting` (BackendState `Starting`/`NoState`) and `not_running` (CLI reports it cannot reach `tailscaled` — read `stderr` of `status --json`), keep `logged_out` for `NeedsLogin`/auth URL, and add the matching rows to `TAILSCALE_FIX` (`RemoteSettings.tsx:23-31`) and to `RemoteTailscaleState` (`remoteContract.ts:35`). Also consider raising `CLI_TIMEOUT` (`tailscale.rs:25`) to ~10 s for the *first* call after boot; 0.1 s is typical here, but a cold `tailscaled` is the one case where 5 s is tight.

**Tests**
- Rust: `crates/bloblex-daemon/src/remote/tailscale.rs` `mod tests` (`:485-…`) — `status --json` with `BackendState: "Starting"` ⇒ `starting`; stderr "failed to connect to local tailscaled" ⇒ `not_running`; `serve status --json` with our target on 443 ⇒ still Ready. `crates/bloblex-daemon/src/remote/tests.rs` — a port already held ⇒ the conflict message and `port_in_use`; fallback port chosen ⇒ the serve argv carries the bound port (the existing `FakeCli` in `tailscale.rs:491-545` records argv for exactly this assertion).
- TypeScript: `useRemote.test.tsx` (message passthrough, string rejection), `RemoteSettings` mounted test (fix card for `port_in_use`, toggle disabled while a fix is showing), and `apps/desktop/src/preview/remoteFixture.ts:673` if the preview must model the new states (`remoteFixture.test.ts:74-75` covers the unsupported path).
- End-to-end on this machine: with the orphan still present, the page must say *"Another copy of Bitbots…"* instead of the generic line; after killing the orphan (or with the Job Object in place), enabling Tailscale must go `starting → online` and the serve handler must point at the *live* daemon.

### 5. Size
**Message fix: S. Port ownership + fallback + fix card: M. Daemon lifetime/single-instance: M (native, separately testable).** No dependency on other items; overlaps item 22's files in `crates/bloblex-daemon/src/remote/` and `RemoteSettings.tsx`.

### 6. Questions for the owner
1. **If port 48620 is taken by something else, may Bitbots pick the next free port automatically (and show which one), or should it always refuse?** Recommended: **pick the next free port**, but always refuse-and-explain when the other listener is *another copy of Bitbots*.
2. **May Bitbots kill a leftover daemon it finds at startup (identified by the `/api/ping` marker)?** Recommended: **no, not automatically** — a second copy may be another install or a dev build; report it and offer "Quit the other copy" instructions. (The Job Object fix prevents this from happening in the first place.)

---

## Item 24 — Browser layout versus phone layout for the Remote web app

### 1. What the owner sees
"Opening the Remote link in a desktop browser shows the phone app layout. There should be a browser (desktop-width) layout and a mobile app layout, chosen by where it is opened."

### 2. Evidence
- The shell is deliberately phone-shaped and *stays* phone-shaped on wide screens: `apps/desktop/src/remote/remote.css:8-16` — `.rm-stage` centres a single `.rm-phone`; `@media (min-width: 640px)` pins it to `width: 390px; height: min(800px, …); border-radius: 36px` on a dark backdrop. The file's own header says it: "on a desktop browser the app sits in a phone-sized frame" (`remote.css:1-2`).
- The UI is one column plus a two-tab bottom bar (`apps/desktop/src/remote/RemoteApp.tsx:264-305`; `.rm-tabs` at `remote.css:36-39`), with the bot list, chat and "This device" as separate screens (`RemoteApp.tsx:291-299`). Nothing reads the viewport width or the pointer type.
- The client already knows what it is — but only for the *owner's approval card*: `describeThisDevice(userAgent)` returns `phone | tablet | browser | computer` plus a platform string (`apps/desktop/src/remote/deviceApi.ts:26-32`), sent at pairing and shown by `RemoteSettings.tsx:80-85`. The daemon only whitelists the four kinds (`crates/bloblex-daemon/src/remote/pairing.rs:407-…`); it is not used for layout.
- Width alone is not enough: a phone in landscape (≈800 px) and a desktop window dragged narrow both exist. The reliable pair is viewport width **and** pointer type (`(pointer: fine)`), with a manual override for the deliberate "handset preview" case.
- The service worker serves hashed built assets (`REMOTE_SW_URL = '/remote-sw.js'`, `apps/desktop/src/remote/serviceWorker.ts:10-17`), and `apps/desktop/src/remote/remoteBuild.test.ts` inspects the emitted `dist-remote`; a CSS/JS-only layout change needs no manifest or cache-version change, but the build test is where a regression would surface.

### 3. Causes
1. **The only breakpoint upgrades to a *phone frame*, never to a desktop layout** (`remote.css:13-16`).
2. **No layout mode and no user control**: `RemoteApp` renders one tree (`RemoteApp.tsx:264-305`) with no `wide`/`phone` concept and no toggle.
3. **No signal captured at connect time**: `kind` from `describeThisDevice` (`deviceApi.ts:26-32`) is stored on the device but never consulted by the client.
4. Minor: in the phone frame, popups that assume full height (`.rm-convos { max-height: 55dvh }`, `remote.css:145`) look wrong at 800 px inside a 390 px column; a wide layout must not inherit them.

### 4. Proposed design

**Two layouts, resolved automatically, overridable by hand.**
- **Resolution** (new `apps/desktop/src/remote/layout.ts`): `resolveLayout({ width, pointerFine, override })` → `'phone' | 'wide'`, with a `useRemoteLayout()` hook subscribing to `matchMedia('(min-width: 900px)')` and `matchMedia('(pointer: fine)')`. Rule: `wide` when the viewport is ≥900 px **and** the pointer is fine; otherwise `phone`. `override` is `'auto' | 'phone' | 'wide'`, persisted in `localStorage` under `bitbots.remote.layout`, exposed as a three-way `Select` on the "This device" screen (`RemoteApp.tsx:294`, `DeviceScreen`) so a desktop user can deliberately see the handset view (and a developer can check both without resizing).
- **Shell**: keep `.rm-stage`/`.rm-phone` untouched for the phone layout; add `data-layout="wide"` on the root (`RemoteApp.tsx:264-265`) and a `.rm-wide` grid in `remote.css`: left column ≈320 px with the host header, the searchable bot list and each bot's conversations (reusing `.rm-bot`/`.rm-convos` rows), right column the chat with its composer pinned at the bottom, and "This device" as a right-hand panel or the existing sheet. All tokens from `theme.css`; no new icon shapes (lucide only, no sparkle/star), consistent with `DESIGN.md` layout and "monochrome chrome" rules.
- **Behaviour stays one implementation**: the screens (`BotsScreen`, `ChatScreen`, `DeviceScreen`) are reused as-is; only their container changes, so no logic forks and the mounted tests keep covering one tree.
- **Do not sniff the user agent for layout.** `describeThisDevice` stays an approval-card label; width + pointer + the owner's override decide.
- **Accessibility**: tab order follows the visual order in both layouts; the tab bar is hidden in `wide` (screens are all visible) but the `aria-label` sections stay.

**Tests**
- `apps/desktop/src/remote/layout.test.ts` (new): the resolution table — 1440 + fine ⇒ `wide`; 1440 + coarse ⇒ `phone`; 700 + fine ⇒ `phone`; override wins in both directions.
- `apps/desktop/src/remote/RemoteApp.mounted.test.tsx`: with `matchMedia` mocked (precedent: `apps/desktop/src/blob/BlobCanvas.mounted.test.tsx:98`, `apps/desktop/src/ui/App.analytics.mounted.test.tsx:279`) assert the wide layout shows the bot list and the chat together with no tab bar, the phone layout keeps the tab bar, and the override flips it.
- `remoteBuild.test.ts` needs no change; run it to prove the build still emits the shell, worker, manifest and icons.
- Manual: one desktop browser window at ≥900 px, one phone-sized window, and one real phone on the tailnet.

### 5. Size
**M.** No dependency on other items. Files: `apps/desktop/src/remote/remote.css`, `apps/desktop/src/remote/RemoteApp.tsx`, new `apps/desktop/src/remote/layout.ts`, new tests. Shares `RemoteApp.tsx` with nothing else in FIX39 (item 4's bot shapes touch `BlobCanvas`, not this file).

### 6. Questions for the owner
1. **Breakpoint and rule: "wide when the window is ≥900 px and the pointer is a mouse"?** Recommended: **yes**, with the manual **Auto / Phone / Wide** override on the device screen.
2. **In the wide layout, should the device/protocol screen be a third column or a panel that slides over the chat?** Recommended: **a panel over the chat** — it keeps the chat readable and matches the existing sheet language.

---

## Cross-item notes for the Director

1. **A leftover daemon is live on this machine right now.** `bitbotsd-6400-…` (pid 18900, parent gone) holds `127.0.0.1:48620` and the Tailscale serve handler; the running app's daemon (pid 11292) holds `48621` (Native) and its own API port. Until it is gone, Tailscale Remote cannot be enabled on this machine and the tailnet address reaches a zombie UI. Two daemons also write one SQLite file, which the item 20 lane (context loss) should be told about.
2. **The swallowed daemon message is a general bug class**: `reason instanceof Error ? reason.message : fallback` appears in at least four places (`useRemote.ts:141`, `ManagerPage.tsx:99`, `MemoryPage.tsx:77`, `SchedulesView.tsx:129`). `rpcFailure` (`executionContract.ts:103`) is the existing correct helper.
3. **A stale `serve` handler was proven on this machine** (`443 → http://127.0.0.1:48620`, no `AllowFunnel` key). The current removal code is correct for 1.104.1 (`serve --https=<port> off`, verified against the real help output); the surviving handler is from an older build plus the orphan, not from a bug in today's code.

### Evidence commands (read-only)
```powershell
& "$env:ProgramFiles\Tailscale\tailscale.exe" version
& "$env:ProgramFiles\Tailscale\tailscale.exe" status --json
& "$env:ProgramFiles\Tailscale\tailscale.exe" serve status --json
& "$env:ProgramFiles\Tailscale\tailscale.exe" serve --help
netstat -ano | Select-String "4862"
Get-CimInstance Win32_Process -Filter "name like 'bitbots%'" | Select ProcessId,ParentProcessId,Name,CreationDate
# app_events: event_type like 'remote%' and settings keys starting 'remote.' in %LOCALAPPDATA%\Bitbots\bloblex.db (read-only)
```

---

## Implementation packages

Independent packages, grouped so that different lanes can run in parallel without editing the same file where possible.

1. **P1 — Remote errors and Tailscale states** (item 23, first half). Files: `apps/desktop/src/remote/useRemote.ts` (use `rpcFailure`), `apps/desktop/src/remote/remoteContract.ts` (`RemoteTailscaleState` + `starting`/`not_running`), `apps/desktop/src/ui/RemoteSettings.tsx` (`TAILSCALE_FIX` rows), `crates/bloblex-daemon/src/remote/tailscale.rs` (state mapping + stderr reading), `apps/desktop/src/remote/useRemote.test.tsx`. **S/M.**
2. **P2 — Remote port ownership and daemon lifetime** (item 23, second half). Files: `crates/bloblex-daemon/src/remote/mod.rs` (probe, fallback port, fix state), `crates/bloblex-daemon/src/remote/web.rs` (`/api/ping` marker), `crates/bloblex-daemon/src/remote/tests.rs`, `apps/desktop/src-tauri/src/lib.rs` (Job Object / parent watch, single-instance), `apps/desktop/src/preview/remoteFixture.ts` if the preview models it. Depends on P1 only for the new state names. **M.**
3. **P3 — Project and bot tags for the Manager** (item 21). Files: `crates/bloblex-storage/src/lib.rs`, `crates/bloblex-daemon/src/team.rs` (+ `proposals.rs` only if the approval route is chosen), `apps/desktop/src/types.ts`, `apps/desktop/src/ui/TeamSidebar.tsx`, `apps/desktop/src/ui/App.tsx`, `apps/desktop/src/ui/team.css`, one new mounted test. **M.**
4. **P4 — Remote wide layout** (item 24). Files: `apps/desktop/src/remote/remote.css`, `apps/desktop/src/remote/RemoteApp.tsx`, new `apps/desktop/src/remote/layout.ts` + tests. **M.**
5. **P5 — MCP control endpoint, phase 1** (item 22(a)). Files: new `crates/bloblex-daemon/src/remote/mcp.rs`, `crates/bloblex-daemon/src/remote/web.rs`, `crates/bloblex-daemon/src/remote/mod.rs`, `crates/bloblex-daemon/src/remote/pairing.rs`, `apps/desktop/src/remote/tiers.json`, new `apps/desktop/src/remote/mcp.ts`, `apps/desktop/src/remote/remoteTiers.parity.test.ts`, `apps/desktop/src/ui/RemoteSettings.tsx`. Sequence after P1/P2 (same remote files). **M.**
6. **P6 — MCP OAuth for hosted agents, phase 2** (item 22(b)). Files: as P5 plus the OAuth metadata/DCR handlers and the pairing-code approval screen. Depends on P5. **L.**
