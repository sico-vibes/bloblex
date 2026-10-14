# Documentation audit (14 October 2026)

Scope: every tracked Markdown file (80 at the start of this pass) plus the three files this pass added (`docs/README.md`, `docs/OPERATING_MODEL.md`, this file). `AGENTS.md` was read and not edited. Code and config were read as evidence only; no code, config, script or package file was changed. Historical records (`docs/releases/`, `docs/evidence/`, dated status entries) were not reworded; only broken relative links were repaired, and in this pass no link inside them was broken.

Method: (1) inventory with `git ls-files`; (2) a throwaway link and path checker (outside the repo, in the session scratch directory) over relative Markdown links, anchors, backticked repo paths and `path:line` references; (3) claim checks against `Cargo.toml`, `package.json`, `tauri.conf.json`, the scripts, the daemon dispatch (`crates/bloblex-daemon/src/main.rs`, dispatch at lines 619-1090), storage, runtime and adapter sources; (4) edits limited to verified errors and status banners.

Verification levels follow [README.md](README.md): *read in full*, *claims checked*, *header and links*, *links only*.

Link checker result: before this pass 51 findings (26 broken relative links and 25 backticked path mentions). After this pass 0 broken relative links; 55 backticked path mentions remain. Those 55 are: 16 illustrative paths in this file's own method and examples; 26 inline mentions of removed UI files in `PHASE_3_SPEC.md` and `PHASE_4_SPEC.md`, kept as the historical inventory and named in their banners; 2 missing evidence references in `IMPROVEMENT_PHASE_7_SPEC.md`, named in its banner; 2 `apps/server` and `apps/connect` references in the QA draft; 5 mentions of gitignored build outputs (`apps/desktop/src-tauri/binaries/`, `apps/desktop/tsconfig.tsbuildinfo`) in `SESSION_HANDOFF.md` (2), `DIRECTOR_LOG.md` (1) and `RELEASE_CHECKLIST.md` (2); 1 in-flight FIX3 spec; and 3 references in immutable evidence files, which are backticked paths rather than links and were not edited. The checker reports line citations only as far as the line count, so it does not validate the claims at those lines; section 1 does that for the files that matter.

## 1. Per-file audit

