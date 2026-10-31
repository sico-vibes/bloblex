# Brief: Phase 4, machines

Owner request, 31 October 2026: "Start Phase 4". Source: `docs/plans/expansion-plan-v3.md`, Phase 4. Windows only.

**Lanes and order.**
- **Round 1, at the same time.** Sona: sections 1 and 2 (machine identity, links, reading the other machine). Gogo: sections 3, 4 and 5 (repo identity, `.bitbots.json`, the handoff building blocks).
- **The Director** reviews and merges Round 1, then starts Round 2 from the merged result.
- **Round 2.** Sona: section 6 (the handoff itself).
- **The Director:** all front end, against this contract, in the main checkout.

Keep the contract exactly. If something can't work as written, pick the smallest change and say so in your report.

**Rule:** "omitted" and explicit `null` are the same unless an item says otherwise.

**What Phase 4 decides.**
- A machine link is one daemon acting as a paired device of another, through that machine's Remote gateway. The window never talks to the other machine. There's no new listener and no relay.
- A conversation on another machine is read-only here. The only action on it is **Take over**. Sending messages to another machine's bots isn't part of this phase.
- Only pulling exists: the machine that wants a conversation takes it. To move one, open it on the other machine and press Take over.
- Nothing on a link can grant Full access. A handoff never carries it, and neither does `.bitbots.json`.

**Already done, don't rebuild.** The channel switch (`apps/desktop/src-tauri/src/updates.rs`, setting `updates.channel`), the same installer and updater, template export and import (`backup.rs`, `include.agentIds`; schedules restore disabled, environment values never travel), the fresh-session recap (`knowledge::announce_context_loss`, `recap_for_prompt`).

**All new RPCs:** `tiers.json` class `never`, events `drop`, except where section 2 and section 6 say otherwise. None go on the Bitbots MCP.

**Every command** is an argument list with no shell, has a time limit, sets `GIT_TERMINAL_PROMPT=0`, uses git's own sign-in and never reads, passes or prints a credential. No message text, tokens, passwords, cookies or paths in logs.

## 1. Machine identity and links (Sona, new `machines.rs`, `machine_client.rs`)

**Identity.**
- Settings `machine.id` (a UUID made at first start) and `machine.name` (default: the host name, `remote/mod.rs` `host_name`). Refused by `exportable_setting`, so neither travels in a backup. `machine.name` is 1 to 60 characters and is only set through `machine.self.rename`.
- `machine.self {}` → `{id, name, version}`. `machine.self.rename {name}` → the same.
- `machine.info {}` → `{machineId, name, version, handoffVersion: 1}`. `tiers.json` class `read`, `minTier` `viewer`. This is what the other side asks for.

**Storage (new `crates/bloblex-storage/src/phase4.rs`).** Table `machine_links(id TEXT PRIMARY KEY, name, url, auth, fingerprint, tier, paired_at, last_seen_at, state, device_id)`. `id` is the other machine's `machine.id`.

**The token is never in the database.** It lives in `<data>/machines/<id>.token`, user-only through `native.rs`'s `apply_key_permissions` (make it `pub(crate)`). It's never returned, logged, exported, or put in a diagnostics bundle. Add tests for the backup and diagnostics.

**Client (`machine_client.rs`), one place for every call to another machine:**
- `https://` only. Refuse a URL with a user, password, query or fragment. Reduce to its origin.
- A preconfigured `rustls` client through `use_preconfigured_tls`. Add the reqwest rustls feature if needed. Never `danger_accept_invalid_certs`.
  - No pin stored: normal web PKI validation (Tailscale).
  - Pin stored: a custom `ServerCertVerifier` that compares the SHA-256 of the end-entity certificate with the pin, in constant time, and still verifies the handshake signatures. No host name check (Native).
- Redirects off. Response capped at 32 MiB. 10-second timeout, overridable per call.
- Every request sends `Origin: <origin>`, and the device cookie as `Cookie: __Host-bitbots_remote=<token>` (use the constant from `web.rs`).
- `client.rpc(machine_id, method, params)` sends the normal envelope to `POST /api/rpc`. `device_revoked` sets the link's state to `revoked`.

