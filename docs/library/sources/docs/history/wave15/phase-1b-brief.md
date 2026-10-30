# Brief: Phase 1B, from Theo's T3 Code video (filtered for bots, desktop only)

Owner request, 30 October 2026: "Start Phase 1B now." Source: `docs/plans/expansion-plan-v3.md`, Phase 1B. Six items: fan-out and compare, send when a usage limit resets, prompt stash, annotate a reply, create a new project, report a problem.

The "Later, with Phase 3/4" items in the plan are not part of this work. Nothing here adds a thread inbox: a bot stays a bot with a status.

**Lanes.** Backend: Claude Sonnet 5.5 (medium), the in-app bot Sona, in its own worktree. Frontend: the Director, building against this contract at the same time in the main checkout. So keep the contract exactly; if something can't work, pick the smallest change and say so in the report.

**Rule for every optional parameter below:** "omitted" and explicit `null` are the same unless the item says otherwise.

**Every new RPC** gets a `tiers.json` row with class `never`, and every new event a `drop` row. These are desktop features. The Rust and TypeScript parity tests must pass.

**Privacy.** No prompt, note, stash or issue text in logs. Keep `every_daemon_log_call_site_is_a_fixed_message` true. Never read, pass or print a GitHub token: `git` and `gh` use their own sign-in. Run them without a shell (`Command` with an argument list, the no-window flag as `repository.rs` does), with timeouts, and put errors through one-line, redacted text (`diagnostics::redact`).

## 1. Fan-out and compare

One prompt to several bots, each in its own new conversation, so the answers can be compared.

**Storage.** New table `fanouts(id, title, prompt, project_id NULL, created_at, chosen_session_id NULL, rows_json)`. A row in `rows_json`: `{agentId, sessionId, error}`. Each conversation also gets `fanoutId` merged into `sessions.data`, and the session DTOs (detail, list, event summary) carry `fanoutId` (null when none).

**`fanout.start {agentIds, text, attachments?, projectId?, worktrees?, title?}`**
- `agentIds`: 2 to 6 distinct bots, else `invalid_argument` "Choose 2 to 6 bots." A missing or archived bot refuses the whole call (`not_found` / `conflict`), before anything is created.
- `text`: 1 to 100,000 characters, or empty when attachments exist. Attachments validate through `prompt_attachments`.
- `projectId`, three cases, as in Phase 1A:
  - string: that project for every bot (`not_found`, or `invalid_argument` when it has no folder, refuse the whole call);
  - omitted: each bot's own default order (`default_conversation_project`);
  - explicit `null`: no project, each bot's private workspace.
- `worktrees` (bool): default `true` when the conversation's folder is a git repository, otherwise ignored. Each conversation gets its own worktree (`worktree::create`, `link: {kind:"main", worktree}`). `false` means they share the folder.
- `title`: optional, up to 120 characters; default is the first 60 characters of the text. It is also each conversation's title.
- Per-bot failures don't stop the others. A failed row has `sessionId: null` when no conversation exists, and `error` set to a plain sentence (a coding agent that takes no images, a worktree that could not be made, a refused prompt). If every row fails, still return the record.
- Conversations are ordinary main conversations started with `new_session` (lazy) then the normal prompt path, so approvals, queues and limits all behave as usual.
- Returns `{fanout}`.

**The `fanout` object:** `{id, title, text, projectId, projectName, createdAt, chosenSessionId, rows:[{agentId, agentName, sessionId, state, reply, error, durationMs, tokens, worktree}]}`
- `state`: the session's presented state, or `"failed"` when `sessionId` is null.
- `reply`: the text of the latest assistant message of the latest turn, or null. Live per read, not stored.
- `durationMs`, `tokens`: from the latest turn; null when unknown, never zero.
- `worktree`: `{path, branch}` or null.

**`fanout.get {id}`** → `{fanout}`, `not_found` when missing.
**`fanout.list {limit?}`** → `{fanouts}`, newest first, default 20, at most 100. Same object, with `reply` cut to 300 characters.
**`fanout.pick {id, sessionId}`** sets `chosenSessionId`; `sessionId: null` clears it; a session not in the record is `invalid_argument`. Returns `{fanout}`. It has no other effect.
**`fanout.delete {id}`** removes the record only. Conversations stay, and `fanoutId` on them reads back null. Returns `{deleted:true}`.
**Event** `fanout.changed {id}` on start, pick and delete. No text in the payload. The UI refetches on `session.changed` for a member conversation.

**MCP.** Chat-level tool `fan_out {botIds, text, projectId?, worktrees?}`, returning `{fanoutId, rows:[{botId, sessionId, error}]}`; use `wait_for_turn` per conversation. Below Operator, `worktrees` must be false or omitted (default false there), because `send_message`'s worktree needs Operator; `true` below Operator returns `needs(Operator)`. Same origin marking as `send_message`.