| File | Purpose | Status | Verification | Findings (file:line evidence) | Links | Changed |
| --- | --- | --- | --- | --- | --- | --- |
| `AGENTS.md` | Owner directive, lanes, amendments | current (amendments of 12 and 14 Oct override earlier sections) | read in full | Internal conflicts: line 24 "never writes production code" vs line 7 (UI allowed); line 57 "budgets" vs line 9 (retired). Line 17 "cookie replay ... remains out" vs `crates/bloblex-speech/src/cloud.rs:43-50, 921-935` (cookie jar and one cookie-carrying retry are shipped). See section 3. | all resolve | no (not allowed) |
| `README.md` | Front page, dev commands, source map | current | claims checked | Status said `v0.1.0-beta.7` candidate; `Cargo.toml:24` and `package.json:4` are `0.1.0-beta.23`. "NSIS/MSI path" and "updater still open": `tauri.conf.json` `bundle.targets` is `["nsis"]`. Budgets listed as daemon and crate responsibilities; `budget.*` returns `unsupported` (`main.rs:992`). `bloblex-budget` has no dependents (Cargo manifests). Commands `npm run typecheck|test|build|desktop:dev|desktop:bundle` exist (root `package.json`). | all resolve (new hub link resolves) | yes: status, bundle line, budget rows, crate row |
| `SESSION_HANDOFF.md` | Dated handoff log | historical | read in full | "Lanes" table (about lines 336-346) predates AGENTS 12 Oct and 1 Oct pipeline rules. "Local only: not pushed" (about line 29) is stale after `v0.1.0-beta.19` (line 70). Budget lines (308, 378) are consistent with retirement. Lines 362 and 383 name gitignored outputs (`binaries/`, `*.tsbuildinfo`, `.gitignore`). | 0 broken | yes: banner |
| `DESIGN.md` | Tokens, layout, controls, companion geometry, moods | current | claims checked | Radii `theme.css:113-116` (6/10/14/pill) match. Companion 14 px and 22 px corners at `companion.css:22-23`. Mood timers `companionStatus.ts:5-9` (6 s, 2 min, 10 min) match. `Select` and `theme.css` paths exist. Not checked: Settings page list (line 29) and profile menu contents (line 30). | 0 | no |
| `PRODUCT.md` | Users, purpose, anti-references | current | read in full | Product intent; no code facts. | 0 | no |
| `THIRD_PARTY_NOTICES.md` | Attribution and licences | current | claims checked in part | Vendored `apps/desktop/src/vendor/robot-heads/` with `LICENSE` exists. `apps/desktop/src/blob/look/` exists. `soundCues.ts` uses oscillators (10 matches), consistent with "original tone" wording. Upstream commit SHAs and copyright lines not checked (no network). Coucou licence status not reviewed. | 0 | no |
| `docs/README.md` | Documentation hub (new) | current | verified by script | Every tracked Markdown file is linked from it (script check). | 0 | added |
| `docs/OPERATING_MODEL.md` | Derived rules summary (new) | current | derived from AGENTS.md | Every bullet cites AGENTS.md; the cookie conflict is flagged as open. | 0 | added |
| `docs/DOCS_AUDIT.md` | This audit (new) | current | n/a | n/a | 0 | added |
| `docs/APPROVAL_MODES.md` | ask / auto / bypass contract | current (budget clauses superseded) | read in full | Budget clauses at lines 3 and 25 contradicted AGENTS line 9; fixed. Global default `ask` or `auto` only: `main.rs:1060`, `storage/src/lib.rs:3061` match. Provider mapping (lines 40-44) and migration 4 (line 16) not checked against adapters. | 0 | yes: 2 edits |
| `docs/BITBOTS_THEME_SPEC.md` | CSS-only "Bitbots" theme spec | historical (feature shipped as an experimental setting) | header and links | Says the only new file is `apps/desktop/src/ui/bitbots.css`; that file exists. Delivery is recorded in `SESSION_HANDOFF.md` (13 Oct) and beta.20-23 notes. | 0 | no |
| `docs/DIRECTOR_LOG.md` | Dated Director decisions | historical | header and links | Line 41 records a storage change (`budget_usage`) from a dated review. Line 52 names gitignored `apps/desktop/tsconfig.tsbuildinfo`. Leading BOM is harmless. | 0 broken (1 gitignored path) | no |
| `docs/E2E_PLAN_V2.md` | Long-running plan with checkpoints | current plan (checkpoint sections dated) | claims partly checked | Eight relative links lacked `../` (lines 41, 44, 50, 54, 57, 260, 270, 271); fixed. Checkpoint text describes `acp --cwd` and `usage.summary` global totals as of 5-6 Oct; `acp --cwd` conflicts with the 2.0.28 observation (see `runtime-capabilities.md`). | 8 fixed | yes: links and banner |
| `docs/FIX1_DICTATION_CONTINUE.md` | Continuation note for Fix 1A | historical | header and links | Records a Cloudflare challenge probe (403, `cf-mitigated: challenge`); not re-run. | 0 | no |
| `docs/FIX1_DICTATION_SPEC.md` | Fix 1A spec | historical; rule amended 14 Oct | header and links | Line 12 "No bypass of bot protection" is amended by AGENTS 14 Oct for cloud dictation request-shape matching; banner added. `originator`, identity, cookie replay and retry-loop bans still stand. | 0 | yes: banner |
| `docs/FIX1_OPENCODE_EFFORT_SPEC.md` | Fix 1B spec (OpenCode effort) | historical (shipped beta.20) | header and links | Claim that `crates/bloblex-adapter-opencode/src/lib.rs` is a 5-line re-export: `wc -l` gives 5. | 0 | no |
| `docs/FIX1_TEAM_CONTINUE.md` | Continuation note for Fix 1C | historical | header | Process note only. | 0 | no |
| `docs/FIX1_TEAM_SPEC.md` | Fix 1C spec (leader-only blob creation) | historical | header | Not claim-checked. | 0 | no |
| `docs/FIX2_DICTATION_TLS_SPEC.md` | Fix 2 spec (rustls for cloud dictation) | historical (released in beta.22) | header; code claims checked | Status matches `RELEASE_CHECKLIST.md:13`. `crates/bloblex-speech/Cargo.toml:20-21` uses `rustls-tls` and rustls. `cloud.rs:908` sends `originator: bloblex`. `cloud.rs:36` cooldown is 10 minutes. | 0 | no |
| `docs/IMPROVEMENT_PHASE_1A_SPEC.md` | Phase 1A: turn-end path, honest timeouts | historical (delivered in beta.19) | header and links | Not claim-checked. | 0 | no |
| `docs/IMPROVEMENT_PHASE_1B_SPEC.md` | Phase 1B: recovery hints | historical (beta.19) | header and links | Not claim-checked. | 0 | no |
| `docs/IMPROVEMENT_PHASE_2A_SPEC.md` | Phase 2A: durable queue | historical (beta.19) | header and links | Queue cap of 20 matches `crates/bloblex-daemon/src/queue.rs:22` (checked in the IPC contract, not here). | 0 | no |
| `docs/IMPROVEMENT_PHASE_2B_SPEC.md` | Phase 2B: gated Codex `turn/steer` | historical (beta.19) | header and links | Not claim-checked. | 0 | no |
| `docs/IMPROVEMENT_PHASE_3A_SPEC.md` | Phase 3A: automatic retry | historical (beta.19) | header and links | Not claim-checked. | 0 | no |
| `docs/IMPROVEMENT_PHASE_3B_SPEC.md` | Phase 3B: wire replay tests | historical (beta.19) | header and links | Not claim-checked. | 0 | no |
| `docs/IMPROVEMENT_PHASE_4A_SPEC.md` | Phase 4A: automations | historical (beta.19) | header and links | Run and cap rules are in the IPC contract; `storage/src/lib.rs:457` confirms `max_runtime_secs` 60-14400. | 0 | no |
| `docs/IMPROVEMENT_PHASE_4B_SPEC.md` | Phase 4B: keep-awake | historical (beta.19) | header and links | `apps/desktop/src-tauri/src/power.rs` exists. | 0 | no |
| `docs/IMPROVEMENT_PHASE_5A_SPEC.md` | Phase 5A: memory | historical (beta.19) | header and links | Not claim-checked. | 0 | no |
| `docs/IMPROVEMENT_PHASE_6A_SPEC.md` | Phase 6A: ask-the-user, hand-off | historical (beta.19) | header and links | Not claim-checked. | 0 | no |
| `docs/IMPROVEMENT_PHASE_7_SPEC.md` | Phase 7: opt-in cloud dictation | historical; banner added | header; code claims checked | Line 42 names `docs/evidence/cloud-dictation-2026-10-12.md`, which is not in the tree. `cloud.rs:342-343` `Challenged` variant exists. Banner names the replacement evidence files. | 1 missing reference (named in banner) | yes: banner |
| `docs/IMPROVEMENT_PLAN.md` | Owner-approved v2 roadmap | current roadmap; phases delivered | claims partly checked | Status said phases were "merged into local main, not pushed"; shipped in beta.19 (`SESSION_HANDOFF.md:70`). Line 17 `main.rs:943` is now `main.rs:992`; line 17 watchdog `main.rs:2306` is now `main.rs:2702-2703`; line 74 `src-tauri/lib.rs` is `apps/desktop/src-tauri/src/power.rs` (registered in `src/lib.rs`). `QUEUE_MAX=20` at `queue.rs:22`. Other citations (`main.rs ~L2415-2440`, `App.tsx ~L520-546`, `scheduler ~L2902`, `recover_after_restart ~L2862`) not checked. | 0 | yes: 5 edits |
| `docs/IMPROVEMENT_PLAN_v1_qa-draft.md` | QA draft of the roadmap (12 Oct) | superseded by `IMPROVEMENT_PLAN.md` | header; banner | References `apps/server/...` and `apps/connect` (lines 90, 415), which are not in the repo; kept as the QA record. | 0 | yes: banner |
| `docs/NATIVE_SMOKE_RESULTS.md` | Native smoke, 2 Oct, isolated DB | historical (only recorded native acceptance pass) | header | Not claim-checked. Revision `e770db8` is the recorded run. | 0 | no |
| `docs/PHASE_2A_SPEC.md` | Phase 2a identity, storage, RPCs | historical (delivered) | header and links | Line 11 cites `crates/bloblex-storage/src/lib.rs:743-790` for `app.snapshot`; not checked. | 0 | no |
| `docs/PHASE_2B_SPEC.md` | Phase 2b execution options | historical (delivered) | header and links | Line 102 lists rejected env-key patterns; not checked. | 0 | no |
| `docs/PHASE_3_SPEC.md` | Phase 3 roster and editor | historical; banner added | inventory checked | Inventory lines 443-452 name `agentRoster.ts`, `agentRoster.test.ts`, `AgentRoster.tsx`, `AgentContextMenu.tsx`, `BlobUsage.tsx`; none is in `apps/desktop/src/ui/` (checked). Replaced by `TeamSidebar` (`SESSION_HANDOFF.md:266`). | 0 (inventory names only) | yes: banner |
| `docs/PHASE_4_SPEC.md` | Phase 4 project and session tree | superseded by `TeamSidebar.tsx`; banner added | inventory checked | 18 relative links to `../apps/desktop/src/ui/AgentRoster.tsx`, `AgentContextMenu.tsx`, `SessionTree.tsx` and `ProjectChooser.tsx` pointed at removed files. Converted to code spans. Links to existing files such as `App.tsx` kept. File restored from HEAD and re-edited to avoid touching valid links. | 18 broken fixed | yes: banner and link repair |
| `docs/PHASE_5_CONTRACT.md` | Usage analytics contract | superseded in part; banner added | read in full (68 lines) | Cost, estimate and subscription sections are retired: `pricing.*` and `subscription.*` return `unsupported` (`main.rs:1085`). `failureClass` values in the file (`provider`, `permission`, `budget`, `config`) do not match code (`main.rs:114-126` emits `permission_denied`, `provider_error`, `config_unsupported`, `timeout`, `context`). | 0 | yes: banner |
| `docs/RELEASE_CHECKLIST.md` | Release procedure and per-release status | current | read in full; script and config checked | Line 5: Cargo.lock entries were said to be beta.22; `Cargo.lock:483-484` and 15 entries say beta.23. Line 70: `tauri.conf.json` said to hold stable and beta endpoints; it holds only the stable URL, and `apps/desktop/src-tauri/src/updates.rs:19-21, 231-234` sets the channel endpoint. Line 109: "current tree is beta.6"; now beta.23. Bundle steps (lines 61-66) match `scripts/bundle-windows.ps1`. CSP table matches `tauri.conf.json` `csp`. Release-script flags (lines 47-51) match `scripts/release-windows.ps1` (DryRun, `--prerelease --latest=false`, `channel-beta`). Bare `tauri.conf.json` references qualified (4 places). | 0 broken | yes: 3 edits, qualified paths |
| `docs/UPDATER.md` | Updater contract | current | read in full; code checked | Channels and endpoints match `updates.rs:19-21`. Background check 15 s after start and every 6 h (`updates.rs:462, 471`). "Updates unavailable in development builds" (`updates.rs:374`). Release steps match the script. Bare `tauri.conf.json` qualified (line 55). | 0 | yes: 1 path |
| `docs/implementation-status.md` | Status, phase table, open gaps | current for "Still open" and "Current source scope"; phase table historical | read in full | Header said "Current as of 12 October" while it includes 13-14 Oct entries; corrected to 14 Oct with banner. Phase 5 row (line 43) says "in progress in current worktree", now stale. "Current source scope" consistent with budget retirement (`main.rs:992`, `main.rs:1085`). | 0 | yes: header and banner |
| `docs/ipc-contract.md` | Daemon RPC and event contract | current; retired sections marked | read in full; RPC names diffed | (1) `session.prompt` said "atomic budget admission"; code uses concurrency reservation (`storage/src/lib.rs:2561`, `main.rs:2413`); corrected. (2) `budget.*`, `pricing.*`, `subscription.*` rows describe live behaviour; they return `unsupported` (`main.rs:992`, `:1085`); marked retired. (3) `app.snapshot` said to return `budgets`; storage test asserts absence (`storage/src/lib.rs:4143`); corrected. (4) Table broken by a blank line before `session.cancel`; fixed. (5) 14 dispatched RPCs missing from the table (see section 2); listed. (6) `budget.warning`, `budget.blocked`, `budget_blocked` have no emitter; marked. (7) Verified: ready line `DaemonReady` (`main.rs:3393`), `permissions.default_mode` ask/auto (`main.rs:1060`), `retry.maxWaitSecs` 0-86400 (`main.rs:1058`), watchdogs 45/300 s (`main.rs:2702-2703`), `maxRuntimeSecs` 60-14400 (`storage/src/lib.rs:457`), queue full (`queue.rs:153`). (8) Example at line 36 still shows `"budgets":[]`; left as an old example. | 0 | yes: 9 edits |
| `docs/runtime-capabilities.md` | CLI capability evidence record | current evidence record for 1-13 Oct builds; OpenCode 2.0.28 block added | read in full; line citations re-checked | Adapter line citations (C6, C7, X7, O3, O5, O7, Z1) are stale; O7 says spawn at `lib.rs:44-48` but that range is a struct, spawn is `lib.rs:299-300`. Corrected in the new note with current lines. `acp --cwd` and `models --verbose` are contradicted by the 2.0.28 observation, and both are still used by code (see section 4). `stored` maps to authenticated (`crates/bloblex-runtime/src/lib.rs:414`). Table results were not re-run. | 1 in-flight spec referenced (FIX3, not in tree) | yes: banner, 2.0.28 block, citation note |
| `docs/v1-coverage.md` | v1 requirement audit, 1 Oct | historical | read in full | Budget rows (lines 26, 39) retired. Pricing and valuation rows describe the retired model. | 0 | yes: banner |
| `docs/windows-development.md` | Windows development runbook | current | read in full; scripts checked | `scripts/dev-windows.ps1` builds `bloblexd` and `bloblex-hook`, stages sidecars, uses ports 1420-1435 and identifier `com.bloblex.desktop.dev`; matches. Default target `target/desktop-dev` matches. Database default `%LOCALAPPDATA%\Bloblex\bloblex.db` (`main.rs:3313-3319`). Corners 14/22 px match `companion.css`. "NSIS and MSI are configured bundle targets" was wrong; corrected to NSIS only. Tray hide-on-close (`apps/desktop/src-tauri/src/lib.rs:85`, default true) and `daemon.shutdown` on Quit (`lib.rs:1469`) also match. | 0 | yes: 1 edit |
| `docs/releases/0.1.0-beta.1.md` … `0.1.0-beta.23.md` (23 files) | Release notes | historical (immutable) | links only | No broken relative links. Installer sizes, SHA-256 values, tag and commit references and test counts were not verified (no build artifacts or network). | 0 | no |
| `docs/evidence/bitbots-theme-2026-10-13.md` | Bitbots evidence | historical (immutable) | links only | Not claim-checked. | 0 | no |
| `docs/evidence/cloud-dictation-client-shape-2026-10-14.md` | Client-shape findings, falsified claims | historical (immutable); cited by AGENTS | links only | The TLS and identity findings match code (see `FIX2` row). | 0 | no |
| `docs/evidence/cloud-dictation-diagnosis-2026-10-13.md` | Cloudflare diagnosis | historical (immutable) | links only | Not claim-checked. | 0 | no |
| `docs/evidence/cloud-dictation-tls-backend-2026-10-14.md` | TLS backend evidence | historical (immutable); cited by AGENTS | links only | Line 10 cites `docs/FIX2_DICTATION_ALPN_SPEC.md`, not in tree (the spec is `FIX2_DICTATION_TLS_SPEC.md`). Backtick path, not a link; not edited (immutable). | 1 missing reference (not edited) | no |
| `docs/evidence/codex-turn-steer-2026-10-12.md` | Codex `turn/steer` evidence | historical (immutable) | links only | Not claim-checked. | 0 | no |
| `docs/evidence/composer-controls-2026-10-07.md` | Composer controls evidence | historical (immutable) | links only | Not claim-checked. | 0 | no |
| `docs/evidence/dictation-2026-10-08.md` | On-device dictation evidence | historical (immutable) | links only | Not claim-checked. | 0 | no |
| `docs/evidence/dictation-bubble-2026-10-08.md` | Dictation bubble evidence | historical (immutable) | links only | Not claim-checked. | 0 | no |
| `docs/evidence/opencode-effort-2026-10-13.md` | OpenCode effort on 1.18.35 | historical (immutable) | links only | Not claim-checked. Its 1.18.35 probe predates the 2.0.28 observation. | 0 | no |
| `docs/evidence/recovery-hints-2026-10-12.md` | Recovery hints evidence | historical (immutable) | links only | Not claim-checked. | 0 | no |
| `docs/evidence/task2-grok-runtime-capabilities.md` | Second-lane capability probe | historical (immutable) | links only | Undated. | 0 | no |
| `docs/evidence/task2-luna-runtime-capabilities-original.md` | First-lane capability spike | historical (immutable) | links only | Lines 29 and 33 cite `docs/qa-schema/codex-0.159.3/v2/ClientRequest.json` (line 4986). The file is at `docs/qa-schema/codex-0.159.3/ClientRequest.json`, not under `v2/`. Backtick paths, not links; not edited (immutable). | 2 missing references (not edited) | no |
| `docs/evidence/wire-fixtures.md` | Wire fixtures synthesized from fakes | historical (immutable) | links only | Matches `SESSION_HANDOFF.md:57` (fixtures are synthesized). | 0 | no |
| `scripts/live-checks/README.md` | Director-run live CLI probes | current runbook | claims checked | All nine named `.mjs` scripts exist (`scripts/live-checks/`). Default binary path `C:/dev/bloblex-target/debug/bloblexd.exe` is machine-specific and not the repo default. `live-cloud-dictation.mjs` and `watch-bb-dictation.mjs` exist but have no entry here. Results are cited in `runtime-capabilities.md`. | 0 | no |
| `scripts/native-smoke/README.md` | Native smoke helpers | current runbook | claims checked | Helper files exist: `cdp.mjs`, `winenum.ps1`, `region.ps1`, `mousedrag.ps1`, `tray.ps1`, `seed_v1.py`, `inspect_v2.py`, `agents_db.py`. `BLOBLEX_DB_PATH` honoured (`main.rs:3313`). The WebView2 debug-port env var was not checked. | 0 | no |