**`machine.probe {url}`** → `{origin, reachable, isBitbots, auth: "code"|"password", fingerprint, trusted}`.
- Calls `GET /api/ping` and sends no credential. To read an untrusted certificate, use a verifier that records the fingerprint and accepts for this one call only.
- `trusted` true means web PKI accepted it: `auth: "code"`, `fingerprint: null`. Otherwise `auth: "password"`, and the UI asks the owner to compare the fingerprint with the other machine's screen.
- `isBitbots` is `app == "bitbots" && role == "remote-gateway"`. False stops pairing.

**`machine.pair.begin {url, code, username, password, fingerprint, confirm}`** → `{job}`, returned at once. Job: `{id, url, state: "pending"|"approved"|"rejected"|"expired"|"failed"|"cancelled", detail, machine}`. Event `machine.pair.changed {job}`.
- No `confirm: true`: `invalid_argument`. `auth: "code"` needs `code`; `auth: "password"` needs `username`, `password` and the `fingerprint` the owner accepted. Re-probe first; if the certificate no longer matches the fingerprint, `failed` with "The other machine's certificate changed."
- `POST /api/pair {code, name, kind: "machine", platform: "windows"}` or `POST /api/login {username, password, name, kind: "machine", platform: "windows"}`. `name` is `machine.name`.
- The password is used for that one request and never kept or logged. The job never contains it.
- Keep the short-lived pair cookie, and poll `GET /api/pair` every 2 seconds for up to 5 minutes. On `approved`, read the device cookie from `Set-Cookie`, write the token file, call `machine.info`, and write the link with its `id`, `name` and `tier`. An older machine without `machine.info`: `failed`, "That machine needs a newer version of Bitbots."
- Pairing a machine with itself (`machine.info` returns our own id): call `/api/logout`, delete the token, `failed`, "That's this machine."
- A second pairing to a machine already linked replaces the old token.

**Gateway changes:** add `machine` to `pairing.rs` `kind_of`. Add `kind` to `DeviceAuth`. Pairing is otherwise unchanged, including the owner's approval and tier choice.

**`machine.pair.cancel {id}`**, **`machine.pair.list {}`** → `{jobs}`, in memory.

**`machine.list {}`** → `{machines: [{id, name, url, auth, fingerprint, tier, pairedAt, lastSeenAt, state: "online"|"offline"|"revoked", detail, version, bots}]}`. `bots` is section 2's list.

**`machine.rename {id, name}`:** a local label only. **`machine.remove {id, confirm}`:** best-effort `POST /api/logout`, delete the token and the row. Removal succeeds when the other machine can't be reached. Reply `{removed, signedOut}`.

**Tests:** `machine_id_is_made_once_and_stays`, `machine_settings_never_travel_in_a_backup`, `a_token_is_never_returned_logged_or_exported`, `the_client_refuses_http_and_credentials_in_the_url`, `a_pinned_client_refuses_another_certificate`, `a_pinned_client_accepts_its_certificate`, `redirects_are_not_followed`, `probe_sends_no_credential`, `pairing_by_code_stores_the_link` (against a real gateway on loopback, with a test certificate), `pairing_by_password_never_keeps_the_password`, `a_rejected_pairing_stores_nothing`, `a_machine_cannot_pair_with_itself`, `an_older_machine_is_named`, `a_revoked_link_says_so`, `removing_works_when_the_other_machine_is_away`, `a_failed_logout_still_deletes_the_token`.

## 2. Reading the other machine (Sona, `machines.rs`)

**A background loop**, only while a link exists: every 20 seconds for each link, `machine.info`, `agent.list` and `session.list`, with a 10-second limit and one machine's failure never holding up another. It keeps the result in memory only and never stores the other machine's bots. On a change, emit `machine.changed {machine}` with the row from `machine.list`. It must never take the runtime's main thread with blocking work.

**`bots`:** `[{id, name, color, outfit, look, role, provider, model, busy, activeSessionId, conversations}]`. `busy` is any live turn in that bot's conversations. Leave out hidden bots. When the machine is offline, keep the last list and set `state: "offline"`.

