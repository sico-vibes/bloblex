# FIX36 D1 follow-up: old databases must still migrate

> **What this is:** Follow-up note for FIX36 D1: old databases must still migrate.
> **Status:** historical
> **Last updated:** 2026-10-17

Follow-up to `docs/history/fix-36/d1-manager-spec.md` in this worktree; your D1 work is already here (`docs/history/fix-36/d1-report.md`). **Never run `git commit`.** Keep context small: grep and read only the ranges you need.

The Director ran the full workspace tests and 4 `bloblex-storage` tests fail with your change:

- `pricing_override_removal_tests::v7_integer_minor_rate_overrides_migrate_losslessly_to_decimal_strings` (panics near `crates/bloblex-storage/src/lib.rs:5068`)
- `tests::outfit_migration_from_six_backs_up_and_defaults_existing_records` (~5697)
- `tests::migration_3_to_4_preserves_rows_seeds_default_and_is_idempotent` (~5408)
- `tests::migration_2_to_3_seeds_gates_preserves_operator_values_and_reopens_without_backup_or_sidecars` (~5838)

They open databases at old schema versions. Most likely an agents query now selects `system_role` (or the manager marker migration runs) before the column exists on those paths, or before `ensure_team_schema`.

1. For each, run `cargo test -p bloblex-storage <test_name> 2>&1 | tail -30` to see the panic.
2. Fix the ordering so old databases migrate cleanly: the column and index must exist before any query uses them, and the leader-clearing marker migration must run after the agents table has its columns.
3. Run `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast 2>&1 | grep -E "test result|FAILED|panicked"` and **wait for it to finish** before reporting. Run `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`.
4. Update `docs/history/fix-36/d1-report.md` with the fix and the full gate result. Delete any stray test-output files you created in the worktree root.
