# FIX36 D3: what the Manager knows outlives its model — profile, playbook, handover

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, own worktree, private `CARGO_TARGET_DIR`. **Do not run `git commit`.** Builds on D1 and D2 (read their reports). Read `AGENTS.md` first. Keep your context small: grep and read only the ranges you need; pipe long output through `tail`/`grep`. Do not edit `apps/desktop/src/ui/**`.

## 1. Profile: structured facts about the user
- Table `manager_profile(id TEXT PK, category CHECK IN ('identity','workflow','style','conventions','design','other'), key TEXT, value TEXT ≤ 1000, source CHECK IN ('said','learned','corrected'), locked INTEGER DEFAULT 0, created_at, updated_at, UNIQUE(category, key))`.
- Manager-only tools: `remember_about_user { category, key, value, source }` — new key → saved (shown as "learned" in the UI); existing **unlocked** key → updated; existing **locked** key → a D2 proposal (`kind:"playbook"` is for the playbook; use a new `kind:"profile"` proposal for locked changes; add it to D2's CHECK list additively); `forget_about_user { category, key }` (locked → proposal).
- Reject values that look like secrets (reuse `memory::contains_secret_marker`).
- User RPCs: `manager.profile.list`, `manager.profile.set { id?, category, key, value, locked }`, `manager.profile.delete { id }`. Event `manager.profile.changed`.

## 2. Playbook: the Manager's own guide
- Table `manager_playbook(version INTEGER PK, text TEXT ≤ 16000, author CHECK IN ('default','user','manager'), created_at)`; latest version is current. Seed version 1 with a default playbook (Markdown, ≤ 6000 chars) covering: first-run interview (name, role, how they work, communication style, coding conventions, design taste, references), project onboarding interview (goal, users, platform, stack, design, references, success), how to propose a team (one bot per responsibility, explain each role, 2–6 bots), always ask before creating projects/bots/tasks, never store secrets, keep the user's locked preferences.
- Tool `update_playbook { text, reason }` → always a proposal (`kind:"playbook"`, payload carries `{ text, reason, baseVersion }`); on approve append a version (author `manager`).
- User RPCs: `manager.playbook.get`, `manager.playbook.history`, `manager.playbook.set { text }` (author `user`), `manager.playbook.revert { version }`. Event `manager.playbook.changed`.

## 3. Context for every Manager turn
- A per-turn suffix block `<bloblex_manager>` for the Manager only (same mechanism as the memory catalog / skills index: re-sent only when its hash changes, cleared on context reset), containing: the profile grouped by category (locked first, ≤ 3000 chars, then "call recall_about_user for more"), the current playbook (≤ 6000 chars), and the workspace summary (projects with bot names; ≤ 1500 chars). Tool `recall_about_user { category? }` returns the full profile.
- This block is **not** part of `<bloblex_team>`, so profile and playbook edits never change the instruction hash.

## 4. Model change: same Manager
- When the Manager's runtime or model changes, its next turn starts a fresh provider session (as any model change does) and the first prompt of that session carries a `<bloblex_handover>` block: profile, playbook, active projects and bots, open (pending) proposals, and the last 10 approved/rejected decisions with dates. The transcript notice for that reset reads "New model, same Manager. It has its notes and playbook." (`meta.kind = "context_reset"`, `reason = "manager_handover"`, `contextLost: false`).

## 5. Non-visual TS
Add the new RPCs/events to `apps/desktop/src/remote/tiers.json` (`manager.profile.list` / `manager.playbook.get` / `.history` read-viewer; the writes never; events drop), types to `apps/desktop/src/types.ts` (`ManagerFact`, `PlaybookVersion`), and fixtures in `apps/desktop/src/preview/fixtureBridge.ts`.

## Tests
- remember: new key saved, unlocked update, locked change → proposal; approve applies; secrets rejected.
- playbook: seed exists; update_playbook → proposal; approve appends a version; user set/revert.
- `<bloblex_manager>` only for the Manager, re-sent only when the hash changes, absent for other bots, respects the caps.
- Model change → next prompt carries `<bloblex_handover>`; the notice has `reason:"manager_handover"` and `contextLost:false`.

## Gates
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast 2>&1 | grep -E "test result|FAILED|panicked"`
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote src/preview`

## Report
`docs/FIX36_D3_REPORT.md`.
