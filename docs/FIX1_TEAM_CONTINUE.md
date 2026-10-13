# Fix 1C continuation: finish the team/leader work (previous run stopped early)

Read `docs/FIX1_TEAM_SPEC.md` first; it still governs scope. The previous run edited `crates/bloblex-daemon/src/team.rs` (about 160 lines) and a little of `main.rs`, then died because it typed a mistyped absolute path (`...Blolblex-t-fix1-team...`, missing "wt") which the sandbox auto-rejects as an outside-directory access. **Run `git diff` first and continue from that state; do not redo finished work.**

## Hard rules for this run
- **Use only relative paths from the worktree root** in every tool call (e.g. `crates/bloblex-daemon/src/main.rs`). Never type an absolute path, never `cd` out of the worktree, never read or list anything outside it.
- Never run `git commit`, `git push`, `git checkout`, `git stash`. Leave changes uncommitted.
- Do not touch `apps/desktop/src`, the adapter crates, or `fetch_model_catalog` / `runtime_capabilities` in `main.rs` (another lane has just finished those and the Director will merge them; keep your `main.rs` hunks small and local to avoid conflicts).
- `CARGO_TARGET_DIR=D:/b-int` for every cargo command.

## Finish, in this order
1. Review the existing `team.rs` diff against spec sections 1 and 2 (tools `list_projects`, `create_blob`, `update_blob`, leader-only listing and calling, non-leader refusal text with the leader tag, `runtime_instructions` paragraphs, caps of 5 per call and 12 total, never bypass, same creation path as `agent.create`, transcript note). Complete what is missing.
2. `main.rs`: factor the body of the `agent.create` RPC arm into a function the tool can call (small hunk), and add `claude_workflows_enabled(settings)` used at every site from spec section 3. Update the old tests that assumed the old default and add the new ones.
3. `crates/bloblex-storage/src/lib.rs`: one reaction per message, spec section 4, with tests; update the daemon test `message_reaction_rpc_persists_and_broadcasts_only_scoped_user_state` accordingly.
4. Gates, real output: `CARGO_TARGET_DIR=D:/b-int cargo test -p bloblex-storage`, `CARGO_TARGET_DIR=D:/b-int cargo test -p bloblex-daemon`, then `CARGO_TARGET_DIR=D:/b-int cargo test --workspace --exclude bloblex-desktop`.
5. Final report as in the spec (plain text, last message): files changed, per-section summary with exact test names, gate output, decisions where the spec was silent, unverified items.