**Tests:** `fanout_starts_one_conversation_per_bot_in_the_same_project`, `fanout_null_project_uses_each_private_workspace`, `fanout_makes_a_worktree_each_in_a_git_project`, `fanout_refuses_too_few_or_an_archived_bot_and_creates_nothing`, `fanout_one_bad_row_does_not_stop_the_others`, `fanout_get_reports_replies_and_unknown_usage_as_null`, `fanout_pick_and_delete`, `external_fan_out_respects_the_level`.

## 2. Send when a usage limit resets

`session.queue.add` already schedules (`dueAt`, kind `send_later`). Add:

**`session.queue.add {..., whenLimitResets: true}`**
- Needs `limitedUntil` in the future on that session, else `conflict` "This conversation isn't waiting for a usage limit." Refuses `dueAt` together with it (`invalid_argument`).
- Stores kind `send_later` with `due_at = limitedUntil`, and `whenLimitResets: true` in the item. Skips `validate_due_at`'s minimum and maximum. Queue list items carry `whenLimitResets` (false when absent).
- Not available for a side conversation (the existing refusal stands).

**Delivery**
- While the session's `limitedUntil` is still in the future, `due_tick` must not send a `whenLimitResets` item. If the limit was extended, move its `due_at` to the new reset and emit `queue.changed`. Ordinary `send_later` items keep today's behaviour.
- Order at reset: the existing watchdog continuation (when it applies) runs first; `due_tick` already skips a busy session, so the item goes after it.
- It sends at reset whether `experimental.resumeAfterUsageLimits` is on or off.
- A send that hits the limit again goes back to waiting: the item stays queued with the new reset rather than failing or pausing the queue.

**MCP.** `send_message` gains `whenLimitResets` (boolean), only with `sessionId`.

**Tests:** `when_limit_resets_needs_a_limited_session`, `when_limit_resets_sends_after_the_continuation_not_before`, `when_limit_resets_follows_an_extended_limit`, `when_limit_resets_ignores_the_resume_setting`.

## 3. Prompt stash

Save a draft with its images and use it anywhere later. It outlives the composer's two-hour local draft.

**Storage.** New table `prompt_stash(id, text, attachments_json, agent_id NULL, session_id NULL, project_id NULL, created_at, updated_at)`. Images are copied to `<data>/stash/<id>/`. Not in backups, and not reachable by the MCP.

- **`stash.add {text, attachments?, agentId?, sessionId?, projectId?}`:** text up to 100,000 characters; at most 10 attachments, validated through `prompt_attachments` and copied. Needs text or an attachment (`invalid_argument`). At most 100 items (`conflict` "The stash is full. Remove something first."). The three ids only record where it came from; an unknown one is stored as null. Returns `{item}`.
- **`stash.list {}`** → `{items}`, newest first. An item: `{id, text, attachments:[{file, name, bytes, mediaType}], agentId, agentName, sessionId, projectId, projectName, createdAt, updatedAt}`.
- **`stash.update {id, text}`** → `{item}`. It may not leave an item with no text and no attachments.
- **`stash.image {id, file}`:** same response shape as `task.image`, with `file` checked against the item's list so no path escapes the folder.
- **`stash.restore {id}`** → `{item:{text, attachments:[{path, name}]}}`. Moves the images to `<data>/stash-restored/<uuid>/`, so they can be sent like staged images, and deletes the row. Startup prunes restored folders older than 7 days.
- **`stash.delete {id}`** → `{deleted:true}`, with the files.
- **Event** `stash.changed {}`, no content.

A coding agent that takes no images still refuses them when sent; that isn't the stash's job.

**Tests:** `stash_keeps_text_and_images_across_a_restart`, `stash_refuses_empty_too_many_and_a_non_image`, `stash_restore_gives_sendable_paths_and_removes_the_row`, `stash_image_cannot_escape_its_folder`, `stash_delete_removes_files`.

## 4. Annotate a reply

Mark part of a bot's reply and send the note with the next message.

**`annotations: [{messageId, quote, note}]`** on `session.prompt` and `session.queue.add` (allowlisted and replayed like `replyTo`).
- At most 10. `messageId` must be an assistant message in this conversation (`invalid_argument`, as `replyTo` checks). `quote`: 1 to 2,000 characters. `note`: 1 to 2,000 characters.
- The quote comes from rendered text, so don't require it to match the stored message exactly.
- `text` may be empty when annotations exist.
- Stored as `meta.annotations` on the user message, with the message's text unchanged, so the transcript shows the user's words and the UI draws the notes.
- The coding agent receives this block before the text, the same way for every provider:

