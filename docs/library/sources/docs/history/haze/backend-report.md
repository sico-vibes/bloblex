# Report — daemon support for the Haze look and per-bot icons

Branch `haze/backend`, worktree `D:\fx70`. Nothing committed, pushed, reset, stashed or switched. No file under `apps/` touched. The retired-look migration (`crates/bloblex-storage/src/lib.rs` startup normalisation, `crates/bloblex-daemon/src/backup.rs:756`) is unchanged and still maps `legacy`/`pop`/`dot` to `bitbots`.

## 1. `haze` accepted for `appearance.style`

- `crates/bloblex-daemon/src/main.rs:1381` — `validate_setting` accepts `haze` and the message is now `"appearance.style must be haze, bitbots or blobots"`.
- `crates/bloblex-storage/src/lib.rs:1458` — `validate_setting_value` accepts `haze` (the same list, used by `settings.set` and by the backup importer).
- Tests: the accepted-styles loop in `crates/bloblex-storage/src/lib.rs:6387` (`appearance_values_validate`) and the daemon loop at `crates/bloblex-daemon/src/main.rs:8852` now include `haze`; the retired values are still refused by the existing `for retired in ["legacy", "pop", "dot"]` assertion below it.
- Backup: `exportable_setting` (`backup.rs:143`) already admits any `appearance.style` string and the key is on `SETTING_ALLOWLIST` (`backup.rs:46`), so export keeps it; import re-checks it with `crate::validate_setting` (`backup.rs:760`), which now accepts it.
  - `crates/bloblex-daemon/src/backup.rs:921` — new test `haze_style_survives_a_document_round_trip`: builds a document with `appearance.style: "haze"`, checks the envelope, then asserts the import's two filters (`exportable_setting`, `crate::validate_setting`) keep the value unchanged.
  - `crates/bloblex-daemon/src/main.rs:10746` and `:10808` — the existing full export → preview → import round trip now sets `appearance.style` to `haze` on the source and asserts the restored settings still say `haze`. This is the end-to-end evidence (the unit test in `backup.rs` can only exercise the document and filters, because the full importer needs an `AppState` and lives in `main.rs`'s test module).

## 2. Optional `icon` look key

- `crates/bloblex-storage/src/lib.rs:6044` — `const ICONS: [&str; 19]` with `logo`, `logo-tint`, `logo-mono`, `px-robot`, `px-cat`, `px-ghost`, `px-alien`, `px-fox`, `px-frog`, `px-owl`, `px-bunny`, `px-bear`, `px-octopus`, `px-mushroom`, `px-slime`, `px-wizard`, `px-duck`, `px-rocket`, `px-bolt`.
- `crates/bloblex-storage/src/lib.rs:6046` — `icon` added to the allowed top-level look keys; `:6049` — `null` or one of `ICONS` only, so another string, a number or an object invalidates the look exactly like `art`/`paint`. The doc comment at `:6038` mentions the Haze mark.
- Test: `crates/bloblex-storage/src/lib.rs:8669` `valid_look_accepts_only_known_icons` — all 19 values pass, `null` passes, `art` + `icon` together pass, `"px-unknown"` and `7` fail.
- Manager descriptions:
  - `crates/bloblex-daemon/src/team.rs:966` (update_blob / add_blob tool schema): `optional icon (…)` added with the same value list, and the brief's Haze sentence appended after the existing description.
  - `crates/bloblex-daemon/src/proposals.rs:69` (`propose_bot` look property): the icon list and the same Haze sentence added. This description only summarised the look ("shape, seed, traits, bot") and did not enumerate art or paint, so the brief's "where the look's fields are described" was read as covering it. Neither schema enumerates `art` as a JSON enum, so no `enum`/`items` schema was added; `art`, `paint` and `icon` stay free strings that the storage layer validates.

## Gates (from `D:\fx70`, `CARGO_TARGET_DIR=D:\fx70\target`)

1. `cargo fmt --all -- --check` — **fails, and already failed before this lane.** Tail: 3,769 `Diff in` blocks now; a `git archive HEAD` copy of `f091ff7` in a temp directory reports 3,766, in files this lane never touched (`bloblex-wsl`, `bloblex-speech`, `bloblex-process`, `cron.rs`, `tasks.rs`, `team.rs`). The repository is deliberately not rustfmt-formatted (dense long lines), so I matched the surrounding style instead of reformatting ~9,000 lines. The three extra blocks are the long `haze` lines I added, in the same style as their neighbours.
2. `cargo clippy -p bloblex-storage -p bloblex-daemon --all-targets -- -D warnings` — **passed.** Tail: `Checking bloblex-daemon v0.1.0-beta.36 (D:\fx70\crates\bloblex-daemon)` / `Finished dev profile [unoptimized + debuginfo] target(s) in 1m 00s`.
3. `cargo test -p bloblex-storage` — **passed.** Tail: `test result: ok. 127 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 7.97s` (plus the empty doc-test run).
4. `cargo test -p bloblex-daemon` — **passed with `RUST_MIN_STACK=16777216`.** Tail: `test result: ok. 465 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 20.85s`, then `1 passed`, `2 passed`, `2 passed` for the integration binaries. Without that variable the run aborts with `STATUS_STACK_OVERFLOW` (0xc00000fd) in `fix39_p5_tests::row_agent_lock_set_unlocks_and_refuses_the_manager`. I proved this is pre-existing: I copied the four edited daemon files aside, restored their `HEAD` contents, and `row_manager_update_blob_refuses_a_locked_bot` overflowed identically; with the files restored and `RUST_MIN_STACK` set it passes. The two tests are unrelated to looks (bot lock, Manager).

## Decisions the brief did not specify

- `proposals.rs:69` (`propose_bot`) also got the icon list and Haze sentence, as described above; the brief only named `team.rs` as the example.
- The Haze sentence was appended inside the existing `look` description rather than replacing it, so the Manager still knows about `shape`/`seed`/`traits`/`art`/`paint`/`bot`.
- The `backup.rs` unit test asserts the document and both import filters rather than a full import, because the full importer needs `AppState` from `main.rs`'s test module; the true round trip is asserted in `main.rs:10808` instead (see item 1).
- I did not run `cargo fmt` on any file, and did not alter the retired-look migration.
- Skill updates (mandated by `AGENTS.md`): two dated lessons in `.claude/skills/bitbots-development/references/lessons.md` (fmt gate fails at baseline; daemon test stack overflow and `RUST_MIN_STACK`), an `icon` mention in the existing "look keys are allowlisted" lesson, and the Haze mark added to `.claude/skills/bitbots-development/references/recipes.md` (with the look paragraph naming Haze).

## Not verified

- No UI/browser-preview or installed-app check: this lane is daemon-only, and `apps/` was not touched. The Director's UI work still has to render `haze` and the icons.
- No real backup file was exported to disk and re-imported through the Tauri UI; the round trip is exercised in-process by the daemon tests only.
- Nothing in `docs/library/` or the design documents was updated (documentation is a separate lane); the Haze/`icon` facts are recorded in the skill only.