**`machine.refresh {id}`** → the row, now. **`machine.conversations {machineId, agentId}`** → `{conversations}`, from the other machine's `agent.conversations`, unchanged. **`machine.conversation {machineId, sessionId}`** → `{session}`, from its `session.get`, unchanged. All of them go through the gateway's redaction, so paths are already reduced there.

**`machineName` on a failure:** if the other machine can't be reached, these answer `provider_unavailable` with "`<name>` can't be reached right now."

**Tests:** `the_loop_only_runs_with_a_link`, `one_offline_machine_does_not_hold_up_another`, `offline_keeps_the_last_bots`, `hidden_bots_are_left_out`, `busy_comes_from_live_turns`, `reads_go_through_the_gateways_redaction`, `a_change_emits_machine_changed`, `nothing_about_the_other_machine_is_stored`.

## 3. Repo identity (Gogo, new `repo_identity.rs`)

- `normalize_remote(url) -> Option<String>`:
  - `git@GitHub.com:Owner/Repo.git`, `ssh://git@github.com/Owner/Repo`, `https://user:token@github.com/Owner/Repo/` all give `github.com/owner/repo`.
  - The host is always lower case. The path is lower case only for `github.com`, `gitlab.com` and `bitbucket.org`.
  - A non-default port stays (`git.example.com:8443/team/app`). A credential never appears in it. A local path or `file:` gives `None`.
- `safe_remote_url(url) -> Option<String>`: the URL with any user and password removed, except the literal `git@` form.
- `of_folder(path) -> Option<{identity, url}>`, from `git remote get-url origin`, off the runtime, with a 5-second limit.
- **Storage:** add `repo_identity TEXT` to `projects`, with a migration. `project.list` and `project.get` rows gain `repoIdentity`. It's filled on `project.create`, `project.update`, `project.clone`, and by one sweep at startup, off the runtime. `project.list` never runs git itself.
- **`project.findByIdentity {identity}`** → `{project}` or `{project: null}`. The first with a folder that exists.
- `repoIdentity` crosses to devices. Add a golden if the policy tests need one. It never holds a credential.

**Tests:** `identity_is_the_same_for_every_url_shape`, `identity_never_holds_a_credential`, `other_hosts_keep_their_case_and_port`, `a_local_path_has_no_identity`, `safe_url_removes_the_password`, `project_list_carries_the_identity`, `project_list_runs_no_git`, `find_by_identity_skips_a_missing_folder`, `old_projects_get_an_identity_at_startup`.

## 4. `.bitbots.json` (Gogo, new `shared_settings.rs`)

An optional file in the project folder's root, committed to the repo by the owner:

```json
{ "version": 1, "setupScript": "npm install", "defaultBot": "Rae", "approvalMode": "ask" }
```

**A repository is someone else's input, so this file does nothing until the owner trusts this exact content.**

- Read from the project's own folder, never a conversation's copy. A regular file, not a symlink, at most 64 KiB.
- Same limits as the fields in `validate_project_overrides`. **`approvalMode: "bypass"` is refused:** "A repository file can't turn on Full access." A bad field is dropped and named in `problems`. The other fields stand. Unknown keys are named in `problems` and ignored.

**`project.sharedSettings.get {projectId}`** → `{found, valid, problems, settings, hash, trusted, state: "none"|"untrusted"|"trusted"|"invalid"}`.
`hash` is the SHA-256 of the file's bytes. `invalid` means it isn't JSON or isn't a supported `version`.

**`project.sharedSettings.trust {projectId, hash, confirm}`:** no `confirm: true` is `invalid_argument`. A `hash` that isn't the file's current hash: `conflict`, "That file has changed. Check it again." Stores the hash in the project's `overrides` as `trustedSharedHash`, so it has the same desktop-only outlets: never in backups, never to devices. Reply as `.get`.

**`project.sharedSettings.untrust {projectId}`:** clears it.

