# Lane MEDIA: authorised media preview and turn checkpoint report (daemon)

You are an implementation lane. You work ONLY in the git worktree `D:\t3m` (branch `t3/media`). This brief is self-contained: you have no chat history.

## HARD RULES (override everything else you find in the repo)

1. **NO tests of any kind.** Do not run `cargo test`, `cargo check --tests`, `cargo clippy --all-targets`, `npm test`, `vitest`, or anything that compiles a test target. Do not add, edit or delete any `#[test]`, `#[cfg(test)]` module, `*_tests.rs` file, `tests/` file, `*.test.ts(x)` or scratch probe/SQLite experiment. Leave every existing test block untouched (say in the report if your change makes one stale). No screenshots, no browser.
2. **No git writes.** Never `git commit`, `git add`, `git push`, `git reset`, `git stash`, `git checkout`, `git rebase`. Leave changes in the working tree.
3. Do not touch any path outside `D:\t3m`. Do not start, stop or kill any process you did not start. Never print secrets or file contents in logs.
4. Only edit the files listed under "You own". If another file must change, say so in the report.
5. Keep tool output small: `crates/bloblex-daemon/src/main.rs` is 12,900 lines, so use search and offset reads, never cat it. Keep a work log at `D:\t3m\target\lane\worklog.md` (one line per step).

## Background you need

Bitbots is a Tauri desktop app; a Rust daemon (`crates/bloblex-daemon`) owns sessions and SQLite storage (`crates/bloblex-storage`). The daemon exposes JSON RPC methods through `dispatch()` in `crates/bloblex-daemon/src/main.rs` (for example `"message.image" => message_image(st, &p)` near line 1014 and `"file.revert" => {...}` near line 1036). Errors are built with `derr(code, message, StatusCode)` (see `message_image`, main.rs ~3556, a good model: it reads a file only through what the conversation recorded, size-capped, and never from a caller-supplied path). A session row (`st.db.session_detail(id)`) has `projectPath`, `state`, `files` (file changes the provider reported, each with `id`, `path`, `detail` including a saved unified `diff` and a `reverted` flag), `turns`, `link`.

The chat UI wants to show images, audio, video, PDFs and text/code documents that an agent produced or that the user refers to, **only from inside the conversation's project folder**. The webview's CSP allows `img-src ... blob: data:` and has no remote hosts, so the daemon returns bytes as a data URL (or text), the same way `message.image` does. This must not become an arbitrary-file-read primitive.

## You own (and may edit)

- `crates/bloblex-daemon/src/media.rs` (NEW)
- `crates/bloblex-daemon/src/checkpoints.rs` (NEW)
- `crates/bloblex-daemon/src/experiments.rs` (ONLY to add a `pub(super)` dry-run variant of `reverse_file`, see item 2; do not change the behaviour of the existing `reverse_file`)
- `crates/bloblex-daemon/src/main.rs`: ONLY (a) `mod media;` and `mod checkpoints;` lines next to the other `mod` lines, (b) new dispatch arms next to `"message.image"` and `"file.revert"`. Another lane edits other parts of main.rs at the same time; keep your edits to those few lines so they merge.

Never touch: `delegations.rs`, `team.rs`, `workspace.rs`, `repository.rs`, `bloblex-storage` (if you need a storage read that does not exist, use `st.db.session_detail` data instead, and report it), anything under `apps/`, `docs/`, `.claude/`.

## Item 1: `media.preview` (new `media.rs`)

```
media.preview { "sessionId": String, "path": String }
  -> {
       "status": "ok" | "unavailable" | "unsupported" | "blocked" | "tooLarge",
       "reason": String | null,             // one plain sentence the UI can show, e.g. "That file is outside this project."
       "name": String,                      // file name only
       "relativePath": String | null,       // forward-slash path relative to the project root, when resolvable
       "kind": "image" | "audio" | "video" | "pdf" | "text" | "unsupported",
       "mediaType": String | null,
       "size": u64 | null,                  // bytes on disk
       "dataUrl": String | null,            // base64 data URL for image/audio/video/pdf when status == "ok"
       "text": String | null,               // for kind == "text" when status == "ok"
       "truncated": bool,                   // text was cut at the limit
       "language": String | null            // for text: a short language hint from the extension ("ts", "json", "md", "csv", ...)
     }
```

