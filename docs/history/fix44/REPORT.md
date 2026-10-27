# FIX44 — composer and conversation fixes

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`. Branch `fix44/composer-conversation` in the worktree `D:\gogo1` (scratch, for the native build only); the change itself is uncommitted in the main checkout.

Six reported behaviours, all in the composer and the conversation:

1. Model warning scope.
2. Sent images as thumbnails.
3. Remove-X and effort-picker geometry.
4. Queue and status inside the composer card.
5. Queued / sending / saved / failed states and auto-titles.
6. Permissions (Full access persists).

## What changed, and where

### 1 Model warning scope

- `crates/bloblex-daemon/src/main.rs` (`update_session_model`): `confirmModelChange` is required only when there is real continuity to lose — a stored provider session (`providerSessionId`), a measured context (`contextUsed`, `contextModel`), a delivered provider turn (`session_had_provider_turns`) or user messages (`session_has_user_messages`, new in `crates/bloblex-storage/src/lib.rs`). The refusal copy now names the consequence: a new provider session without the working memory of the chat.
- `apps/desktop/src/ui/SessionExecutionControls.tsx`: `modelChangeNeedsWarning()` (user turns, `contextUsed`, `contextModel`) decides whether the dialog appears; `confirmationRequired()` recognises the daemon's `confirmation_required` answer and shows the same dialog if the view had not predicted it. A model change now writes `session.model.update` **before** `agent.update`, so cancelling leaves both the conversation and the bot untouched. Effort and speed keep the old bot-first order.
- Dialog: “Start a new provider session?” with the provider named, the context reset explained, and “Your saved messages stay in Bitbots.”

### 2 Sent images

- `crates/bloblex-daemon/src/main.rs`: at `session.prompt` every accepted image is copied into `<data dir>/message-images/<turn>-<n>.<ext>` and the file name is recorded on the message; older messages keep only `path`. New `message.image` RPC takes `{sessionId, messageId, index}` — never a path — checks the message belongs to the conversation, re-checks the image signature, caps the size, and returns a data URL. `session.delete` removes the conversation's copies (`session_attachment_files`).
- `apps/desktop/src/ui/ComposerControls.tsx`: `MessageAttachments` renders 132 px thumbnails with a viewer (Escape, backdrop, focus returns to the thumbnail), a dashed “Not available” placeholder for a missing or damaged file, and a retry for a transport refusal that means “the daemon is not running yet” (`transientImageFailure`). Without a session/message identity it falls back to the old filename chip.
- `apps/desktop/src-tauri/src/lib.rs`: `message.image` joined `retry_startup_read`, so the first read after a reload is retried instead of failing while the daemon starts.
- `apps/desktop/src/remote/tiers.json`: `message.image` is a `viewer` read with a reason, which the tier parity test requires.
- The composer tray is unchanged.

### 3 Remove X and effort picker

- `apps/desktop/src/ui/composer.css`: `.composer-attachment-remove` is a 24 px box with `padding: 0`, `place-items: center`, `line-height: 1`, a `--focus-ring` on `:focus-visible` and visible on hover, `:focus-within` or keyboard focus.
- `.session-effort-popover` is `width: max-content` with `min-width: min(320px, calc(100vw - 24px))` and `max-width: min(460px, calc(100vw - 24px))`; labels are `min-width: max-content` in a wrapping flex row, with no ellipsis or clipping; the fixed 320/404 px widths and the `.has-ultra` width override are gone.

### 4 Queue and status

- `apps/desktop/src/ui/PromptQueue.tsx`: new `ComposerStatus` — one 22 px row inside the composer card with the queue count chip (`aria-expanded`/`aria-controls`), the steer/queue mode, the queued reason, “Paused …” with Resume, and “Retrying automatically” with Cancel. The queue rows unfold from the chip (`QueueBanner` unchanged inside it).
- `apps/desktop/src/ui/App.tsx`: the status row is the first child of `.composer-box`; the old banner and `.composer-send-mode` above the card are gone. `queueExpanded` folds again per conversation.
- `composer.css`: the row keeps its height in every state, so nothing above it moves.

### 5 States and auto-titles

- `apps/desktop/src/ui/App.tsx`: `PendingSend` carries `status`, `error`, `method` and `params`. Sending shows “Sending…”, success clears the row, failure keeps it with the friendly reason plus **Try again** and **Edit** (Edit returns the text and images to the composer). No duplicate bubble: the draft comes back only through Edit.
- `crates/bloblex-daemon/src/experiments.rs`: `title_from_prompt(text, images)` strips fenced code and code-looking lines, drops leading greetings and openers (“Hey, can you fix the login bug” → “fix the login bug”), and falls back to `Shared 1 image`, `Code review`, `Quick hello` or `Quick chat`. The storage rule is unchanged: no manual title, no `title_override`, no side conversation, no conversation with a prior user message.

### 6 Permissions

- `apps/desktop/src/ui/ComposerControls.tsx`: `permissionWrite(next, botMode)` writes `null` only when the choice *is* the bot's default, and **always** writes `bypass` for Full access. Previously, with a bot already defaulting to bypass, choosing Full access wrote `null`, which cleared the bot's setting and dropped the conversation to the global Ask.
- The menu note now says the choice starts with the next message and a running turn keeps the mode it started with; a failed write restores the exact previous session.
- `crates/bloblex-storage/src/lib.rs`: `agent_rows_locked` (the snapshot) now carries `approvalMode` and `effectiveApprovalMode`. The snapshot is the only place the UI learns a bot's mode on load, so without this a reload or restart showed the global default even though the bot was bypass. Found in the native run.

## Gates

| Gate | Result |
|---|---|
| `cargo test -p bloblex-storage` | 132 passed |
| `cargo test -p bloblex-daemon --bin bitbotsd` (RUST_MIN_STACK=16 MiB) | 474 passed, 1 failed — `remote::tests::an_absent_web_folder_serves_the_built_in_page`, which also fails on a clean `main` in this checkout (a built `apps/desktop/dist` exists) |
| `cargo test --workspace --exclude bloblex-desktop` (RUST_MIN_STACK=16 MiB) | all suites green except the same remote test |
| `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings` | clean |
| `cargo test -p bloblex-desktop --lib` | 70 passed (run in the short-path worktree: the resource compiler cannot read the apostrophe in the main checkout path) |
| `npm run typecheck` (`tsc -b`) | clean |
| `npm test` (vitest, all files) | 191 files, 1422 tests passed |
| `npm run build` | clean |

Note: the daemon suite needs `RUST_MIN_STACK` on this machine; without it two `fix39_p5_tests` async tests overflow the 2 MiB test-thread stack on a clean tree as well. `cargo test -p bloblex-desktop --lib` also needs a staged daemon binary (`npm run stage:daemon`) and a built `apps/desktop/dist`.

New tests: `experiments::tests::title_follows_the_first_intent_of_awkward_prompts`, `phase2a_tests::awkward_first_prompts_get_a_useful_title`, `phase2a_tests::sent_images_are_served_only_from_their_own_message`, `phase2a_tests::model_confirmation_is_asked_only_when_context_can_be_lost`, `tests::snapshot_agents_carry_the_permission_mode_and_its_effective_value`; `ComposerControls.mounted` (permission mapping, restore on failure, thumbnails, viewer focus, placeholder, retry, 24 px target, popover CSS), `SessionExecutionControls.mounted` (warning rule, empty-chat first choice, daemon-requested confirmation), `PromptQueue.mounted` (`ComposerStatus`), `App.agent.mounted` (queue chip and expansion, failed pending row with retry and edit).

## Native run (Windows dev shell, private dev database)

`npm run desktop:dev` from `D:\gogo1` with the WebView2 debugging port; driven with the repository's CDP script.

Exercised in the running app: reload and restart with Full access (`01`), the permission menu and confirmation (`02`, `03`), attaching an image and the remove control focused by keyboard at 24 px (`04`), the effort popover with six levels (`05`), the queue collapsed and expanded (`06`, `07`), a model switch mid-conversation (`08`), a sent image after reload, its viewer and its missing-file placeholder (`09`, `10`, `11`), a real Claude turn with an image and the busy status row (`12`), and two auto-titles (`hi` → “Quick hello”; a code-first prompt → “Make the export button work”).

Started but not finished in the native run: the failed pending row (no way to make the provider refuse on demand in a healthy dev install) and the queue while a turn is busy (Claude answered in about two seconds; the queue rows were produced through `session.queue.add` instead).

## Owner decisions

- A same-provider model change with existing context still warns: the daemon starts a new provider session for *any* model change, so the warning follows the real consequence rather than the provider name. If the owner prefers no warning for same-provider changes, the predicate in `modelChangeNeedsWarning` and the daemon's `context_at_risk` are the two places to change together.
- `SendLaterControl` is not mounted anywhere in the app today, so “Send later” is unreachable in the UI. Out of scope here and not changed.

## Out of scope / residual risk

- Message images are copied per message and removed with the conversation; a conversation deleted outside the daemon (a backup restore or a manual database edit) can leave files in `<data>/message-images`.
- The thumbnail is a data URL held in component state; a very long transcript with many images costs memory, as before with task images.
- The composer's status row is reserved (22 px) in every state to avoid layout shift, so an idle composer is slightly taller than before.
