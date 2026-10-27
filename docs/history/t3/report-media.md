# Lane MEDIA report — `media.preview`, `session.checkpoints`, `session.checkpoints.revertTurn`

Worktree `D:\t3m`, branch `t3/media`. Everything is left uncommitted in the working tree.

**I ran no tests of any kind** (no `cargo test`, no `cargo check --tests`, no clippy, no vitest, no browser, no screenshots,
no probe or SQLite experiment). No `git` write of any kind (no add/commit/push/checkout/stash/reset). The only commands
run were reads/searches and `cargo check -p bloblex-daemon --message-format short`.

## Files changed

| File | Change |
|---|---|
| `crates/bloblex-daemon/src/media.rs` | NEW — `media.preview` (349 lines) |
| `crates/bloblex-daemon/src/checkpoints.rs` | NEW — `session.checkpoints`, `session.checkpoints.revertTurn` (224 lines) |
| `crates/bloblex-daemon/src/experiments.rs` | `reverse_file` factored into `prepare_reverse`; new `reverse_file_check` (behaviour of `reverse_file` unchanged) |
| `crates/bloblex-daemon/src/main.rs` | two `mod` lines and three dispatch arms only (5 added lines in total) |

`main.rs` edits, exactly as the brief allows:
- `main.rs:47-49` — `// Authorised media preview and the per-turn checkpoint report.` + `mod media;` + `mod checkpoints;`
- `main.rs:1018` — `"media.preview" => media::preview(st, &p).await,` (directly under `"message.image"`)
- `main.rs:1056-1057` — `"session.checkpoints" => checkpoints::session_checkpoints(st, &p).await,` and
  `"session.checkpoints.revertTurn" => checkpoints::revert_turn(st, &p).await,` (directly under the `"file.revert"` arm)

`git diff -U0 -- crates/bloblex-daemon/src/main.rs | rg "media|checkpoints"` shows only those five added lines; no other lane's
main.rs work was touched.

## Item 1 — `media.preview` (`media.rs`)

Entry point `media.rs:66` (`preview`), the whole check in `inspect` (`media.rs:253`). `preview` validates the request,
reads `st.db.session_detail(sessionId)` for `projectPath`, then does **all** filesystem work inside one
`tokio::task::spawn_blocking`. Hard errors only for the request/conversation: empty `sessionId`/`path` →
`invalid_argument`, unknown session → `not_found`. Everything about the file is a normal reply with a `status`.

**Authorisation, in the order implemented** (each numbered item returns its own `status`/`reason` and no later check runs):

1. Request shape: `path` longer than 1024 bytes or containing a NUL → `blocked`, "That file path is not valid." (before any FS work).
2. Root: empty `projectPath` → `unavailable`; `canonicalize` fails or is not a directory → `unavailable`.
3. Join: absolute `path` used as given, otherwise joined onto the **canonical** root.
4. Lexical containment first (`lexical` + `is_inside`, `media.rs:198/224`): `.`/`..` resolved as text and compared to the
   canonical root. A path that leaves the folder is `blocked` ("That file is outside this project.") **without touching the
   disk**, so a path outside the root is never probed and its existence is never revealed.