```
The owner marked parts of your earlier reply:

1. On this part:
> <quote, each line prefixed>
Note: <note>

<text>
```

**Tests:** `annotations_reach_the_provider_before_the_text`, `annotations_are_stored_in_meta_and_text_stays_the_users`, `annotations_refuse_a_foreign_message_and_too_many`, `queued_annotations_survive_to_delivery`.

## 5. Create a new project

**`project.scaffold.status {}`** → `{git: bool, gh: {available: bool, login: string|null}}`. `login` comes from `gh api user --jq .login` with a 10-second timeout, null on any failure.

**`project.scaffold {name, parentPath, git, github?, confirm}`**
- `confirm: true` is required: the dialog that lists these steps is the owner's approval. Otherwise `invalid_argument` "Confirm creating the project first."
- `name`: 1 to 80 characters, a valid Windows folder name (none of `<>:"/\|?*`, no trailing dot or space, not a reserved device name). `parentPath` must be an existing folder.
- The target folder must not exist or must be empty, else `conflict` "That folder already exists and isn't empty."
- `git`: bool. `github`: `{visibility: "private"|"public"}` or null, and needs `git: true` (`invalid_argument`). There is no default visibility: a missing or other value is refused.
- Steps, in order, each reported:
  1. `folder`: create it.
  2. `project`: `project.create`, so the project exists even if a later step fails.
  3. `git_init`: `git init -b main`.
  4. `first_commit`: write `README.md` containing `# <name>`, then `git add README.md` and `git commit -m "Initial commit"`.
  5. `github`: `gh repo create <slug> --private|--public --source . --remote origin --push` (`slug`: spaces become `-`, other characters GitHub refuses are dropped).
- Stop at a failed step. Later steps report `skipped`. A step not asked for reports `skipped`.
- Returns `{project, steps:[{id, status:"done"|"failed"|"skipped", detail}], githubUrl}`. `project` is null only if `folder` or `project` failed. `detail` is a one-line redacted sentence, null when done. `githubUrl` is null unless `github` is done. Step failures don't make the RPC fail; argument errors do.
- Timeouts: 60 s for each git command, 120 s for `gh`.

Not on the MCP: it can publish a repository, and the plan keeps that behind the owner's approval.

**Tests** (with `gh` stubbed by a fake executable on `PATH`, or the seam you prefer): `scaffold_needs_confirm_and_a_valid_name`, `scaffold_refuses_a_folder_with_files`, `scaffold_creates_folder_project_and_first_commit`, `scaffold_without_git_only_makes_folder_and_project`, `scaffold_keeps_the_project_when_github_fails`, `scaffold_needs_git_for_github_and_a_visibility`.

## 6. Report a problem

Extends `diagnostics.rs`. Nothing leaves the computer without the owner's confirmation, and the owner sees the exact text first.

**`diagnostics.issueDraft {}`** → `{repo:"sico-vibes/bloblex", title:"", body, url, gh:{available, login}}`
- `body` is Markdown with these sections: `What happened` (empty, for the owner to fill in), `Version` (app version, Windows version), `Coding agents` (provider and version only), `Health check` (each check that isn't ok: label, status, one-line detail).
- Passed through `redact`, with the user's home folder replaced by `~`. No logs, messages, settings, project names or paths beyond that.
- `url` is GitHub's new-issue address with the title and body filled in, the body cut to 6,000 characters of source text before encoding.

**`diagnostics.issuePost {title, body, confirm}`** → `{url}`
- `confirm: true` required. `title`: 1 to 200 characters. `body`: up to 60,000 characters. Runs `redact` again on both.
- `gh issue create --repo sico-vibes/bloblex --title <title> --body-file -`, with the body on stdin. Without `gh`: `unsupported` "Install and sign in to the GitHub CLI, or open the issue in your browser."

**Tests:** `issue_draft_has_only_the_listed_sections_and_no_secret_or_home_path`, `issue_url_is_encoded_and_bounded`, `issue_post_needs_confirm_and_redacts_again`, `issue_post_without_gh_says_how_to_continue`.

## Gates

From PowerShell in your worktree, with `BITBOTS_HOOK_BRIDGE` and `BITBOTS_REMOTE_WEB_DIR` removed for the session:

- `$env:RUST_MIN_STACK='33554432'; cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
- `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings`

Known flaky test: `a_crash_after_a_finished_turn_does_not_fail_that_session`. There is no `node_modules` in the worktree, so the Director runs the npm gates after merging.

## Report

- Files changed.
- Item by item: what's done, and anything not done.
- Every contract change, with its reason.
- New test names, and the exact gate output tails.
- Anything you could not verify.
- Update `.claude/skills/bitbots-development/references/codebase-map.md` and `lessons.md`, and `docs/ipc-contract.md`.
