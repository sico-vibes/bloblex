# T3 wave report (26 October 2026, rounds 1 and 2)

Owner request: apply the T3 recommendations, build integrated UI in the Bitbots design, a real interactive terminal, media in chat and ChatGPT-like rendering (interactive tables and charts first, then media and documents), and make the Haze background 80% transparent (about 20% opaque). Round 2 asked for the gaps in round 1 to be closed as far as is actually possible.

**Hard rule for this wave (owner):** no application tests, no screenshots, no browser automation, no scratch probes, no `cargo test`, no `cargo check --tests`. Nothing here was verified by running the app, a test or a screenshot. See "Validation" for exactly what ran, including one slip.

## Lanes

| Lane | Worktree | Work |
|---|---|---|
| Director (Claude) | `D:\t3` | all UI, CSP, tiers, docs, integration |
| OpenCode `opencode-go/deepseek-v4.1-flash#high` | `D:\t3p` | native terminal (`pty.rs`) |
| OpenCode (same) | `D:\t3d` | delegation hardening, stop RPCs, `session.workspace` |
| OpenCode (same) | `D:\t3m` | `media.preview`, `session.checkpoints` |
| OpenCode (same), round 2 | `D:\t4a` | agent instructions, child-request wake, durable failed/cancelled replies |
| OpenCode (same), round 2 | `D:\t4b` | remove whole-turn undo, per-file checkpoint report |

Briefs and each lane's report are beside this file. Every lane diff was read before it was applied; no lane ran `git commit`. One backend edit was made by the Director directly: a sentence about showing project files appended to the instruction text in `team.rs` (a string, no logic).

## What exists now

