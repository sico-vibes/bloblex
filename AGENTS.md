# Bloblex collaboration instructions

## Resume — 1 October 2026, evening

The user explicitly resumed work after the 20:37 stop. Finish the UI first: the main shell should follow the OpenMausBot / Grok-style chat layout while keeping Bloblex's plan (agents, sessions, usage, permissions, companion). Companion blobs must match Coucou's animation and face language on a circle, and the same face is used in the chat. Backend expansion stays paused. Read `docs/STOPPED_CHECKPOINT.md` for the pre-resume snapshot. The older "coordinator must not touch code" arrangement applied to the Luna lanes; this resume is direct UI work unless the user says otherwise.

Status at 22:30: the character engine, companion island and OpenMausBot-style main shell are implemented and pass typecheck/tests/build; native-window verification and per-blob model/effort/speed (needs daemon support) remain. See the top section of `SESSION_HANDOFF.md`.

Read `SESSION_HANDOFF.md` and `docs/implementation-status.md` before resuming work. They describe an unfinished implementation; passing old checks is not current acceptance.

## User's current working arrangement

- The coordinator/root is responsible for documentation and orchestration. The user explicitly instructed it to stop touching code, including small production fixes.
- Two Luna 6 agents at High effort implement the application; a third Luna 6 agent at High effort performs independent QA and reports directly to the implementers for corrections.
- Reuse existing live agents when available. Agent names/handles do not necessarily survive a new session. Do not create additional workers beyond the three authorized lanes.
- The current priority is UI behavior and polish. Backend work is paused at its recorded checkpoint; the full plan remains required after the UI checkpoint.
- Computer Use and browser UI interaction testing are deferred until the end. Source review, deterministic tests and builds may continue.
- Preserve the running inspection app and its data. Do not restart it, terminate processes or overwrite locked sidecars as a side effect of a check. Coordinate an explicit runnable checkpoint first.

## Ownership

- Desktop implementer: App/styles, shell FSM/layout, native Tauri windows and commands.
- Character implementer: BlobCanvas, motion helpers, original opt-in sound module and character/mounted lifecycle tests; backend implementation remains its later lane.
- At the 19:07 checkpoint, that implementer also owns a separate native file-inspection test module, coordinated with desktop. Desktop alone registers the module or edits native production source.
- QA: independent tests/review and `docs/qa-ui-execution.md`; production corrections go to the implementer who owns the file.
- The 19:55 UI continuation permits DOM-mounted React unit tests while Computer Use/browser/native interaction remains deferred. QA coordinated a one-time test-only `happy-dom` dependency/lockfile addition and then released those files; coordinate any subsequent dependency edit with both implementers.
- Coordinator: handoff, status/checklist and documentation index. Avoid concurrent edits to an implementer's source-provenance document.

## Scope and invariants

- Preserve all requirements of the supplied plan; do not redefine v1 around whichever subset already passes.
- Reuse Coucou's MIT interaction/animation code directly where practical, pinned to `8e12bed56134d2ee7165e73f132646b143ce56e4`, with provenance and notices. Bloblex keeps its own circular character, provider palette, name, icons and sounds; no protected Mochi media is imported.
- Companion: source-informed rounded corners, not a stadium-shaped outer pill; bottom-center default, free drag and retained placement; full welcome wave and stateful home/chat/activity/file-drop behavior.
- No copied provider authentication, primary terminal scraping, raw provider JSON in React, fabricated success/usage, or unknown prices presented as zero.
- Daemon owns sessions, permission decisions and budgets. Main and companion share its normalized state.
- Keep prompts in stdin/protocol, not shell command text or large argv strings. Never record capability secrets or provider credentials in docs or logs.
- Review tests for what they actually prove. Distinguish independent evidence, implementer reports, source-only implementation and unverified behavior.
