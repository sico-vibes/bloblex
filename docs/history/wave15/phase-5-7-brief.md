# Brief: Phases 5, 6 and 7

Owner, 31 October 2026: "go through all the phases in parallel", "rely heavily on the OpenGo one", "only one Sona task running". Source: `docs/plans/expansion-plan-v3.md`.

**Lanes.** One worktree each. A lane does only its own sections.

| Lane | Bot | Sections |
|---|---|---|
| A | Gogo | 1 accounts, 2 custom models |
| B | Gogo | 3 more ACP providers, 4 Codex schema |
| C | Gogo | 7 phone push |
| D | Gogo | 9 CI and the performance gate |
| S1, then S2 | Sona, one at a time | S1: 5 secrets and 6 one-use requests. S2: 8 webhooks |

**The Director** does all front end. No lane edits `apps/desktop/src/ui`, except where a section says so. These need no backend and are the Director's: terminal links and the bot's commands, sandboxed visual replies, the sidebar.

Keep the contract exactly. If something can't work as written, pick the smallest change and say so in your report.

**Rule:** "omitted" and explicit `null` are the same unless an item says otherwise.

**All new RPCs:** `tiers.json` class `never`, events `drop`, except where a section says otherwise. None go on the Bitbots MCP.

**Every command** is an argument list with no shell, has a time limit that really kills it, sets `GIT_TERMINAL_PROMPT=0` where git is involved, and never reads, passes or prints a credential. No message text, secret values, tokens or paths in logs.

## 1. Accounts (Lane A, new `accounts.rs`)

### Who is signed in

`runtime.list` rows gain `account: {label, plan, source} | null`.
- Only from the CLI's own output. **Never read a token or a credential file for this.** The usage-bar exception in `AGENTS.md` doesn't cover it.
- Codex: the app server's account read. Claude: `claude auth status`. OpenCode: `opencode auth list`. Check what your installed CLI really prints, and put real, redacted examples in the tests.
- `label` is an email or account name, or `null` when the CLI doesn't say. `plan` is the plan name or `null`. `source` is the command used.
- Read it during runtime discovery, with a 10-second limit, off the runtime. A failure gives `null`, and unknown stays unknown.
- `account` crosses to devices at `viewer`, because the owner sees it on a phone too. Add a golden.

### Several accounts per provider

An account is a named config folder for one provider. Table `accounts(id, provider, name, created_at)`, in new `crates/bloblex-storage/src/phase5.rs`. The folder is `<data>/accounts/<id>`, user-only. The default account is the CLI's own folder, has no row, and can't be deleted.

- **`account.list {}`** → `{accounts: [{id, provider, name, signedIn, label, plan, bots}]}`, where `bots` is how many bots use it.
- **`account.create {provider, name}`** → `{account}`. `provider` must be a known provider. `name` is 1 to 60 characters.
- **`account.rename {id, name}`**.
- **`account.delete {id, confirm}`:** no `confirm: true` is `invalid_argument`. A running turn on it is `conflict`. Bots on it go back to the default account. Deletes the folder, only if it's inside `<data>/accounts`.
- **`account.signIn {id}`** → `{command}`: a one-line PowerShell command the owner runs, with the environment set for that one command, for example `$env:CLAUDE_CONFIG_DIR='<folder>'; claude auth login`. Quote the path properly. It holds no secret.
- **`account.check {id}`** → the row, freshly read.
- **Environment:** Claude `CLAUDE_CONFIG_DIR`; Codex `CODEX_HOME`; OpenCode `XDG_CONFIG_HOME` and `XDG_DATA_HOME`. Put the table in one function.

**Bots.** `agent.accountId`, a string or `null` (default), through `agent.create` and `agent.update`, and readable by `agent.list`. An id that doesn't exist or belongs to another provider is `invalid_argument`. It never travels in a backup or a handoff: a restored or moved bot gets `null`.

**Spawning.** The account's environment joins where `customEnv` joins at spawn (`main.rs`, near `customEnv`). Find out whether a provider's adapter shares one process across bots. If it does, a bot on a different account must get its own process or a clear refusal, and you must say which in your report. This is the part most likely to be wrong, so test it with the fake peers.