**`project.sharedSettings.write {projectId, replace, confirm}`:** writes the project's current `setupScript` and `approvalMode` overrides, and its default bot's name when it has one, to `.bitbots.json`. An approval mode of `bypass` is left out. An existing file without `replace: true`: `conflict`. Trusts the new hash. Doesn't commit anything.

**Effect.** One function, `effective_overrides(st, project)`, read wherever `setupScript` and `approvalMode` are read today. The project's own override wins, field by field. Then a trusted file. A file whose hash no longer matches counts as untrusted, so a `git pull` can't change what runs.

**`project.list` rows gain** `sharedSettings: "none"|"untrusted"|"trusted"|"invalid"`, and `defaultBot: {name, agentId}` or `null`, from a trusted file. `agentId` is `null` when no bot here has that name.

**Tests:** `the_file_does_nothing_until_trusted`, `a_changed_file_stops_being_trusted`, `a_repository_file_cannot_turn_on_full_access`, `a_bad_field_is_named_and_the_rest_stand`, `a_symlink_or_large_file_is_refused`, `the_projects_own_override_wins`, `a_trusted_script_runs_in_a_new_copy`, `an_untrusted_script_never_runs`, `trust_needs_the_current_hash`, `write_refuses_to_replace_without_asking`, `write_leaves_out_full_access`, `trust_never_travels_in_a_backup_or_to_a_device`, `default_bot_is_null_when_no_bot_has_that_name`.

## 5. Handoff building blocks (Gogo)

**`worktree_attach.rs`: `attach_branch(repo_root, branch) -> Result<Attached, String>`.** `Attached` has what `worktree::create` returns. Put it in its own file, because another session is working in `worktree.rs`.
- `branch` comes from another machine, so check it: it must start `bitbots/`, pass `git check-ref-format --branch`, and never start with `-`.
- `git fetch origin refs/heads/<branch>`.
- A worktree already on that branch: refuse if it has uncommitted files, else `git merge --ff-only FETCH_HEAD`.
- A local branch with no worktree: it must be an ancestor of `FETCH_HEAD`, else refuse: "`<branch>` has commits here that aren't on the remote." Fast-forward it, then `git worktree add <path> <branch>`.
- No local branch: `git worktree add -b <branch> <path> FETCH_HEAD`.
- `<path>` follows `<repo>-bitbots/<slug>`, adding a number when it's taken. **Never force, never delete, never reset.**

**Storage, in `phase4.rs`:** `session_import(row)` inserts a session with a given id. `session_import_messages(session_id, messages)`, in one transaction, skips any message id already there, gives the rest the next sequence numbers in order, and keeps their `created_at`.

**Tests:** `attach_creates_a_copy_from_the_remote_branch`, `attach_fast_forwards_an_existing_copy`, `attach_refuses_a_dirty_copy`, `attach_refuses_local_commits_it_would_lose`, `attach_refuses_a_branch_outside_bitbots`, `attach_refuses_a_branch_starting_with_a_dash`, `attach_takes_a_numbered_folder_when_the_name_is_used`, `importing_messages_skips_ones_already_there`, `importing_messages_keeps_their_order_and_times`, `a_failed_import_leaves_nothing`.

**Also confirm with a test, no code change expected:** `a_template_of_every_bot_carries_no_secrets`, `updates_channel_never_travels_in_a_backup`.

## 6. Handoff (Round 2, Sona, new `handoff.rs`)

### Conversation owner

`session.data.link.movedTo: {machineId, name, at}` means another machine runs this conversation. It reaches the UI with the rest of the session.

`machine::refuse_if_moved` in `session_prompt_impl`, `session_steer`, `session_warm`, `resume_session` and the queue add: `conflict`, "This conversation moved to `<name>`. Take it over to continue." The same check refuses during a live lease: "This conversation is moving to `<name>`."

### On the machine giving it up (through the gateway)

New class `handoff` in `tiers.json`, `policy.rs` and `remoteTiers.ts`, `minTier: operator`, refused in quiet hours. **`rpc_post` also refuses `handoff.*` unless the device's `kind` is `machine`:** `forbidden_remote`. The result isn't passed through field redaction, so it must hold no host path.

