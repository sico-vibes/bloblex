# Fix 1A continuation: finish the dictation work (previous run stopped early)

> **What this is:** Instructions to finish the Fix 1A dictation work after an earlier run stopped early.
> **Status:** historical
> **Last updated:** 2026-10-13

Read `docs/history/fix-01/dictation-spec.md` first; it still governs scope and the security rules. The previous run already did Task A and part of Task C. **Run `git diff` first** and continue from that state; do not redo finished work.

## What is established (do not re-run the probe)
- The live probe returned HTTP 403, `cf-mitigated: challenge`, `server: cloudflare`, an HTML body of ~11 KB (not JSON). Auth was fine: `authMode=chatgpt`, account id present, token not expired. So "verification required" is a **Cloudflare managed challenge** that this private endpoint returns to non-browser clients. It cannot be fixed on our side without impersonating another client or solving the challenge, which we will not do.
- Task B result: the installed Codex app-server (0.162.1) exposes no plain transcription request; only `thread/realtime/*` notifications (a voice conversation with the agent), which is a different feature and must not be repurposed for dictation.

## Hard rules for this run (the previous run died on these)
- **Use only relative paths from the worktree root** in every tool call (e.g. `crates/bloblex-speech/src/cloud.rs`). Never type an absolute path, never `cd` out of the worktree, never read, list or `cat` anything under `D:/b-p7` or any other directory outside the worktree, and do not use `subst`. A tool call that touches an outside path is auto-rejected and ends your run.
- Do **not** run `cargo check -p bloblex-desktop` (the apostrophe in the checkout path breaks that crate's build script). The Director will check the desktop crate from a plain path. Keep `apps/desktop/src-tauri/src/speech.rs` edits small, and re-read your own diff of it carefully because it will not be compiled by you.
- Do not touch `apps/desktop/src-tauri/gen/**`.
- `CARGO_TARGET_DIR=D:/b-p7 cargo test -p bloblex-speech` is the only build gate (setting that environment variable is allowed; it does not read the directory).

## Finish
1. Review the current `cloud.rs` / `speech.rs` diff against Task C items 1-4 of the spec; complete anything missing (tests with an injected clock for the cool-down, distinct display strings per failure class, the `both_engines_unavailable` code surfaced in `speech.rs` as the one error the UI can map, `cloud_cooldown` in the engine event reason). Keep `EnginePreference::Cloud` semantics: an explicit cloud choice still tries the cloud (with on-device fallback), only `Automatic` honours the cool-down.
2. Write `docs/evidence/cloud-dictation-diagnosis-2026-10-13.md` with: the probe output (allowed fields only, as above), Task B result, the confirmed root cause, what was ruled out, and a "Not verified" list.
3. Run `CARGO_TARGET_DIR=D:/b-p7 cargo test -p bloblex-speech` and paste the real summary line.
4. Final report as in the spec (plain text, last message): files changed, root cause in one paragraph, tests added by exact name, gate output, unverified items.
