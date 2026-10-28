# Haze character avatars

26 October 2026

The Haze Look editor now offers 29 full-colour character portraits alongside runtime logos and pixel icons. The set is the corrected 28 eligible generated portraits plus Kratos. Lara Croft and Samus Aran are excluded. Character choices persist in `look.icon`; Frost and Stone continue to render their own art and the saved portrait returns when switching back to Haze.

Each portrait has a static SVG for picker cells and small marks, plus an animated SVG for larger marks. Vite bundles both through eager `?url` asset globs. SVGs render through `img` so their internal animation styles do not enter the document stylesheet. Original portrait colours are retained; the Haze status aura still uses the bot colour.

Storage `valid_look`, the Manager schema and proposal schema accept the same 29 ids. TypeScript tests compare the catalog against the Rust allowlist, exercise normalization, URL inclusion, small/large rendering, Haze-only rendering, locked choices and provider-null keyboard navigation.

Focused verification passed: 26 Vitest tests across `src/blob/haze/haze.test.ts`, `src/blob/haze/HazeMark.test.tsx` and `src/ui/LookEditor.mounted.test.tsx`; `npm run typecheck`; `cargo test -p bloblex-storage valid_look_accepts_only_known_icons --lib` (1 passed). Web and remote production builds, daemon/hook build, and the native review build all passed. An independent hash check confirmed all 58 SVG assets in both production bundles match the approved source files. Logs and audit records are under `D:/bitbots-haze-integration-2026-10-26/`.

The review application is running from `D:/bitbots-review46/Bitbots Review.exe` (process 62028, title `Bitbots Review · Haze avatars`), with its rebuilt daemon child. Relaunch using `D:/bitbots-review46/Run Bitbots Review.cmd` so the copied database at `local-data/Bitbots/bloblex.db` is used. The copy has unattended work paused. The installed app was not stopped or replaced. No UI sweep or full test suite was run, following the owner's instruction; the owner tests the native picker in the review app. Nothing was committed or published.