**`handoff.preview {sessionId}`** → `{ready, reason, title, bot: {id, name, provider, model}, repo: {identity, url, branch, isWorktree, hasRemote}, uncommitted, commitsAhead}`. `url` is `safe_remote_url`. `ready: false` gives the first that applies:
1. "This conversation already moved to `<name>`."
2. "`<bot>` is working. Stop it or wait, then try again."
3. "This conversation is waiting on an approval or a question."
4. "This conversation has queued messages."
5. "This conversation has assignments running."
6. "The Manager's conversations stay on their machine." Also for a side conversation or a group: "Only a bot's own conversations can move."

**`handoff.prepare {sessionId, commitUncommitted, toMachineId, toName, confirm}`** → `{handoffId, steps, package}`.
- Re-check as `preview`. Take the lease: one per conversation, 10 minutes, in memory. A restart ends it.
- Steps, each `{id, status, detail}`. A failed step ends the lease and returns `{steps}` with no package. What already worked stays.
  1. `commit`: only in a conversation's own copy, when `uncommitted > 0`. `commitUncommitted` must be true, else fail: "There are uncommitted files." Uses `worktree::commit_all`, message "Handoff to `<toName>`".
  2. `push`: only in its own copy with an `origin`: `git push -u origin <branch>`. **Never force, and never the base branch.** A rejected push fails the step.
- `package`: `{version: 1, session: {id, title, createdAt, branch, isWorktree}, bot, repo: {identity, url, branch, head}, note, messages, truncated, omitted: {pictures, toolSteps}}`.
  - `bot` is `backup::export_bot`, so it holds no environment values, no ids of runtimes and no project.
  - `messages`: roles `user`, `assistant` and `notice`, each `{id, role, content, createdAt}`. No thinking, no tool output, no attachment paths. The newest 2,000, at most 16 MiB, with `truncated`.
  - `note`: fixed text and no model call: where it came from and when, the branch and its short commit, commits ahead, changed files (at most 12), and what didn't travel. In a conversation with no copy of its own, it says the files stayed on `<machine>`, and how many were uncommitted.

**`handoff.commit {handoffId}`:** an unknown or expired lease is `conflict`. Sets `movedTo`, writes the notice "Moved to `<toName>`.", closes the provider process, ends the lease, and emits `session.changed`. Reply `{ok: true}`.

**`handoff.abort {handoffId}`:** ends the lease. Commits and pushes stay. Reply `{ok: true}`.

### On the machine taking it (local, never remote)

**`machine.takeOver.preview {machineId, sessionId}`** → the other machine's preview, plus `{project: {id, name}|null, needsProject, runtimeReady, bot: {agentId, willCreate}}`.
- `project` from `project.findByIdentity`. `needsProject` when the repo has an identity and nothing here matches it.
- `runtimeReady` false when this machine has no runtime for that provider. `reason` then says which.
- `bot`: a bot here with the same id, else the same name and provider, else `willCreate`.

**`machine.takeOver {machineId, sessionId, projectId, commitUncommitted, confirm}`** → `{job}`, returned at once. Job: `{id, state: "running"|"done"|"failed", steps, sessionId, detail}`. Event `machine.takeOver.changed {job}`. **`machine.takeOver.list {}`** → `{jobs}`, in memory.

Steps, in this order. **Nothing here can run on this machine until the last step succeeds:**
1. `prepare`: `handoff.prepare`, with a 5-minute limit.
2. `code`: for a branch that was pushed, `attach_branch` in the project's repository. With no project chosen, or a conversation with no copy of its own, skip.
3. `bot`: match or create. A created bot's `approvalMode` is capped: `bypass` becomes the default for new bots. Environment keys stay empty.
4. `import`: `session_import` with the same session id, the local bot and runtime, the new copy or the project's folder, no provider session, and `link.movedTo` still set, to the giving machine. `session_import_messages`. Coming back to a machine that already has the row: update the same row, clear its provider session, and keep the messages it has.
5. `commit`: `handoff.commit`.
6. `open`: clear `movedTo`, arm the recap with `announce_context_loss`, and write the note as a notice with `meta {kind: "handoff", fromMachineId, fromName}`. Any queued setup runs as it does for a new copy.