Totals for this table: 83 files covered (80 existing, 3 new). The table has one row per file, except that the 23 release notes share one row, so the table has 61 rows. Evidence files each have their own row.

## 2. Verification ledger

**Claims checked and confirmed** (selection; the full list is in the rows above):
- Versions: `0.1.0-beta.23` in `Cargo.toml:24`, `package.json:4`, the desktop `package.json`, `tauri.conf.json` and the 15 Cargo.lock entries.
- Daemon: binary `bloblexd` (`crates/bloblex-daemon/Cargo.toml:6-8`); crate `bloblex-daemon`; ready line `bloblexd.ready` with `protocolVersion` (`main.rs:3393-3398`).
- RPCs: 86 names dispatched in `main.rs:619-1090`; 14 of them are not in `docs/ipc-contract.md` (now listed).
- Limits: watchdogs 45 s and 300 s (`main.rs:2702-2703`); `permissions.default_mode` ask/auto only (`main.rs:1060`); `retry.maxWaitSecs` 0-86400 (`main.rs:1058`); queue cap 20 (`queue.rs:22`); "The queue is full." (`queue.rs:153`); `maxRuntimeSecs` 60-14400 (`storage/src/lib.rs:457`); shared process idle shutdown 30 s and coalescing cap 128 (`adapter-acp/src/lib.rs:148-149`; same in codex adapter at 136-137); global active turn cap 4 (`storage/src/lib.rs:2566`).
- Companion: corners 14 and 22 px (`companion.css:22-23`); timers 6 s, 2 min, 10 min (`companionStatus.ts:5-9`); radii tokens (`theme.css:113-116`).
- Updater: channel endpoints (`updates.rs:19-21`); timers 15 s and 6 h (`updates.rs:462, 471`); dev message (`updates.rs:374`).
- Release tooling: `release-windows.ps1` checks (clean tree, `main`, tag absence, version equality), `-DryRun`, `channel-beta` upsert with `--clobber`; `bundle-windows.ps1` steps; `stage-daemon.mjs` writes `apps/desktop/src-tauri/binaries/<bin>-<triple>.exe`.
- Cloud dictation: `rustls-tls` (`crates/bloblex-speech/Cargo.toml:20-21`); `originator: bloblex` (`cloud.rs:908`); `cf-mitigated` challenge (`cloud.rs:949-950`); cooldown 10 min (`cloud.rs:36`).
- Runtime: `stored` maps to authenticated (`crates/bloblex-runtime/src/lib.rs:414`); OpenCode version label stripped (`lib.rs:215`).