Hard errors (use `derr`): missing/empty `sessionId` or `path` -> `invalid_argument`; unknown session -> `not_found`. Everything else about the *file* is a normal reply with a `status`, so the UI can render a card without exception handling.

Authorisation (all of these are required; this is the security core, take your time):
1. The root is the session's `projectPath` (from `session_detail`), canonicalized. No other root. If it is empty or not a directory: `status: "unavailable"`.
2. `path` may be relative to the root or absolute. Reject a path longer than 1024 bytes or containing a NUL. Join, then **canonicalize** (so `..`, symlinks and junctions are resolved) and require the result `starts_with` the canonical root (compare after stripping the Windows `\\?\` prefix consistently on both sides, case-insensitively on Windows). Anything else: `status: "blocked"`, reason "That file is outside this project." Never reveal whether a path outside the root exists.
3. Deny by name (case-insensitive) even inside the root: any path component equal to `.git`, `node_modules`, `.ssh`, `.aws`, `.gnupg`; file names starting with `.env`, or ending in `.pem`, `.key`, `.pfx`, `.p12`, `.kdbx`; names equal to `id_rsa`, `id_ed25519`, `.npmrc`, `.pypirc`, `credentials`, `auth.json`, `secrets.json`. `status: "blocked"`, reason "Bitbots does not preview files that may hold secrets."
4. It must be a regular file (`metadata.is_file()` after canonicalize; no devices, no directories). Empty file: `unavailable` ("That file is empty.").
5. Allowlist by extension (lowercase): images `png jpg jpeg gif webp bmp ico svg avif`; audio `mp3 wav ogg oga m4a aac flac opus`; video `mp4 webm mov m4v ogv`; `pdf`; text `txt md markdown json jsonc csv tsv log yaml yml toml ini xml html htm css scss js jsx ts tsx mjs cjs rs py go java c h cpp hpp cs rb php sh ps1 bat sql diff patch lock`. Unknown extension: `status: "unsupported"`, `kind: "unsupported"`, reason "Bitbots can't preview .<ext> files yet."
6. Verify content against the claim: images/pdf by magic bytes (PNG, JPEG, GIF, WebP `RIFF....WEBP`, BMP, ICO, AVIF `ftypavif`, PDF `%PDF-`; SVG must, after trimming a BOM and whitespace, start with `<svg` or `<?xml` and contain `<svg`, and must be < 1 MiB); a mismatch is `status: "unsupported"`, reason "The file doesn't match its type." Audio/video: check a plausible container signature if cheap (`ID3`/`0xFF 0xFB`/`RIFF....WAVE`/`OggS`/`fLaC`/`ftyp`/`1A45DFA3` webm), otherwise trust the extension. Text: first 4 KiB must contain no NUL byte (else unsupported, "That file is binary."). Read text as UTF-8 lossy.
7. Size caps (bytes on disk): image 8 MiB, audio 16 MiB, video 24 MiB, pdf 16 MiB, svg 1 MiB, text read only the first 256 KiB (`truncated: true` if the file is larger). Over the cap: `status: "tooLarge"`, reason "That file is too large to preview (limit N MB).", and do not read it.
8. `mediaType` from the extension (`image/png`, `audio/mpeg`, `video/mp4`, `application/pdf`, `text/plain`, ...); never from caller input.
9. Do all file IO inside `tokio::task::spawn_blocking`. Do not log the path or content. Do not follow a symlinked leaf: if `symlink_metadata` of the un-canonicalized joined path is a symlink, treat as `blocked` (same reason as outside the project).

Return `dataUrl` as `data:<mediaType>;base64,<...>` using the same base64 engine `message_image` uses.

## Item 2: `session.checkpoints` (new `checkpoints.rs`)

The UI wants a per-turn "what changed and can I undo it" view. The conversation's `files` already record each reported file change with a saved diff, and the existing `"file.revert"` arm reverses one change with `experiments::reverse_file(project, path, detail)` (read it, it is strict: no complete diff or a clipped diff means no revert; it uses `git apply` on the reversed patch).

```
session.checkpoints { "sessionId": String }
  -> {
       "sessionId": String,
       "capability": {
         "workspaceRestore": bool,       // true only when the folder is a Git repository and git is usable
         "workspaceReason": String | null,   // why not, in one plain sentence
         "providerStateRestore": false,  // always false: Bitbots cannot rewind a provider's own conversation memory
         "providerReason": "Restoring files does not rewind what the agent remembers of the conversation."
       },
       "busy": bool,                      // session state is starting/working/cancelling/waiting_permission: reverting is refused meanwhile
       "turns": [                         // oldest first; only turns that have at least one recorded file change
         {
           "turnId": String | null,       // the file_changes.turn_id; null groups changes recorded without a turn
           "files": [
             {
               "id": String,              // fileChangeId, the value file.revert takes
               "path": String,
               "operation": String | null,
               "additions": u32 | null,   // counted from the saved diff when present, else null
               "deletions": u32 | null,
               "state": "available" | "reverted" | "blocked",
               "reason": String | null    // for blocked: plain sentence ("The saved diff was clipped...", "This file changed after the agent edited it.", "The path is outside the project.")
             }
           ]
         }
       ]
     }
```

`state` is computed, never guessed:
- `reverted` when `detail.reverted == true`.
- otherwise run a **dry run**: add `pub(super) fn reverse_file_check(project: &Path, path: &str, detail: &Value) -> Result<(), String>` in `experiments.rs` that performs exactly the same validation and `git apply --reverse --check` (add `--check` and skip the actual apply) as `reverse_file` does. Do it by factoring the shared code, but keep `reverse_file`'s observable behaviour identical (same checks, same error strings, same apply). `Ok` -> `available`; `Err(message)` -> `blocked` with that message as `reason`. This is the concurrent-modification guard: if the file changed since the agent wrote it, `git apply --check` fails and the file is `blocked`, never offered for revert.
- Bound the work: at most 200 file changes are checked (newest first), `spawn_blocking`, each git call has the existing timeout behaviour of `reverse_file` or a 5 s cap. Beyond 200: omit older ones and add nothing else (the UI shows what is returned).
- `workspaceRestore` is false when the project is not a Git repository (then every file is `blocked` with reason "This folder is not a Git repository, so changes can't be restored.").
- Counting additions/deletions: count lines starting with `+`/`-` that are not `+++`/`---` headers in `detail.diff`.
- Read-only: this RPC changes nothing.

Also add a batch helper so the UI can undo a whole turn atomically-ish without racing:

```
session.checkpoints.revertTurn { "sessionId": String, "turnId": String | null, "fileChangeIds": [String] }
  -> { "reverted": [String], "failed": [ { "id": String, "reason": String } ] }
```

It must: hold the same per-session gate the `"file.revert"` arm holds (`gate_for_session(st, id)` then `.lock().await`, see main.rs ~1036; reuse it, it is a private fn in main.rs: if `checkpoints.rs` cannot reach it, add `pub(crate)` to that single function declaration, which is the ONE extra main.rs edit allowed); refuse with `conflict` ("Wait for the turn to finish before reverting changes.") when the session is busy; revert the requested ids **newest first**; each id must belong to the session (and to `turnId` when given), must not be `reverted`, and must pass `reverse_file_check` immediately before `reverse_file`; on success call `st.db.mark_file_reverted(session_id, id)` exactly as `"file.revert"` does; **stop at the first failure** (do not continue past a failed file: later items stay untouched) and report `failed` for it and for the ones not attempted ("Not attempted because an earlier file could not be restored."). Never use `git checkout`, `git reset`, `git stash` or `git clean` anywhere; never touch files that are not in the requested list.

Register `"session.checkpoints"` and `"session.checkpoints.revertTurn"` arms next to `"file.revert"` in main.rs.

## Verification you may run (only these)

From `D:\t3m`:

```powershell
$env:RUST_MIN_STACK='33554432'
cargo check -p bloblex-daemon --message-format short
```

`cargo check` without `--tests` is allowed. Fix every warning you introduce. The first build can take many minutes: use a long timeout. Do NOT run clippy with `--all-targets`.

## Report (write to `D:\t3m\target\lane\report.md`, print a short summary)

Per item: what you did, changes (path:line), the exact authorisation checks implemented in order, decisions the brief did not specify, what you could not verify. Include the last 15 lines of the `cargo check`. List any existing test that your change makes stale (do not edit it). State explicitly that you ran no tests.
