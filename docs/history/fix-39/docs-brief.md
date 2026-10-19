# FIX39 documentation brief (Claude Haiku 5.5)

> **What this is:** Brief for the FIX39 documentation pass (Claude Haiku 5.5).
> **Status:** historical
> **Last updated:** 2026-10-18

You are the documentation lane (AGENTS.md, the 18 October, later, amendment). Write the docs for the FIX39 wave from the reports. Change no code. Never run `git commit`.

## Sources

- **Owner's input:** `docs/history/fix-39/feedback.md` (24 items) and `docs/history/fix-39/decisions.md` (all decisions and packages P1 to P13).
- **Research:** `docs/history/fix-39/research-r1.md`, `R2.md`, `R3.md` and `docs/history/fix-39/research-audit.md`; for T3, `docs/history/fix-40/t3-research.md`.
- **Per package:** `docs/FIX39_P<n>_REPORT.md` and `docs/FIX39_P<n>_AUDIT.md`, for P1 to P13.
- **Director's checks:** `docs/history/fix-39/director-checks.md`.
- **For accuracy only:** `git log --oneline 0d4c975..HEAD` lists the commits since beta.33.

## Write or update

1. **`docs/releases/0.1.0-beta.34.md`:** the release note, for the owner and their friends. Use plain words and short sections:
   - New: the Manager, Working bots, diagnostics, shapes, slash commands and anything else new.
   - Fixed: start with the friend's failures. Lost context after a restart: Claude resumes now work, because of the P13 root cause. Permissions mid-conversation. Multitasking. "Coding agent took too long".
   - Changed: Full access is now the default for new bots; Steer or Queue.
   - Verification: the gate numbers come from the Director, so leave a `TODO-GATES` line.
   - Unverified: live phone and tailnet, the native windows, the update round trip.
   - Installation: beta.32 and beta.33 update themselves; older versions install by hand.

   Follow the style of `docs/releases/0.1.0-beta.33.md`.
2. **`SESSION_HANDOFF.md`:** a new top section, "Beta.33 review FIX39 (18 October 2026)". Follow the style of the beta.33 section: state, the four-model pipeline, a table of packages with commits and reports, gates (leave TODO), not verified, owner to-dos. Update the "current release" line to beta.34.
3. **`docs/operations/implementation-status.md`:** an 18 October FIX39 entry, plus the status line.
4. **`docs/README.md`:** index every new FIX39 and FIX40 doc (specs, research, decisions, reports and audits) in the table's style.
5. **`docs/ipc-contract.md`:** document every new daemon method or event the packages added. Examples: `agent.lock.set`, `session.permissions.set`, `skills.forAgent`, `diagnostics.export`, the watchdog and limited events, merge proposals, and the Manager tool set's methods, if any are daemon methods. Take the exact names and shapes from the reports and the code (grep `crates/bloblex-daemon/src`).
6. **`DESIGN.md`:** record the visual rules the audit left to the docs lane:
   - the eight symmetric shapes (item 4);
   - the Manager's Grok-style star badge, and that no other sparkle or star icons are allowed (item 8);
   - the model line under a bot's name (item 12);
   - the lock badge (item 13);
   - the Working bots panel;
   - the update badge's compact form.
7. **`docs/remote/THREAT_MODEL.md` and `PROTOCOL.md`:** record the Origin rule and Remote redaction changes from P2 and P3 if those reports name them. Record P12's diagnostics privacy guarantees as a short section: what the logs and the zip never contain.

## Rules

- Write in plain, honest language.
- Keep evidence apart: tested with fakes, tested live with the real CLIs (P11 and P13), and not verified.
- Never include credentials, hostnames or personal paths.
- Leave `TODO-GATES` markers wherever the final gate numbers go. The Director fills them in after the final gate run.
- Reply with a list of the files you changed and any facts you could not confirm.