**Claims not verified** (not re-run, not reachable offline, or outside this pass):
- Test counts and gate results in release notes and handoffs (for example 522, 520 and 516 desktop tests; 472, 459 and 483 Rust tests). Not re-run.
- Installer sizes, SHA-256 digests, tags and commit hashes in `docs/releases/`, `RELEASE_CHECKLIST.md` and `SESSION_HANDOFF.md`. No artifacts or network available.
- Live provider behaviour in `runtime-capabilities.md` and the evidence files (Claude, Codex and OpenCode turns, `turn/steer`, real retries). Not re-run. The 2.0.28 observations are as supplied in the lane brief and were not re-run.
- The owner-attested OpenAI endpoint permission (AGENTS line 15). No copy of the correspondence is in the repository, as AGENTS says.
- Upstream attributions and commit SHAs in `THIRD_PARTY_NOTICES.md`, and the Coucou licence position (line 64). No network.
- `DESIGN.md` lines 29-30 (Settings page list, profile menu contents).
- `IMPROVEMENT_PLAN.md` line citations beyond the three corrected.
- `PHASE_2A_SPEC.md:11` and `PHASE_2B_SPEC.md:102` citations.
- Most content of the phase specs (`PHASE_2A/2B/3/4`, `IMPROVEMENT_PHASE_*`, `FIX1_*`, `BITBOTS_THEME_SPEC.md`) beyond header, link and status checks.
- `SESSION_HANDOFF.md` "What exists" bullets, individually.
- `implementation-status.md` numeric claims in the 1-12 Oct sections (historical).
- `NATIVE_SMOKE_RESULTS.md` (header and links only).

