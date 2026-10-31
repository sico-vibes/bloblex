# Brief: Phase 2, images from any path

Owner request, 31 October 2026: "Start Phase 2". Source: `docs/plans/expansion-plan-v3.md`, Phase 2. The plan's description of OpenCode is wrong in one important way; this brief replaces it (see Evidence).

**Lanes.** Backend: Gogo (OpenCode Go DeepSeek V4.1 Flash, high), in its own worktree. Frontend: the Director, building against this contract in the main checkout. Keep the contract exactly; if something can't work as written, pick the smallest change and say so.

**Rule:** "omitted" and explicit `null` are the same unless an item says otherwise.

## Evidence (read from the installed tools, 31 October 2026)

**OpenCode 2.2.2** (from its binary). The tool `experimental_image_generate` is offered "while a connected provider has an image model".
- It returns **at once**, before the image exists. Its output is `{id, path, model}`, where **`path` has no extension**, and its text says "It will be saved as <path> with the extension of its real format (.png, .jpg, .webp or .gif); the notice gives the exact path."
- `path` is the agent's chosen path without its extension, else `<tmp>/images/<sessionID>/image_<random>`. So it can be anywhere.
- The file is written later, in the background, up to 30 minutes on. Completion is a **synthetic session notice** with metadata `{source:"experimental_image_generate", jobID, state, path}` and text "Image request finished. Saved image: <file> (<model>)". Whether that notice reaches an ACP client, and in what form, is **unknown**.
- Input images are capped at 20 MiB, and formats are PNG, JPEG, WebP and GIF.

**Codex 0.165** (app-server schema). A thread item `{type:"imageGeneration", id, status, result, revisedPrompt?, savedPath?, failure?, transparentBackground?}`. `result` is the image as **base64**, and `savedPath` is optional.
- Today `map_notification`'s default arm turns unknown items into `ToolCompleted { raw: i.clone() }`, so the whole base64 image would be stored in the tool row. That must not happen.
- A raw `image_generation_call` response item also exists. Use the thread item, and make sure the raw one stores no base64 either.

**Claude Code** has no image tool. The image skill's files land in the project and already preview through the project-folder rule, so no skill mapping is needed.

## 1. The generated-media record

New table `generated_media(id, session_id, turn_id NULL, provider, tool_call_id, stem NULL, path NULL, status, name NULL, bytes NULL, media_type NULL, detail NULL, created_at, updated_at)`. `status` is `pending`, `ready` or `failed`. Deleted with its session (not the file on disk).

New event in `AgentEvent`: `ImageRequested { tool_call_id, stem: Option<String>, saved_path: Option<String>, inline_base64: Option<String>, failure: Option<String> }`. `inline_base64` never goes into the event log, tool rows, messages or logs: strip it before anything stores or forwards the event.

## 2. OpenCode (ACP adapter)

- When a `tool_call` or `tool_call_update` names `experimental_image_generate`, and only that tool, read `path` from its structured output (`rawOutput`; find the exact shape). Emit `ImageRequested` with `stem`, once per call id. A tool of any other name that prints "Saved image:" is ignored: that's how a bot could otherwise name any file.
- `stem` must be an absolute path. Otherwise record nothing, and leave the tool row as it is.
- If a synthetic notice does reach ACP with metadata source `experimental_image_generate`, use its exact file or failure. Don't depend on it.
- Between turns: the file can arrive after the turn ends, so nothing here may depend on an active turn.

**Find out what ACP really sends.** Use `crates/bloblex-adapter-acp/src/bin/fake_acp_peer.rs` for tests. For evidence, check with `opencode models --verbose` whether any connected provider has an image model. If a free one exists, do one real run through ACP and record the exact messages in your report, with no secrets. If only paid ones exist, or none, don't spend anything: say so, and I'll ask the owner.

## 3. Codex

In `map_notification`, `item/completed` with `type:"imageGeneration"`: emit `ImageRequested` with `saved_path` when present, else `inline_base64` from `result`, and `failure` when it failed, using `id` as the call id. It must not reach the default arm. Also handle `item/started` for it so the transcript shows it as pending. Make sure `result` isn't stored by any other path, including `rawResponseItem/completed`.

## 4. The daemon

On `ImageRequested`, in order:
- **Already saved (`saved_path`):** absolute, checked as in section 5, then `ready`.
- **Inline (`inline_base64`):** decode, cap at 20 MiB, find the type by content, write to `<data>/generated/<session id>/<media id>.<ext>`, then `ready`. Refuse anything that isn't one of the four types.
- **Expected (`stem`):** `pending`. One background sweep every 2 seconds looks at pending rows, trying `<stem>.png`, `.jpg`, `.webp`, `.gif`. A file counts when it is a regular file, not a symlink, modified at or after the request (allowing 5 seconds of clock slack), passes the content check and has the same size on two sweeps in a row. Then `ready`. After 35 minutes: `failed`, detail "The image didn't arrive."
- **Failed (`failure`):** `failed`, with a one-line redacted reason.

