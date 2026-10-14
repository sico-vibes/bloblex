# FIX4: bring `cargo clippy` back to clean (queued, run after beta.24)

Written 14 October 2026. Backend only. **Do not start before beta.24 is
released**: it touches many crates and must not tangle with FIX2/FIX3.

## 1. Why

`cargo clippy --workspace --exclude bloblex-desktop --all-targets` reports about
70 findings on Rust 1.99 / clippy 0.1.99. The project was already not clean on
older toolchains (see `docs/IMPROVEMENT_PHASE_1B_SPEC.md`: "already failing on the
base commit"), and a newer clippy has added more. No release gates on it today.

## 2. Rules

- **No behavior change.** This is a lint cleanup. The full workspace test suite
  is the safety net and must be unchanged: same tests, same results.
- Do not reformat. `cargo fmt --check` fails on HEAD; leave formatting alone so
  the diff stays reviewable.
- Do not refactor structure to satisfy a lint. For `too_many_arguments`,
  `type_complexity` and `result_large_err`, add a targeted
  `#[allow(clippy::...)]` on the item with a one-line reason comment. Never a
  crate-wide `#![allow]`.
- Prefer `cargo clippy --fix` for the mechanical set, then read every hunk.
- Each deprecated or semantic suggestion needs a human look, not a blind apply:
  - `fetch_update` → `try_update` (check the closure's return type).
  - `chunks_exact(N)` → `as_chunks::<N>()` (confirm remainder handling is
    unchanged; `chunks_exact` drops the remainder, `as_chunks().0` does too).
  - `unwrap` after `is_some` → `if let` (keep the same fallthrough).
  - `assert_eq!(x, true)` → `assert!(x)`.
- Test code is in scope. Test binaries (`fake_*`) too.
- Out of scope: `apps/`, `Cargo.toml` dependency changes, any
  `rust-toolchain.toml` (the owner decides that separately).

## 3. Method

1. Baseline: save the exact list (`--message-format short`) to a scratch file.
2. Apply mechanical fixes crate by crate; run that crate's tests after each.
3. Add the `#[allow]`s for structure lints with reasons.
4. Re-run clippy; the target is **zero findings** under
   `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings`.
   If a finding genuinely cannot be fixed without a behavior change, leave a
   targeted `#[allow]` and list it in the report; do not guess.

## 4. Gates

```
cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings
cargo test --workspace --exclude bloblex-desktop      # RUST_MIN_STACK=33554432
```

Report: findings before and after by lint name, files changed, every `#[allow]`
added with its reason, and any test whose result changed (there should be none).

## 5. Review (Director)

Read the whole diff. Spot-check the semantic suggestions above. Run the desktop
crate's library tests too, since `bloblex-desktop` shares workspace crates.

## 6. Execution order (14 October 2026, owner said go)

FIX5 (`docs/FIX5_OPENCODE2_PER_MODEL_EFFORT_SPEC.md`) is running at the same time
and owns `crates/bloblex-adapter-acp` and the daemon. To avoid conflicts this is
run in two parts:

- **Part 1 (now):** every workspace crate EXCEPT `bloblex-adapter-acp` and
  `bloblex-daemon`. The gate is the clippy command from section 4 with
  `--exclude bloblex-adapter-acp --exclude bloblex-daemon`... but clippy lints
  dependencies of the selected crates too, so judge "zero findings" per crate:
  `cargo clippy -p <crate> --no-deps --all-targets -- -D warnings` for each crate in part 1.
- **Part 2 (after FIX5 is merged):** `bloblex-adapter-acp` and `bloblex-daemon`.