**Approximate effort:** about 150 concrete claims were checked against code or config. Roughly 30 were wrong or stale and were corrected or annotated. The count is approximate because claims were checked in batches.

## 3. Contradictions

### 3a. Between documents and AGENTS.md

1. **Cookie replay (open, owner decision).** AGENTS.md line 17 says "Cookie replay, challenge-solving and retry loops remain out." `crates/bloblex-speech/src/cloud.rs:43-50` keeps Cloudflare cookies in memory, and `:921-935` sends them once more on a retry. `docs/FIX2_DICTATION_TLS_SPEC.md` (lines 43-44 and 52) describes "the existing single retry" and "no cookie replay beyond" it. `docs/RELEASE_CHECKLIST.md:13` says "cookie retry [is] unchanged" in beta.22. `docs/RELEASE_CHECKLIST.md:15` describes the cookie retry as shipped in beta.21. This document did not change code or AGENTS.md. The owner needs to decide whether the shipped one-shot cookie retry is allowed.
2. **Budgets.** `AGENTS.md:57` ("Daemon owns sessions, permission decisions and budgets") predates `AGENTS.md:9` (budgets retired). Fixed in docs; AGENTS.md itself not edited.
3. **Director code.** `AGENTS.md:24` ("never writes production code") conflicts with `AGENTS.md:7` (Director may write UI and UX production code). The 12 Oct amendment governs. Recommend the owner tidy line 24.
4. **Budgets in docs.** `docs/APPROVAL_MODES.md:3, :25` (fixed), `README.md:55, :59` (fixed), `docs/ipc-contract.md:87, :121-127, :194, :259` (fixed), `docs/v1-coverage.md:26, :39` (banner), `docs/PHASE_5_CONTRACT.md` (banner).
5. **Lanes.** `SESSION_HANDOFF.md` "Lanes" table (about lines 336-346) names Codex `impl` as the production implementer and OpenCode `qa` as research. `AGENTS.md:7` makes OpenCode the heavy coder. Banner added.
6. **Dictation exception scope.** `docs/FIX1_DICTATION_SPEC.md:12` (bot-protection rule) is amended by `AGENTS.md:16-17` (14 Oct). Banner added.