The sweep lives in the daemon, is cheap when nothing is pending, stops on shutdown and survives a restart, since the rows are stored. Deleting a conversation drops its rows. A row is for one conversation only.

**Transcript.** Each record has one message with **`id` equal to the media id**, role `notice`, updated in place: `meta: {kind:"generated_image", mediaId, status, name, bytes, mediaType, provider, detail}`. **`meta` carries no path.** Text: `Generating an image…`, `Generated an image: <name>` or `The image couldn't be generated: <detail>`. On every change emit `session.changed`, and `media.generated {sessionId, mediaId, status}` with no path. It appears for a turn that has ended too, and must not change the session's state or wake a turn.

**The agent.** Don't send it anything new: OpenCode tells it by itself, and Codex includes it in the item.

## 5. `media.preview`

Add a new parameter: **`media.preview {sessionId, mediaId}`**, used instead of `path`. Both `path` and `mediaId` is `invalid_argument`. With `path`, nothing changes at all: the project-folder rule stands, and a path outside the folder stays refused, even if it's a generated file's path.

With `mediaId`:
- The row must belong to `sessionId` and be `ready`, else status `unavailable`.
- Only the exact path stored on that row is read. The caller gives no path.
- Refuse a symlinked leaf. Require a regular file, not empty, at most 20 MiB (`tooLarge`).
- Only `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, with `image_matches` on the bytes. No SVG: it can carry scripts.
- A file that's gone gives `unavailable` "That file is no longer there."
- The reply has the usual fields with `kind:"image"`, `relativePath: null`, and `name` as the file name only. **It never contains the folder.**

`media.preview` stays `never` for remote devices, and message text and `meta` hold no path, so there is nothing to redact. Test that a generated-image message crossing `redact_event` carries no path.

**Open the folder.** New **`media.reveal {sessionId, mediaId}`**: for a `ready` row, opens the file's folder with the file selected (`explorer /select,<path>`), with no shell. Row class `never` in `tiers.json`. Not on the MCP.

## 6. Capability

`runtime.capabilities` gains `generatesImages: boolean`. Codex: true. Claude: false. OpenCode: true when its catalog shows a connected provider with an image model. If there's no reliable signal, say what you found and use false; a wrong "true" offers something that will fail. Keep the catalog's cost and caching as they are.

## 7. MCP

`read_conversation` already shows notices. Add `mediaId` and `status` for these, with no path and no image bytes.

## Tests

`opencode_image_tool_records_a_pending_image_from_its_output`, `only_the_image_tool_can_name_an_image`, `a_relative_stem_records_nothing`, `the_sweep_finds_the_file_when_it_appears`, `the_sweep_waits_for_a_stable_size`, `the_sweep_ignores_an_old_file_at_that_path`, `the_sweep_fails_a_request_after_35_minutes`, `pending_images_survive_a_restart`, `an_image_arriving_after_the_turn_changes_no_session_state`, `codex_image_item_with_saved_path_is_ready`, `codex_inline_image_is_written_to_the_data_folder`, `codex_inline_base64_is_stored_nowhere`, `codex_failed_image_reports_the_reason`, `preview_by_media_id_reads_only_that_rows_exact_file`, `preview_by_path_still_refuses_a_generated_file_outside_the_project`, `preview_refuses_another_conversations_media`, `preview_refuses_svg_a_symlink_and_a_mislabelled_file`, `preview_never_returns_the_folder`, `generated_image_message_carries_no_path`, `media_reveal_needs_a_ready_row`, `deleting_a_conversation_drops_its_media_rows_and_keeps_the_file`.

## Rules

- Never run `git commit`, `git push`, `git merge` or switch branches. Change nothing outside your worktree. Don't run `npm install`.
- No credentials, message text, image bytes or base64 in logs. Paths in logs are not allowed either. Keep `every_daemon_log_call_site_is_a_fixed_message` true.
- Every new RPC and event gets a `tiers.json` row (`never`, `drop`). The parity tests must pass.
- Don't edit the skill files: put proposed text in your report. Do update `docs/ipc-contract.md`.
- `crates/bloblex-storage/src/lib.rs` contains one NUL byte: edit it only with your edit tool. No shell heredocs for anything with backslashes. New storage functions can go in `crates/bloblex-storage/src/phase1b.rs` or a new module.
- Another lane is changing `request()` in `crates/bloblex-adapter-acp/src/lib.rs` to remove a 30-minute timer. Don't touch that function.

## Gates

From PowerShell in your worktree, with `BITBOTS_HOOK_BRIDGE` and `BITBOTS_REMOTE_WEB_DIR` removed for the session:
- `$env:RUST_MIN_STACK='33554432'; cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
- `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings`

Send output to a log file and read the summary lines. Known flaky test: `a_crash_after_a_finished_turn_does_not_fail_that_session`.

## Report

Files changed; item by item; every contract change with its reason; what ACP really sent and how you know; new test names and any existing test you changed; the exact gate output tails; what you could not verify; proposed skill text.