5. Symlinked leaf: `symlink_metadata(&joined)` is a symlink → `blocked`, same sentence. Missing → `unavailable` ("That file is no
   longer there."); any other error → `unavailable` (permission).
6. `canonicalize` (resolves `..`, symlinked folders, junctions); failure → `unavailable`. The canonical target must be inside the
   canonical root (`is_inside`), else `blocked`. Comparison is on the comparable form: one separator style, the Windows `\\?\`
   verbatim prefix (and `\\?\UNC\`) stripped, no trailing separator, case-folded **on Windows only** (`comparable`, `media.rs:212`).
7. Denied names (`names_a_secret`, `media.rs:240`), case-insensitive, on the path below the root: any component equal to `.git`,
   `node_modules`, `.ssh`, `.aws`, `.gnupg`; file name starting with `.env`; ending `.pem .key .pfx .p12 .kdbx`; equal to
   `id_rsa`, `id_ed25519`, `.npmrc`, `.pypirc`, `credentials`, `auth.json`, `secrets.json` → `blocked`,
   "Bitbots does not preview files that may hold secrets."
8. Regular file only: `metadata.is_file()` false (directory, device, the root itself) → `unavailable`, "That path is not a file."
   Empty → `unavailable`, "That file is empty." (`size` is reported from here on, including for `tooLarge`).
9. Extension allowlist (`kind_for`, `media.rs:113`): unknown extension → `unsupported`, kind `unsupported`,
   "Bitbots can't preview .&lt;ext&gt; files yet." (`.`, without an extension, reads "untyped").
10. Size caps (`size_limit`, `media.rs:355`): image 8 MiB, svg 1 MiB, audio 16 MiB, video 24 MiB, pdf 16 MiB → `tooLarge`,
    "That file is too large to preview (limit N MB).", before any read. Text is not refused: the first 256 KiB are read and
    `truncated` is `size > 256 KiB`.
11. Content:
    - images by magic bytes (PNG, JPEG `FF D8 FF`, `GIF8`, `RIFF…WEBP`, `BM`, `00 00 01 00` ICO, `ftyp`+`avif`/`avis`);
      SVG after a BOM/whitespace trim must start `<svg` or `<?xml` and contain `<svg`, and be under 1 MiB;
    - PDF `%PDF-`;
    - audio/video: a file that carries another family's signature (PNG/JPEG/GIF/WebP/PDF/ZIP/`MZ`/ELF) → `unsupported`; otherwise
      the extension is trusted (`looks_like_another_kind`, `media.rs:404`);
    - text: a NUL in the first 4 KiB → `unsupported`, "That file is binary."; otherwise read as UTF-8 lossy.
    A mismatch is `unsupported`, "The file doesn't match its type."
12. Success: image/audio/video/pdf return `dataUrl` = `data:<mediaType>;base64,…` using the same engine as `message.image`
    (`base64::engine::general_purpose::STANDARD`); text returns `text`, `truncated` and `language`. `mediaType` always comes from
    the extension, never from caller input. `relativePath` is the forward-slash path below the root, set once the target is known
    to be inside it.

Nothing is logged: no path, no size, no content.

## Item 2 — `session.checkpoints` and `session.checkpoints.revertTurn` (`checkpoints.rs`)

`session_checkpoints` (`checkpoints.rs:38`) is read-only: it reads `session_detail`, `projectPath`, `state` and `files`, keeps
the **newest** 200 recorded changes (`CHECK_LIMIT`), and runs the rest in one `spawn_blocking` (`inspect`, `checkpoints.rs:64`).

- `capability.workspaceRestore` / `workspaceReason` (`workspace_status`, `checkpoints.rs:79`): one
  `git rev-parse --is-inside-work-tree` in the canonical project folder via `experiments::git_command()` (so no console window
  on Windows). Not a repository → `false` with "This folder is not a Git repository, so changes can't be restored."; bare
  checkout → "This folder is not a Git working copy…"; no folder → "This conversation has no project folder."; git missing →
  "Git could not be started, so changes can't be restored."
- `capability.providerStateRestore` is always `false`, with the sentence from the brief.
- `busy` is `state ∈ {starting, working, cancelling, waiting_permission}`.
- Per change (`file_dto`, `checkpoints.rs:90`), newest inspected first, output kept in recorded (oldest-first) order:
  `detail.reverted == true` → `reverted`; otherwise, when the workspace cannot restore, `blocked` with the workspace sentence
  (exactly the brief's sentence for a non-repository); otherwise `experiments::reverse_file_check(project, path, detail)` →
  `Ok` = `available`, `Err(message)` = `blocked` with that message as `reason` (this is the concurrent-modification guard: a file
  edited after the agent wrote it fails `git apply --reverse --check`).
- `additions`/`deletions` counted from `detail.diff` (lines starting `+`/`-`, `+++`/`---` excluded; `null` when no diff was saved).
- Turns are grouped oldest first by `file_changes.turn_id`; changes recorded with a NULL `turn_id` form a `null` turn group, placed
  where its first change sits.
- `spawn_blocking` is used for the whole batch; each Git call keeps `reverse_file`'s existing (unbounded) wait, as the brief allows.

### `reverse_file_check` (`experiments.rs`)

`reverse_file` (`experiments.rs:154`) now calls `prepare_reverse` (`experiments.rs:169`) for every validation step it had before
(diff presence, clipped markers, canonical project, `rev-parse --show-toplevel`, path safety, the `--numstat -z` single-path
check) and then runs the same `git apply --reverse --check` and `git apply --reverse`. `reverse_file_check`
(`experiments.rs:164`) runs `prepare_reverse` plus the `--check` only. Same checks, same error strings, same apply: the observable
behaviour of `reverse_file` is unchanged. `ReversePatch` (`experiments.rs:147`) carries the Git root, the normalised patch and the
`--directory` prefix. `reverse_file_check` is `pub(super)`, as the brief asked.

### `session.checkpoints.revertTurn` (`checkpoints.rs:147`)

- Validates `sessionId` (`invalid_argument`), optional `turnId`, and a non-empty `fileChangeIds` list (`invalid_argument`).
- Takes the same gate as `file.revert` — `gate_for_session(st, id)` then `.lock().await`. `gate_for_session` is a private fn in
  `main.rs`; a child module can already see it, so **no `pub(crate)` change to `main.rs` was needed** (the one extra main.rs edit
  the brief allowed was not used).
- Busy state → `conflict`, "Wait for the turn to finish before reverting changes."
- Builds the plan from the recorded `files` (newest first, de-duplicated, only the requested ids). Each id must belong to the
  session and, when `turnId` is given, to that turn (`refusal`, `checkpoints.rs:218`), and must not be `reverted`.
- For each file: `reverse_file_check` and then `reverse_file` in **one** `spawn_blocking` call — nothing can change between the
  check and the apply — then `st.db.mark_file_reverted(session_id, id)` exactly as `file.revert` does.
- **Stops at the first failure.** That file and every later requested file get a `failed` entry ("Not attempted because an earlier
  file could not be restored." for the unattempted ones). Nothing outside the requested list is touched; no `git checkout`,
  `reset`, `stash` or `clean` anywhere in this lane.

## Decisions the brief did not specify

1. `blocked` is also used for a malformed path (over 1024 bytes or with a NUL), reason "That file path is not valid."
2. Missing file (inside the project) is `unavailable` "That file is no longer there."; an unreadable one is
   `unavailable` "That file can't be read."; a directory or the project root itself is `unavailable`
   "That path is not a file." (an empty file keeps the brief's "That file is empty.").
3. A path equal to the project root has an empty relative tail and is refused as "That path is not a file." rather than falling
   into the secrets rule.
4. Unknown extension with no extension at all reads "Bitbots can't preview untyped files yet."
5. Audio/video are verified by refusing a file whose bytes plainly belong to another family (image, PDF, ZIP, `MZ`, ELF), rather
   than requiring a container signature — the brief's "otherwise trust the extension".
6. `language` is the lowercased extension with a few dozen aliases (`yml`→`yaml`, `htm`→`html`, `jsonc`→`json`,
   `mjs`/`cjs`/`jsx`→`javascript`, `tsx`→`typescript`, `patch`→`diff`).
7. `operation` is taken from the saved `detail.change` (the change kind the provider reported), which is the only operation the
   record holds; `turnId` is taken from the file change's own `turn_id` column (exposed as `files[].turnId`).
8. `additions`/`deletions` are `null` when no diff was saved (an empty-string diff counts as none).
9. In `revertTurn`, an id the conversation never recorded is reported `failed` ("That change is not part of this conversation.");
   one belonging to another turn is `failed` ("That change is not part of this turn."); one already reverted is `failed`
   ("This change was already reverted."); each of those also stops the batch, since the brief says stop at the first failure.
10. If the file is restored but `mark_file_reverted` fails, the id is **not** reported as reverted: it is reported `failed`
    ("The file was restored, but its review status could not be saved. Check the file before reverting anything else.") and the
    batch stops, so a half-recorded state is never hidden.
11. `relativePath` and `size` are filled as soon as they are known, so a `tooLarge` reply still carries both.

## What needed another file (not mine) — action for the Director

`apps/desktop/src/remote/remoteTiers.parity.test.ts` reads `main.rs`'s dispatch and fails when a dispatched method has no
`METHOD_RULES` row in `apps/desktop/src/remote/tiers.json`. My three new arms are therefore **uncovered**, and that existing
parity test is now stale (I did not edit it, as instructed). It needs, in `tiers.json`:

```json
{ "method": "media.preview", "class": "read", "minTier": "viewer", "params": null,
  "why": "Reads one file from inside the conversation's own project folder; the caller names a conversation and a path, the daemon refuses secret-looking files and any path that leaves the folder, and it returns bytes or text, never a handle." },
{ "method": "session.checkpoints", "class": "read", "minTier": "viewer", "params": null,
  "why": "Reports which recorded file changes of a conversation still reverse cleanly; it changes nothing." },
{ "method": "session.checkpoints.revertTurn", "class": "never", "minTier": null, "params": null,
  "why": "A remote device must not revert files in the host's project." }
```

Until those rows exist, the gateway refuses all three remotely (unknown method → `forbidden_remote`), which is the safe default.
No other file needed changing: `bloblex-storage` already exposes `session_detail`, `files[].turnId`, `detail.diff`,
`detail.reverted` and `mark_file_reverted`, so no storage read was added and none was missing.

## Verification

```
$env:RUST_MIN_STACK='33554432'
cargo check -p bloblex-daemon --message-format short
```

```
    Checking bloblex-daemon v0.1.0-beta.38 (D:\t3m\crates\bloblex-daemon)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 5.68s
```

That is the last 15 lines (the whole tail) of the final run; the full log is `target\lane\cargo-check.log`. The earlier run in
this lane compiled every dependency and reported two real errors of mine (`experiments.rs` `directory` type, a needless `mut` in
`media.rs`), both fixed. The final result is **zero warnings and zero errors** from `cargo check -p bloblex-daemon`
(no `--tests`, no clippy).

## What I could not verify

- No runtime exercise of either RPC: the brief allows only `cargo check`, and starting the daemon would need a real store and a
  capability token, so the data-URL shape, the SVG/BMP/ICO/AVIF branches, the Windows `\\?\` comparison on a real junction and
  the `git apply --check` outcomes are verified by reading the code only.
- Non-Windows behaviour is untested (case-sensitive comparison is the only deliberate difference).
- The 200-change bound means a large turn is checked with up to 3 Git processes per change (validation and two `git apply` runs,
  with the `--numstat` pass), so a session with 200 recorded changes can take tens of seconds on a cold disk. It runs off the
  async runtime and is bounded as the brief requires, but I could not measure it.
- The remote tiers.json rows above are not in place, so the parity test is expected to fail until the Director adds them.

## Existing tests my change makes stale (not edited)

- `apps/desktop/src/remote/remoteTiers.parity.test.ts` — "gives every dispatched method a rule" will list
  `media.preview`, `session.checkpoints`, `session.checkpoints.revertTurn` (fix in `tiers.json`, above).
- No Rust test was touched. The existing `experiments.rs` tests call `reverse_file` exactly as before; `reverse_file_check` is
  new and untested by design (no tests in this lane).