**On failure.** Before step 5, call `handoff.abort`, delete what a first import created, and leave a returning row as it was. If `handoff.commit` itself fails, do the same. If step 5 was refused because the lease ended, say so plainly. Never leave both machines able to run it.

**Abandoned copies:** in `worktree_cleanup.rs`, a conversation with `movedTo` no longer counts as working in its copy, and the reason is `conversation_moved`. Its removal rules are unchanged. Nothing is ever removed without the owner.

**Tests** (two `AppState`s through a real gateway on loopback where it's practical):
`a_moved_conversation_refuses_every_way_to_start_a_turn`, `preview_explains_each_reason_it_isnt_ready`, `handoff_needs_a_machine_device_at_operator`, `a_phone_at_operator_is_refused`, `prepare_commits_and_pushes_the_branch`, `prepare_needs_consent_for_uncommitted_files`, `prepare_never_force_pushes_or_pushes_the_base`, `a_rejected_push_ends_the_lease_and_moves_nothing`, `a_lease_blocks_turns_and_expires`, `the_package_has_no_paths_or_thinking_or_tool_output`, `the_package_caps_its_messages`, `commit_needs_a_live_lease`, `take_over_moves_the_conversation_and_the_code`, `only_one_machine_can_run_it_at_every_step`, `a_failed_import_aborts_and_the_source_keeps_it`, `a_failed_commit_removes_the_import`, `take_over_never_carries_full_access`, `a_bot_is_created_only_when_none_matches`, `a_missing_runtime_stops_it_before_anything_changes`, `taking_it_back_keeps_the_same_conversation`, `the_recap_reaches_the_first_prompt`, `a_moved_conversations_copy_can_be_listed_as_abandoned`.

## Keeping the two lanes apart in Round 1

- **Sona:** `machines.rs`, `machine_client.rs`, and the gateway changes in `remote/`. **Gogo:** `repo_identity.rs`, `shared_settings.rs`, `worktree_attach.rs`, and the `project_setup.rs` change.
- **`phase4.rs` (storage):** Sona owns the `machine_links` part, in `phase4.rs`. Gogo puts its work in `phase4_sessions.rs`. Same for the migrations: each lane adds its own block, and I'll join them.
- **`main.rs`:** Sona adds dispatch arms after `"remote.status"` or the nearest remote arm. Gogo after `"project.scaffold"`. `mod` lines beside the others.
- **`tiers.json`:** Sona after `session.checkpoints`. Gogo after `project.scaffold`.
- **`docs/ipc-contract.md`:** Sona's section "Phase 4: machines". Gogo's "Phase 4: projects". I'll join them.

## Rules

- Never run `git commit`, `git push`, `git merge` or switch branches in your worktree. Change nothing outside it, apart from temporary test folders. Don't run `npm install`.
- **Never create a real GitHub repository, pull request or push while testing.** Use a local bare repository as `origin`.
- No real second machine in tests. Use a second daemon state on loopback, with a test certificate.
- Don't edit the skill files: put proposed text in your report.
- `crates/bloblex-storage/src/lib.rs` has one NUL byte: edit it only with your edit tool. No shell heredocs for anything with backslashes.
- Keep `every_daemon_log_call_site_is_a_fixed_message` true.

## Gates

From PowerShell in your worktree, with `BITBOTS_HOOK_BRIDGE` and `BITBOTS_REMOTE_WEB_DIR` removed for the session:
- `$env:RUST_MIN_STACK='33554432'; cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
- `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings`

Send output to a log file and read the summary lines. Known flaky tests: `a_crash_after_a_finished_turn_does_not_fail_that_session`, `stopping_a_turn_stops_its_setup_script`. Delete your `target` folder when you finish, because the disk is limited.

## Report

Files changed; item by item; every contract change with its reason; new test names and any existing test you changed; the exact gate output tails; what you could not verify; proposed skill text.