### 3b. Between documents (and documents vs code)

7. `README.md:5` (beta.7 candidate) vs `docs/RELEASE_CHECKLIST.md:3` (beta.23 published). Fixed.
8. `docs/RELEASE_CHECKLIST.md:109` ("current tree is beta.6") vs `Cargo.toml:24` (beta.23). Fixed.
9. `docs/RELEASE_CHECKLIST.md:70` (tauri.conf.json holds stable and beta endpoints) vs `tauri.conf.json` (one endpoint) and `updates.rs:19-21, 231-234`. Fixed.
10. `docs/RELEASE_CHECKLIST.md:5` (Cargo.lock beta.22) vs `Cargo.lock:483-484` (beta.23). Fixed.
11. `docs/windows-development.md` ("NSIS and MSI") vs `tauri.conf.json` `bundle.targets` (nsis only) and `RELEASE_CHECKLIST.md:68`. Fixed.
12. `docs/implementation-status.md` header (12 Oct) vs its own 13-14 Oct entries. Fixed.
13. `docs/IMPROVEMENT_PLAN.md` status ("local main, not pushed") vs `SESSION_HANDOFF.md:70` and `releases/0.1.0-beta.19.md` (shipped). Fixed.
14. `docs/PHASE_5_CONTRACT.md` failure classes vs `main.rs:114-126`. Banner.
15. `docs/ipc-contract.md` budget and pricing rows vs `main.rs:992, 1085`. Fixed.
16. `docs/ipc-contract.md` `app.snapshot` budgets key vs `storage/src/lib.rs:4143`. Fixed.
17. `docs/runtime-capabilities.md` (`acp --cwd`, `models --verbose`) vs the 2.0.28 observation and vs code (`adapter-acp/src/lib.rs:299-300`, `catalog.rs:54-55, 102-103`, `runtime/src/lib.rs:289`). Flagged; the 2.0.28 block states the conflict. Code not changed.
18. `docs/runtime-capabilities.md` adapter line citations (C6 to Z1) vs current code. Corrected with a note.
19. `docs/IMPROVEMENT_PHASE_7_SPEC.md:42` names an evidence file that does not exist. Banner.
20. `docs/PHASE_3_SPEC.md`, `docs/PHASE_4_SPEC.md` name removed UI files. Banners; PHASE_4 links converted.
21. `docs/E2E_PLAN_V2.md` (eight broken links) vs the file's location in `docs/`. Fixed.

