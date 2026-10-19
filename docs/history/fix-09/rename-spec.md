# FIX9: rename the product from Bloblex to Bitbots

> **What this is:** Spec for FIX9: renaming the product from Bloblex to Bitbots.
> **Status:** historical
> **Last updated:** 2026-10-15

Written 15 October 2026. Owner directive: the app is now called **Bitbots**. The
older pixel-robot look becomes the primary theme (also called Bitbots); the old
blob look becomes the secondary theme and is named **Blobots**. This spec covers
only the product-name rename. The theme logic is FIX10 and is done by another lane
in parallel; do not touch its files (section 4).

## 1. What changes (user-visible and documentary)

Replace the product name **Bloblex** / **bloblex** (as a product, brand or window
title) with **Bitbots** wherever a person reads it:

- UI copy in `apps/desktop/src` (labels, headings, aria-labels, tooltips, empty
  states, toasts, dialog text, onboarding text, the companion window title).
- `apps/desktop/index.html`, `preview.html`, `gallery.html`, `launch-preview.html`,
  `polish-preview.html`, `dictation-preview.html` titles.
- `apps/desktop/src-tauri/tauri.conf.json`: `productName`, window `title`.
  **Do not change `identifier`** (see 2).
- Windows installer / bundle display strings only (NSIS display name, shortcut
  text) if they are plain strings in config; no path or registry key changes.
- User-facing strings emitted by the daemon and crates (error messages, "Bloblex
  could not..." text, notifications) and the tests that assert them.
- `README.md`, `AGENTS.md` (history sections keep their original wording; only
  add nothing there), every file under `docs/` that talks about the product, and
  `docs/releases/*.md` **only** where the file is not yet published (leave the
  published beta.1..beta.28 notes and `docs/operations/release-checklist.md` history entries
  exactly as written; they are a record).
- Add a short note at the top of `README.md`: "Bitbots (formerly Bloblex)".

Keep the word **blob** (the characters, "blob" as a noun, "Blob page") as is;
that vocabulary is handled in the theme work. Only the *product name* changes.

## 2. What must NOT change (these are identifiers and would break data/upgrades)

- Cargo package and crate names (`bloblex-*`), binary names (`bloblexd`),
  `Cargo.toml` `name`, `Cargo.lock`, `tauri.conf.json` `bundle.externalBin`.
- npm package names (`bloblex`, `@bloblex/desktop`), `package-lock.json`.
- Tauri `identifier` (bundle id), the app-data directory name, SQLite file names,
  Windows registry keys, keychain/credential target names, named pipes, protocol
  names, JSON-RPC method names, environment variable names (`BLOBLEX_*`),
  localStorage/sessionStorage keys, event names, setting keys, file extensions.
- Git remote URLs, GitHub repo slug (`sico-vibes/bloblex`) and release asset URLs
  in docs that point at already-published releases.
- Rust `use bloblex_*` paths and module names.
- Anything in `node_modules`, `target`, `.git`, `dist`, lockfiles, fonts, images.

If a string is both user-visible and an identifier (for example a log target),
leave it and list it in the report.

## 3. Method

1. `git grep -il bloblex` to list files; classify each hit as product-name text
   (rename), identifier (keep) or history (keep).
2. Change case-correctly: "Bloblex" -> "Bitbots", "bloblex" in prose -> "bitbots",
   "BLOBLEX" in prose -> "BITBOTS". Never blanket-replace; review each hit in
   identifiers, paths and URLs.
3. Fix tests that assert renamed strings. Do not weaken assertions.
4. Add `docs/history/fix-09/rename-report.md` listing: files changed, the identifiers
   deliberately kept (grouped), and the user-visible strings that are also
   identifiers.

## 4. Do not touch (owned by the FIX10 lane and the Director)

`apps/desktop/src/blob/bitbots.ts`, `apps/desktop/src/ui/appearance*.ts`,
`apps/desktop/src/ui/bitbots.css`, `apps/desktop/src/ui/bitbotsUi.css`,
`apps/desktop/src/ui/FirstRunOnboarding.tsx`, `apps/desktop/src/ui/SettingsSheet.tsx`,
`apps/desktop/src/ui/StyleStep*`, `apps/desktop/src/ui/accent*`, and in
`crates/bloblex-daemon/src/main.rs` the `settings.set` handler and settings
validation. Those files get the new name from their owners.

## 5. Gates

`npm run typecheck`, `npm run test` (desktop), and
`cargo test --workspace --exclude bloblex-desktop` for the Rust crates you touched.
Known flake: `catalog_timeout_kills_the_child_and_failure_is_provider_unavailable`
passes alone. Never commit; leave the diff in the working tree.
