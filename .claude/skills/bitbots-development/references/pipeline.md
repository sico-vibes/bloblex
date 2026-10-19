# Pipeline: the Director, lanes, worktrees and releases

Last reviewed: 2026-10-19. The governing rules are the top amendments in `AGENTS.md`; this file is the practical how-to. When the owner changes the arrangement, update both.

## Roles (current arrangement, FIX40 amendment of 19 October 2026)

- **Director** (the orchestrating Claude session): writes one brief per lane, reviews every diff, checks every screen (browser preview and, where it matters, the production build or installed app), sends work back until it is right, resolves merge conflicts, runs the gates, commits, merges and releases. It writes no feature code itself.
- **Mapping:** Claude Haiku maps the codebase for the briefs (read-only).
- **Implementation lanes:** Codex `gpt-6-luna` (high) and OpenCode `opencode-go/deepseek-v4.1-flash` (high), one git worktree each. Lanes **never** run `git commit`, `git push`, `git reset`, `git stash` or check out other branches.
- **Documentation:** Claude Haiku writes docs (reports, design rules, handoff, status, release notes) from the briefs, diffs and gate results.
- The owner may assign work differently at any time; their latest instruction wins.

## Writing a brief

Self-contained (the lane has no chat history): goal in the owner's words, the facts it needs with `path:line`, files it owns and files it must not touch (keep parallel lanes' files apart), exact acceptance criteria, the gates to run, and the report format (what was done per item, files changed, gate tails, decisions not specified, anything unverified). Keep briefs in `docs/history/fix-NN/` once the wave lands.

## Worktrees

```powershell
git worktree add -b <branch> D:\fxNN main      # short path: needed for native builds
New-Item -ItemType Junction -Path D:\fxNN\node_modules -Target "D:\Basem's\Coding\Blolblex\node_modules"   # or `npm ci` when the lane adds packages
```

Copy untracked reference material into a `design-reference/` folder at the worktree root, not under `src/` (it would be typechecked).

Cleanup, after review and merge (and after every release; AGENTS.md 14 October amendment): delete the junction first as a link only (`[System.IO.Directory]::Delete('D:\fxNN\node_modules')`), never recursively; then `git worktree remove --force`, `git worktree prune`, `git branch -d`. The tool refuses to delete top-level folders such as `D:\b35`; delete their contents and leave the empty folder for the owner.

## Launching lanes

**Codex (Luna 6):**

```powershell
Get-Content -Raw brief.md | codex exec -m gpt-6-luna -c model_reasoning_effort=high --sandbox workspace-write -C D:\fxNN --skip-git-repo-check --output-last-message report.md - *> lane.log
# follow-up in the same session (keeps context):
$prompt | codex exec resume <session-id or --last> -m gpt-6-luna -c model_reasoning_effort=high -c 'sandbox_mode="workspace-write"' --skip-git-repo-check -o report2.md -
```

The Windows sandbox has no network and cannot write outside the workspace (npm installs and Vite temp files through a junction fail): install dependencies for the lane, and run the full gates yourself. `--add-dir C:\Users\<user>\.cargo` lets cargo use its cache. A read-only reviewer: `--sandbox read-only`.

**OpenCode 2 (DeepSeek), verified with v2.0.32:**

```powershell
Set-Location D:\fxNN                              # there is no --dir in 2.0
opencode run -m "opencode-go/deepseek-v4.1-flash#high" --auto --title "<lane>" -f brief.md "<one-line instruction>" *> lane.log
opencode run -m "opencode-go/deepseek-v4.1-flash#high" --auto -s <session-id> "<follow-up>"   # continue
opencode session list                             # find session ids
```

`#high` is the effort (1.x's `--variant` is gone and now makes `run` print help and exit 1); `--auto` approves tool permissions, without it a non-interactive run can stop on a prompt. Use the paid `opencode-go/` model, not `opencode/deepseek-v4.1-flash-free`. Do not upgrade OpenCode while a lane runs. Tell DeepSeek lanes to keep tool output small and to keep a work log in the repo, so a stopped run can resume.

**Haiku (docs or mapping):** a Claude sub-agent with `model: haiku`; give it the same self-contained brief and forbid commits. It can consult Luna through the Codex CLI in read-only mode for a second opinion.

## Reviewing a lane's work

Read the full diff, not only the report. Check claims against the code; a lane's stated root cause can be wrong even when its fix works (FIX42). Check the UI yourself in the preview and, for loading/styling/native work, in the production build or installed app. Send concrete fixes back with measured values and file paths. When it passes, commit the reviewed work as Director (on the lane's branch, or as part of merging it) with a message that says what changed, why, and which lane did it; then run the full gates on the merged result before it lands on `main`.

## Releasing (signed beta)

1. All gates green on `main`, including clippy and the desktop crate from a short path.
2. Bump the version in `package.json`, `package-lock.json` (3 places), `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`, `Cargo.toml` and `Cargo.lock` (15 crates); release notes in `docs/releases/<version>.md` (the app shows them, and the script publishes them); commit `release: v<version>` and push.
3. Clone `main` to a short path (`git clone --branch main <checkout> D:\bNN`, `git remote set-url origin https://github.com/sico-vibes/bloblex.git`, junction `node_modules`); the script requires a clean `main` checkout.
4. The updater key must be at `%USERPROFILE%\.bloblex-release\updater.key` and `updater.pass` (never print or commit them; check `updater.key.pub` equals `plugins.updater.pubkey`). If the key is missing, stop and ask the owner; do not generate a new one.
5. `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release-windows.ps1 -Version <version>` from the clone: builds, signs the updater artifacts, creates the GitHub prerelease with the tag, uploads the installer, `.sig` and `latest.json`, and updates the `channel-beta` manifest.
6. Upload `SHA256SUMS.txt` yourself (the script does not), in the form `<sha256>  <installer name>` with a trailing newline.
7. Verify every GitHub asset digest against the local file, `channel-beta/latest.json`'s version, the staged sidecar hashes, and Authenticode status (`NotSigned` is expected).
8. Record it in `docs/operations/release-checklist.md` (Haiku), clean up the clone and lane worktrees, report the space recovered.
9. The owner decides when to release; do not publish a version they asked to hold.