## 4. Code findings for the Director (not changed by this pass)

These are code issues surfaced by the audit. The docs lane does not edit code.

- **OpenCode launch flags.** The ACP spawn passes `acp --cwd` (`crates/bloblex-adapter-acp/src/lib.rs:299-300`; `crates/bloblex-adapter-acp/src/catalog.rs:102-103`). The 2.0.28 observation says `acp` accepts only `--login` and rejects `--cwd`. This would break OpenCode ACP launch on 2.0.28. Needs a fix and a test.
- **OpenCode verbose catalog.** `models --verbose` is used at `crates/bloblex-adapter-acp/src/catalog.rs:54-55` and `crates/bloblex-runtime/src/lib.rs:289`. The 2.0.28 observation says the flag is rejected. Runtime discovery has a fallback (`lib.rs:286-303`); the adapter catalog path may not.
- **Budget reservation helpers.** `crates/bloblex-storage/src/lib.rs:2326-2370` (`reserve_budget`, `reserve_applicable_budgets`, `reserve_applicable_budgets_with_demands`) have no production caller; their references are in tests (`lib.rs:4497` onward). Prompt admission uses `create_reserved_turn` (`lib.rs:2561`) for concurrency only. Consider deleting the dead code (owner decision, since budgets are retired).
- **Cookie retry.** See section 3a item 1.
- **Failure class constraint.** `crates/bloblex-storage/src/lib.rs:136` has a `CHECK` on `turns.failure_class` that does not list `context`, while `main.rs:122` emits `context`. A later migration may rebuild the constraint; this pass did not confirm that.
- **Unemitted events.** `budget.warning`, `budget.blocked` and `budget_blocked` have no emitter in `crates/bloblex-daemon/src` or `crates/bloblex-protocol/src`. The docs now say so; the code may still carry type definitions.

