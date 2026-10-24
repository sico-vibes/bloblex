# Brief: daemon support for the Haze look and per-bot icons (backend lane)

You are the backend lane (OpenCode, DeepSeek). The owner chose a new primary look called **Haze**. In Haze, bots show no mascot: each bot shows its runtime's logo (in original colours, tinted with the bot colour, or monochrome) or a small pixel-art icon the owner picks. The UI is written by the Director in the main checkout; your job is only the daemon side so these values are accepted and stored.

Work in this worktree (`D:\fx70`, branch `haze/backend`). **Never run `git commit`, `git push`, `git reset`, `git stash` or switch branches.** Keep tool output small. Keep a short work log in `D:\fx70\lane-log.md` as you go.

## 1. Accept `haze` for `appearance.style`

Today only `bitbots` and `blobots` are accepted.

- `crates/bloblex-daemon/src/main.rs:1381`: the `appearance.style` check. Accept `"haze"` too; update the error message to "appearance.style must be haze, bitbots or blobots".
- `crates/bloblex-storage/src/lib.rs:1458`: `validate_setting_value`, same change.
- Leave the retired-look migration (`lib.rs:1673`, `backup.rs:756`) mapping `legacy`, `pop`, `dot` to `bitbots` exactly as it is. `haze` must survive a backup export and import unchanged (`backup.rs` `SETTING_ALLOWLIST` already lists the key; check `exportable_setting` accepts the value).
- Tests: extend `lib.rs:6385` (the accepted styles loop) and the daemon test near `main.rs:8852` (`for style in ["bitbots", "blobots"]`) to include `haze`. Add a backup round-trip assertion that `haze` is kept, next to the existing backup tests in `backup.rs`.

## 2. Accept the `icon` look key

`valid_look` in `crates/bloblex-storage/src/lib.rs:6040` rejects any look key not in `["shape","seed","traits","bot","art","paint"]`. Add an optional `icon` key:

- Allowed values (a `const ICONS: [&str; 19]`), or `null`:
  `logo`, `logo-tint`, `logo-mono`, `px-robot`, `px-cat`, `px-ghost`, `px-alien`, `px-fox`, `px-frog`, `px-owl`, `px-bunny`, `px-bear`, `px-octopus`, `px-mushroom`, `px-slime`, `px-wizard`, `px-duck`, `px-rocket`, `px-bolt`.
- Anything else (another string, a number, an object) makes the look invalid, like `art` and `paint` today.
- Test: add `valid_look_accepts_only_known_icons` next to `valid_look_accepts_only_known_art_and_paint` (`lib.rs:8652`): every value above passes, `null` passes, `"px-unknown"` and `7` fail.
- Search the daemon for other places that list the look keys or describe the look to the Manager (for example the Manager's tool schema in `crates/bloblex-daemon/src/team.rs`, look for `"paint"` or `robot-pop`). Where the look's fields are described, add `icon` with the same value list and the description "Haze look: the bot's mark. logo, logo-tint and logo-mono show the runtime's logo in its own colours, the bot colour or one colour; px-* are pixel icons.". If a JSON schema enumerates `art` values, enumerate `icon` the same way.

## 3. Nothing else

Do not change any file under `apps/`. Do not change the migration of retired looks. Do not reformat unrelated code (these files use long, dense lines; match them).

## Gates (run from `D:\fx70`, report the tail of each)

```
cargo fmt --all -- --check
cargo clippy -p bloblex-storage -p bloblex-daemon --all-targets -- -D warnings
cargo test -p bloblex-storage
cargo test -p bloblex-daemon
```

Use a separate target directory so you do not fight the main checkout: set `CARGO_TARGET_DIR=D:\fx70\target` for every cargo command. If a daemon test fails, run it alone before calling it real; full runs under load produce timeouts.

## Report

Write `D:\fx70\report.md`: what you changed per item with `path:line`, the gate tails, anything you decided that this brief did not specify, and anything you could not verify.