**Usage bars** keep reading the default account only. Say so in your report.

**Tests:** `account_comes_from_the_clis_own_output`, `an_unknown_account_stays_unknown`, `no_token_is_read_for_the_account`, `accounts_create_a_private_folder`, `delete_needs_confirm_and_moves_bots_to_default`, `delete_refuses_a_running_turn`, `delete_only_removes_inside_the_accounts_folder`, `sign_in_command_quotes_the_folder`, `a_bot_cannot_use_another_providers_account`, `the_account_environment_reaches_the_spawn`, `two_accounts_never_share_a_process`, `account_ids_never_travel_in_a_backup`.

## 2. Custom models (Lane A)

Table `custom_models(id, provider, model_id, label, efforts_json)`, in `phase5.rs`.
- **`model.custom.list {provider}`** → `{models}`. **`model.custom.save {id, provider, modelId, label, efforts}`** → `{model}`. **`model.custom.delete {id}`**.
- `modelId` is 1 to 200 characters with no whitespace, `label` at most 80, `efforts` at most 8 strings of at most 24 characters. A provider's catalog already listing that id: `conflict`.
- `runtime.models` merges these with `source: "custom"`, after the catalog's own. A bot can pick one and a turn passes it to the CLI unchanged. If the CLI refuses it, the turn's normal failure explains it.
- Never in a catalog cache. They travel in backups: they hold no secret, and a restored one is just a name.

**Tests:** `a_custom_model_joins_the_catalog`, `a_custom_model_cannot_shadow_a_listed_one`, `bad_custom_models_are_refused`, `a_turn_passes_a_custom_model_through`, `custom_models_travel_in_a_backup`.

## 3. More ACP providers (Lane B)

Today `crates/bloblex-adapter-acp` serves OpenCode, and many places match on `"claude" | "codex" | "opencode"`.

- One table in `crates/bloblex-runtime`: `{provider, displayName, command, args, signInCommand, installHint}`. Add **Gemini CLI** (`gemini --experimental-acp`, provider `gemini`) and **Qwen Code** (`qwen --experimental-acp`, provider `qwen`). Check their current flags from their own documentation, and say what you found.
- Discovery finds them like the others. Not installed means not listed, the same as today.
- A provider in this table works through the existing ACP adapter: sessions, turns, tools, approvals, models from `session/new`. Replace the `match`es that must know it (`main.rs` `provider_mode`, `provider_display_name`, capability rows, sign-in text). Give unknown capabilities the honest "not supported".
- OpenCode's own behaviour doesn't change.
- `apps/desktop/src/ui/providerBrand.tsx` and `providerGuides.ts` are the Director's. List in your report what the window needs.

**Tests**, with the fake ACP peer: `a_table_provider_is_discovered`, `a_missing_provider_is_not_listed`, `a_table_provider_runs_a_turn`, `a_table_provider_asks_for_approval`, `opencode_still_behaves_as_before`, `an_unknown_provider_gets_honest_capabilities`.

**You can't verify against a real Gemini or Qwen CLI** unless they're already installed. Don't install them. Say so.

## 4. Codex schema (Lane B)

- `scripts/codex-schema.ps1` runs `codex app-server generate-json-schema --out <dir>` (check the real command for codex-cli 0.165.0) and writes `crates/bloblex-adapter-codex/schema/`, with `VERSION` holding the CLI version. Commit-ready, deterministic, and no absolute paths inside.
- A test parses the pinned schema and checks that **every method the adapter sends and every notification it handles** is in it. So an update that removes one fails the test.
- Runtime discovery compares the installed version with `VERSION`. `runtime.list` gains `protocol: {pinned, installed, match}` for Codex. A mismatch isn't a refusal.
- `doctor.rs` reports a mismatch as a warning: "Codex x is newer than the version Bitbots was checked against (y)."

**Tests:** `every_method_the_adapter_uses_is_in_the_pinned_schema`, `a_method_missing_from_the_schema_fails`, `a_newer_codex_is_a_warning_not_a_refusal`, `the_pinned_schema_holds_no_absolute_paths`.