## 5. Missing documentation (recommended; no content invented)

1. **Dictation runbook.** There is no runbook for cloud or on-device dictation: how to run `scripts/live-checks/live-cloud-dictation.mjs` safely, how to read its output, consent flow, and how to fall back. Today the material is split between `FIX1_*`, `FIX2_*`, `IMPROVEMENT_PHASE_7_SPEC.md` and evidence files.
2. **Live-check entry.** `scripts/live-checks/live-cloud-dictation.mjs` and `watch-bb-dictation.mjs` have no entry in `scripts/live-checks/README.md`.
3. **Specs that were in flight.** `FIX2_CODEX_TEAM_INSTRUCTIONS_SPEC.md`, `FIX3_OPENCODE2_ACP_LAUNCH_SPEC.md` and `FIX4_CLIPPY_CLEANUP_SPEC.md` were not in the audited tree. They have since landed on `main` and are indexed in the hub; the FIX3 launch rules match the OpenCode 2.0.28 block in `runtime-capabilities.md`.
4. **Current RPC reference.** `docs/ipc-contract.md` lacks parameter tables for the 14 undocumented methods listed in its section "RPC methods dispatched but not in the table above".
5. **Owner decision record (done 14 Oct 2026: the owner chose to leave the cookie-retry conflict recorded, no change; see `OPERATING_MODEL.md` section 6).** A short, dated record of the cookie-retry decision, linked from AGENTS.md's amendment or from `OPERATING_MODEL.md`.
6. **Machine-independent paths.** `scripts/live-checks/README.md` uses a machine-specific binary path. A repo-relative example would avoid confusion.
7. **Release-note template check.** The release script falls back to a one-line note when `docs/releases/<version>.md` is missing (`release-windows.ps1`, the default note branch). Documenting that fallback in `RELEASE_CHECKLIST.md` would make the behaviour clear; it is partly covered in `UPDATER.md`.