1. **Charts and tables actually get produced.** `runtime_instructions` (every bot, Manager and side conversations) now carries the exact `bitbots-chart` and `bitbots-table` schemas from `richData.ts`, two compact examples, the limits, an explicit rule to use only real data and never invent or pad values, and how to show project files (`![alt](path)`, `[name](path)`). The renderer still only draws what passes validation; anything else stays visible as code with the reason. Cost: roughly 450 tokens per session. This is the only mechanism: no model was run, so whether a given provider follows it is unverified.
2. **Child requests wake the Manager.** A pending approval in a teammate's conversation (a request left for the owner, not one a policy resolved, not an unattended run) is announced once to the originating Manager as a `blob_update` message that carries the request's short title only, with a chip that opens the teammate's request. The Manager is told it cannot answer, approve or resend. Dedupe is durable (`wake_request` on the ledger row) and per request. Failed and cancelled replies are re-offered after a restart exactly like completed ones (text rebuilt from the stored error). Interrupted assignments send no reply. **Questions (round 3):** see "Round 3" below; a delegated bot can now ask.
3. **Live work-log output.** Running commands show the last 24 lines the agent reported, the last line in the step header, the full bounded output once done; the step states plainly when the provider (Claude Code) only reports output at the end. Possible keys and passwords are hidden on screen (display only). Nothing is read from a terminal.
4. **Checkpoints, honestly.** The whole-turn undo (`session.checkpoints.revertTurn`) is removed from the daemon, the UI and the remote tier table. The "Changes by turn" card lists each turn's files with the daemon's dry-run state and offers a confirmed undo **per file** through the existing `file.revert` (Git refuses a file that changed since; one file is applied or not at all). It says that undoing a file does not change what the agent remembers; nothing is called a rollback. Provider-coherent restore is not implemented and not claimed.
5. **Media.** Images, audio, video, text, **PDFs drawn inline by pdf.js** (canvas, page buttons, page as text; lazy chunk and bundled worker; password-protected or invalid files get a card), file links in replies `[name](path)` opening a dialog, `![alt](path)` images. Outgoing: the paperclip in the main composer attaches a document, audio or video file **by path** (Bitbots does not read or send its bytes; the message carries one sentence, the transcript shows a "sent as a path" chip, with a preview only inside the project). Images keep their existing real attachment path. No provider is claimed to ingest audio, video or documents.
6. **Schedules in the rail.** A "Schedules" card in the conversation rail (the Manager sees every schedule, another bot its own and its project's), plus the Manager settings page list. **Assignment controls:** Stop and Stop all (one scoped `delegation.cancelGroup` call), and "Ask for an update", which only fills the Manager's message box.
7. Round 1 items still stand: delegation hardening, workspace card, Needs you, stop-and-send, terminal dock with ConPTY, rich tables and charts, Haze at about 20% opacity.

## Real limits and risks

- **Nothing was run.** No window, terminal, PDF, chart or media behaviour was seen. The pdf.js worker path (`.mjs` served by Tauri's asset protocol under the CSP) and the xterm canvas on a transparent Haze window are the two most likely places for a runtime surprise. Existing tests were not run and may be stale. Haze contrast over a live desktop is unmeasured.
- The running preview app still has the round 1 daemon; the new backend (wake, instructions, checkpoint shape) takes effect after the preview shell is restarted with `D:\t3\target\lane\run-t3dev.ps1`. The UI already hot-reloaded. The new "Changes by turn" card expects the new `fileUndo` capability shape, so against the old daemon it shows "Single changes cannot be undone here".
- pdf.js runs without its CMap and standard-font files (not bundled), so a PDF that relies on non-embedded fonts or CJK maps may render with fallback glyphs; "page as text" is the fallback. Annotations and links are not drawn.
- A file attached by path depends on the coding agent's own permissions; Bitbots cannot tell whether it was read.
- Models only follow the chart instructions if they obey system text; plain Markdown tables and csv/json data work regardless.
- Needs you is in the main window's sidebar; the companion already lists pending approvals in its own queue. Scheduled board tasks do not link to a run.
- The group Stop relies on the daemon call; a running teammate's turn ends through its normal path, so the card may show "Working" briefly after Stop.
- No live check was possible for secrets masking beyond its patterns (keys, tokens, bearer headers, private-key blocks, `password=` style values).
- Remote: none of the new RPCs or terminal commands is reachable from a paired phone (`class: never`).

## Validation that actually ran

- Round 1: `tsc -p apps/desktop --noEmit`, `npm run build`, `npm run build:remote`. **Slip:** the desktop `tsconfig.json` includes the `*.test.ts(x)` files, so these runs type-checked the tests (nothing was executed). The owner then ruled this out; round 2 used a temporary production-only config (`apps/desktop/tsconfig.prod.tmp.json`, untracked, excluding test files) and `npx vite build` only.
- Round 2: `npx tsc -p apps/desktop/tsconfig.prod.tmp.json --noEmit` clean after each batch; `npx vite build` clean (PDF chunk and worker emitted); `cargo check -p bloblex-daemon -p bloblex-storage` clean on the merged tree (each lane also ran its own `cargo check`). The desktop crate was last checked in round 1; no native code changed in round 2.
- `git apply --check` for every lane diff against `D:\t3`, then for the combined change against the main checkout.
- No test, test target, screenshot or browser run. A search of both round 2 lane logs for cargo test, --tests, vitest, npm test, clippy and git write commands found nothing.

## Side effects on the machine

- Worktrees and branches: `D:\t3` (`t3/ui`), `D:\t3p` (`t3/pty`), `D:\t3d` (`t3/daemon`), `D:\t3m` (`t3/media`), `D:\t4a` (`t4/delegation`), `D:\t4b` (`t4/checkpoints`). No commit anywhere.
- Packages unpacked into the main checkout's `node_modules` (what `npm install` would do): `@xterm/xterm`, `@xterm/addon-fit`, `pdfjs-dist`; `package.json` and `package-lock.json` list them once the combined change is applied.
- The preview app (`com.bitbots.desktop.t3dev`, Vite 1440 to 1459, private database under `D:\t3\target\desktop-dev\dev-data`) was started in round 1 and left running. No existing process was stopped.

## Dependencies and licences

`@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0 (MIT), `portable-pty` 0.9 (MIT), `pdfjs-dist` 4.10.38 (Apache-2.0). T3 Code (MIT, pinned 220eb735) informed the designs; no T3 file was copied. Notices are in `docs/legal/third-party-notices.md`.

## Round 3: a delegated bot can ask the human (26 October 2026)

Lane `D:\t5` (OpenCode, brief and report `brief-r3-child-questions.md`, `report-r3-child-questions.md`), UI by the Director.

Flow: the Manager delegates -> the teammate calls `ask_user` (allowed only when its origin chain is attended) -> a question card in the teammate's own conversation -> the Manager is woken once (title only) and the assignment row reads "Has a question" -> Needs you and the Manager chat chip open the teammate's conversation -> only the owner answers -> the answer goes only to that session as its next message -> that turn finishes the assignment and the teammate's final reply reaches the Manager as before -> the Manager also gets one non-waking notice that the question was answered, dismissed, expired or closed (no content).

Safety kept: unattended runs and side conversations started by them still refuse; the Manager has no way to answer or approve (no RPC added, no tier changed, remote untouched); the answer target is the card's own session id; the wake is deduplicated durably; a pending question never completes the assignment or sends a premature reply; cancelling, failing, interrupting or restarting closes the cards without prompting; an expired question prompts the teammate to carry on so nothing hangs; answering a closed assignment is refused with a reason.

Limits: a race remains when the owner answers in the last moments of the question turn (the child still gets the answer, but its follow-up is not relayed to the Manager); cancelling one of two simultaneous assignments in the same side conversation closes both assignments' cards; native provider questions (Claude, Codex) in side conversations are not part of this path. Nothing was run. One existing test, `ask_user_is_listed_for_every_providers_own_conversation` (`main.rs`), asserts the old refusal for a side session and is now stale; it was not run or edited. Checks: `cargo check -p bloblex-daemon -p bloblex-storage` clean (lane and merged tree), production-only typecheck clean.