## 5. Secrets in the credential store (Sona S1, new `secrets.rs`)

Environment values point at the Windows Credential Manager instead of plain text.

- Use `CredWriteW`, `CredReadW`, `CredDeleteW`, `CredEnumerateW` through `windows-sys`, target name `Bitbots/<name>`, type generic, persist local machine. `name` is 1 to 64 of `[A-Za-z0-9_.-]`. Value at most 2,048 bytes (the API's limit for generic credentials).
- **`secret.list {}`** → `{secrets: [{name, updatedAt, usedBy}]}`. Names only. There is **no RPC that returns a value**.
- **`secret.set {name, value, confirm}`:** no `confirm: true` is `invalid_argument`. An existing name is replaced.
- **`secret.delete {name, confirm}`:** a bot using it: `conflict` naming the bots.
- `agent.envRefs`: `{ENV_KEY: secretName}`, through `agent.create` and `agent.update`. The key follows the rules `customEnv` keys follow, and it may hold secret-looking names, since that's the point. `PATH`, `SYSTEMROOT`, `COMSPEC` and the like stay refused.
- At spawn, values are read and join the environment. A missing secret fails the turn with a plain sentence naming the secret, never a value.
- Backups carry `envRefKeys` only, like `customEnvKeys`. A handoff carries nothing. Devices see nothing: add a field rule and a golden.
- **The value never reaches** the database, an event, a log, a reply, a backup or a diagnostics bundle. Test each.
- **Be honest in the UI text you propose:** a coding agent can read its own environment, so this protects the value at rest, not from the bot.

**Tests:** `a_secret_round_trips_through_the_credential_store` (a test-only name, deleted after; skip cleanly if the store is unavailable), `there_is_no_way_to_read_a_value_back`, `a_value_never_reaches_storage_events_or_logs`, `env_refs_reach_the_spawn`, `a_missing_secret_fails_the_turn_with_its_name`, `delete_refuses_a_secret_in_use`, `dangerous_env_keys_stay_refused`, `backups_carry_only_the_keys`, `devices_see_no_env_refs`.

## 6. One-use secret requests (Sona S1, `secrets.rs`)

A bot asks, and the owner fills a secure form for that one run.

- **The tool:** `request_secret {name, reason}` joins the bot tools, through the same bridge `ask_user` uses. Read `questions.rs` and copy its shape: a pending record, an event for the window, and the turn waits. `reason` is at most 300 characters. Auto-approve and Full access don't answer it, because only the owner can.
- **Refused without asking** in an unattended turn: an automation, a task-board run, or a delegated child with no owner watching. The tool returns a plain sentence.
- **`secret.request.list {}`** → `{requests: [{id, sessionId, name, reason, botName, expiresAt}]}`. **`secret.request.answer {id, value}`**. **`secret.request.decline {id}`**. Events `secret.request.changed`. Expires like a question, and turn cancel ends it.
- **Delivery:** the value goes to a new file `<data>/one-use/<id>` with `apply_key_permissions`. The tool result gives the bot that path and nothing else: "The owner gave you NAME in this file. Read it when you need it, and don't print it." The file is **deleted when the turn ends**, and every leftover is deleted at startup.
- The value never reaches a message, event, log, usage record or device. All `never`, including through Remote: the form exists only at the desktop. The notice in the conversation says only "You gave Rae NAME for this turn."
- **Be honest in the proposed UI text:** the bot can read the file, and what it does with the value is up to it.

**Tests:** `a_bot_can_ask_and_the_turn_waits`, `the_value_reaches_a_private_file_only`, `the_file_is_gone_when_the_turn_ends`, `leftover_files_go_at_startup`, `cancel_ends_the_request`, `a_declined_request_tells_the_bot`, `an_unattended_turn_is_refused_without_asking`, `full_access_does_not_answer_it`, `the_value_is_in_no_message_event_or_log`, `a_device_cannot_answer`.

## 7. Phone push (Lane C, new `remote/push.rs`)

Content-free. Web Push from the daemon to the paired PWA. **Off by default**, because it goes through the phone maker's push service.

- A VAPID key pair (P-256) made once, the private key in `<data>/remote-push-key.pem` with `apply_key_permissions`, never returned.
- Implement RFC 8291 (`aes128gcm`) and RFC 8292 (VAPID) with small pure-Rust crates. No OpenSSL.
- **Setting:** `remote.push.enabled`, default `false`. Not exportable. `remote.push.get {}` → `{enabled, publicKey, devices}`. `remote.push.set {enabled, confirm}`: turning on needs `confirm: true`.
- **From a device** (tier `viewer`, exact `tiers.json` rows, class `read` for the first and `chat` for the rest): `push.key {}` → `{publicKey, enabled}`; `push.subscribe {endpoint, p256dh, auth}`; `push.unsubscribe {}`.
- **Subscriptions:** table `remote_push(device_id PK, endpoint, p256dh, auth, created_at, failed_at)`, in new `crates/bloblex-storage/src/phase6.rs`. One per device. Revoking a device deletes it.
- **The endpoint is untrusted.** It must be `https`, with no user or password, on a known push host: `fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`, `web.push.apple.com`. Else `invalid_argument`. No redirects, no proxy, a 10-second limit and a small response cap.
- **Sending:** when a conversation starts needing the owner (a permission or question arrives) or a turn fails. Payload exactly `{"title":"Rae needs you","sessionId":"…"}`, or "Rae's turn failed". **Never message text, tool names, paths or project names.** At most one per conversation per 60 seconds. Quiet hours send nothing. A push service answer of 404 or 410 deletes that subscription.
- Failures are counted, and logged only as fixed text.
- Add a section to `docs/remote/THREAT_MODEL.md`, numbered after the last one.
- `apps/desktop/src/remote/sw/` and `RemoteApp.tsx` are the Director's.

**Tests:** `push_is_off_until_the_owner_turns_it_on`, `a_payload_holds_no_content`, `the_payload_is_encrypted_per_rfc8291` (with RFC test vectors), `vapid_signs_per_rfc8292`, `an_unknown_push_host_is_refused`, `a_device_only_changes_its_own_subscription`, `revoking_a_device_drops_its_subscription`, `one_push_per_conversation_per_minute`, `quiet_hours_send_nothing`, `a_gone_subscription_is_deleted`, `the_private_key_is_never_returned`.

## 8. Webhook triggers (Sona S2, new `webhooks.rs`, after S1 is merged)

**First** write the threat-model section in `docs/remote/THREAT_MODEL.md`, as the plan requires. Put it in your first report before building, and wait for my answer.

Starts an automation from a signed request. Only reachable while Remote is on.

- An automation gains `webhook: {enabled, includeBody}`. **`automation.webhook.enable {id, confirm}`** → `{url, secret}`, shown once. **`automation.webhook.rotate`**, **`automation.webhook.disable`**. The secret lives in the credential store through section 5. All `never`.
- **Route:** `POST /api/hook/<id>` on the gateway, outside the Origin check, inside the abuse limits. Body at most 64 KiB.
- **Signature:** `X-Bitbots-Timestamp`, and `X-Bitbots-Signature: sha256=<hmac of "timestamp.body">`. Constant-time compare. Timestamp within 5 minutes. A replay cache of signatures for 10 minutes. Every failure answers the same 404 as an unknown id, and failures count toward the source's lockout.
- **Running it** goes through the existing automation path: its caps, the global pause, a mode that's never bypass. Disabled, paused or already running: answer `202` and do nothing else, with a content-free activity line.
- **The body is untrusted.** `includeBody` is off by default. When on, it reaches the prompt only as quoted inert data, in the existing delimited form (see `knowledge.rs` `inert`).
- A scheduled and a webhook trigger can coexist. The double-fire rule still holds.

**Tests:** `a_signed_request_starts_the_automation`, `a_bad_signature_is_a_plain_404`, `an_old_timestamp_is_refused`, `a_replay_is_refused`, `a_disabled_webhook_is_a_404`, `a_paused_automation_does_nothing`, `the_body_stays_out_unless_asked`, `an_included_body_is_inert`, `the_secret_is_never_returned_twice`, `failures_count_toward_the_lockout`, `a_webhook_run_is_never_bypass`.

## 9. CI and performance (Lane D)

- `.github/workflows/ci.yml`, on push and pull request to `main`, on `windows-latest`: `npm ci`, typecheck, `npm test`, `cargo test --workspace --exclude bloblex-desktop`, clippy with `-D warnings`, `npm run build`, `build:remote`, `docs:check`. Set `RUST_MIN_STACK=33554432`. Cache cargo and npm. Pin action versions to full commit hashes. `permissions: contents: read`. No secrets. Read `references/verification.md` for the known flaky tests, and give those a single retry rather than skipping them.
- **Check `apps/desktop/src-tauri/binaries`**: it's untracked locally, so make sure the workspace tests don't need it on a clean checkout, and say what you found.
- **Performance gate:** `scripts/perf-gate.mjs` and `perf-budgets.json` at the root:
  - **Cold start:** the time from starting `bitbotsd` to its ready line, on a seeded database.
  - **Snapshot size:** `app.snapshot` bytes, with `lazy` and without, on the same database (200 conversations, 2,000 messages).
  - **Render time:** a 1,000-message conversation mounted in a test (`apps/desktop/src/ui/perf.mounted.test.tsx`, which is yours to add).
  - Budgets are set from your measurements plus a sensible margin. Say what they are. Exceeding one fails. Generous on CI, since its machines vary: take the median of 3.
- `npm run perf` runs it. CI runs it as a step.
- Update `references/verification.md` through your report.

**Tests:** the script has a `--self-test` that fails on purpose with a tiny budget. Show it failing.

## Keeping the lanes apart

- **`main.rs`:** A adds dispatch arms after `"runtime.profile.delete"`. B changes only what it must. C adds to the remote arm. S after `"project.scaffold"`. `mod` lines beside the others, one per line, in your own block with a comment naming the phase.
- **`tiers.json`:** A after `runtime.profile.list`. C after `remote.activity.list`. S after `settings.get`.
- **`docs/ipc-contract.md`:** each lane adds its own section at the end, titled for its sections.
- **`crates/bloblex-storage/src/lib.rs`:** one `mod` line and one ensure call each, on their own lines. It has one NUL byte, so edit it only with your edit tool.
- **`Cargo.toml`:** add your own dependencies. I'll join `Cargo.lock`.

## Rules

- Never run `git commit`, `git push`, `git merge` or switch branches. Change nothing outside your worktree, apart from temporary test folders and your build folder. Don't run `npm install`. Lane D may add a `devDependency` only by telling me.
- **Cargo target:** set `CARGO_TARGET_DIR=C:\bt\<your lane letter>` in every cargo command. Drive D is nearly full. Delete it when your last chunk is done.
- **Gogo lanes: keep each turn under 25 minutes and end it at a clean point with a report.** I'll review and send the next chunk.
- **Run tests in the foreground and report in the same turn.** Don't end a turn while a background command runs.
- No real money, no real accounts created, no real pushes to a real service, no real webhooks from outside, no real pull requests.
- Don't edit the skill files. Put proposed text in your report.
- Keep `every_daemon_log_call_site_is_a_fixed_message` true.

## Gates

From PowerShell, with `BITBOTS_HOOK_BRIDGE` and `BITBOTS_REMOTE_WEB_DIR` removed:
- While working: only your own tests, `cargo test -p bloblex-daemon <name>`.
- In your last chunk: `$env:RUST_MIN_STACK='33554432'; cargo test --workspace --exclude bloblex-desktop --no-fail-fast`, then `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings`.

Known flaky: `a_crash_after_a_finished_turn_does_not_fail_that_session`, `stopping_a_turn_stops_its_setup_script`.

## Report

Files changed; item by item; every contract change with its reason; new test names and any existing test you changed; exact gate tails; what you could not verify; what the window needs; proposed skill text.
