# QA findings register

Early draft review, 1 October 2026. All findings below are open until independently retested against the delivered implementation. They do not imply a final acceptance verdict.

| ID | Area | Required correction or verification |
| --- | --- | --- |
| Q01 | Discovery | Resolve the installed npm wrappers to direct native binaries or Node plus script; include launch arguments in probes; no online/auth/capability claims from file existence alone. |
| Q02 | Codex protocol | Send `initialized` as notification; persist actual provider turn IDs for interrupt; handle approvals, file activity, usage and EOF; capabilities match implemented behavior. |
| Q03 | ACP lifecycle | Release registry mutex before waiting on long turns; cancellation works while prompt is in flight; negotiate initialize capabilities; implement supported load/resume and permission responses. |
| Q04 | Daemon turns | Admit and mark a turn before provider output can arrive; return acceptance promptly; one active turn per session, global concurrency cap; persist errors, completion and partial history. |
| Q05 | Permissions | Reply reaches the actual provider, only supported choices, resolves once, stale replies fail, both surfaces update; SQLite-only resolution is not success. |
| Q06 | Snapshot/replay | Reconstruct persisted transcript/activity/usage/budgets/permissions; consistent snapshot sequence; handle replay gaps and more than one replay page; no prompt resend. |
| Q07 | Usage | Persist correct runtime/provider/session/turn/model attribution; normalize cumulative versus incremental usage; unknown total remains unknown; exclude cache from ordinary input. |
| Q08 | Pricing | Respect effective dates and aliases; rates missing for used buckets stay partial/unknown; no zero estimate from unavailable rates; subscription and actual charges separate. |
| Q09 | Budgets | Period and scope semantics, all applicable policies, atomic persistent reservations, reconciliation/release, restored usage, warnings, live cancellation where reliable. Real concurrent admission test. |
| Q10 | Frontend reducer | Append deltas using stable IDs, merge session updates without discarding content, handle full runtime refresh/removal, tools/files/usage/budget events, sequence dedupe, permission resolution without optional session ID. |
| Q11 | Canvas | One scheduler; hidden/invisible pause; lower idle cadence; static reduced motion; original circular character with eye tracking and spring/click reactions. |
| Q12 | Cross-window | Main and companion share relevant selection/state; permission priority across sessions; bottom-center bill overlay, free dragging, position persistence and off-screen recovery. |
| Q13 | Normalization | Keep raw provider events inside backend/debug storage; React receives normalized activity and display-safe errors. |
| Q14 | Build/package | Tauri is a workspace member; build/bundle daemon and hook; real production frontend/native/installer commands succeed; signing and VM claims require actual evidence. |
| Q15 | Tests | Parser tests exercise production parsing; protocol fake children test lifecycle/approval/cancel/error; field-equals-literal assertions are insufficient. |
| Q16 | File actions | Resolve provider paths against project roots; open a configured editor, reveal in Explorer, copy path and show diffs; never execute changed files through default associations. |
| Q17 | Runtime profiles/WSL | Apply and probe saved profiles, filter protocol overrides, launch distinct WSL runtimes with canonical paths and safe arguments; a saved profile or path helper alone is insufficient. |
| Q18 | Recovery/diagnostics | Reconcile orphaned sessions/turns/approvals on restart; no prompt resend; user-triggered sanitized diagnostics; preserve native resume IDs and partial history. |
| Q19 | Complete UI | Render actual normalized tool/file/plan activity; usable settings/usage controls, code rendering, scrolling and token batching; rate-limit and budget-warning visual states. |

Implementers may annotate this document with the fix and relevant test command. Root QA will change verification status after running independent checks. Detailed acceptance scenarios remain in `qa-acceptance.md`.

Desktop implementer notes (not verification): Q10 reducer merges session updates, consumes message/tool/file/usage/budget events, resolves permissions without requiring a session ID, and discards duplicate sequences; covered by `npm test` (5 reducer tests). Q11 uses one visibility-aware scheduler with reduced-motion redraws and hover/click reactions. Q12 main and companion use the native active-session selection, permission session priority, all supported permission choices, draggable persisted capsule placement, and clamped display recovery. Q14 `npm run typecheck`, `npm run build`, `npm test`, and `cargo check -p bloblex-desktop` pass; local Tauri app starts with `cargo run -p bloblex-desktop --bin bloblex-desktop`. Native placement/persistence and interaction remain for independent Windows UI retest; bundle/signing are not verified by these checks.
