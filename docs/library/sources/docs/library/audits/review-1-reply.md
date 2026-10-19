Verdict: The archive is organized, but several documents presented as current are stale or contradict the implementation. Fix the Remote descriptions and the contributor and agent pointers before treating the index as authoritative.

### Structure

1. `docs/library/audits/inventory.md:3` — The inventory calls itself “not part of the library,” but it sits under `docs/library/` and the index lists it as a library work record. **Proposed change:** describe it as a lane audit or work record and use that description consistently. **Should fix**

### Naming

2. `docs/STYLE.md:23-24` — “Light robots” does not match the art styles in `apps/desktop/src/blob/art/art.ts:9-20` (“3D robot,” “Flat robot,” “Pop robot,” “Dot robot,” “Glossy blob,” “Hand-painted”). **Proposed change:** use the actual style names and distinguish bot art styles from the app’s visual looks. **Should fix**

### Style guide

3. `docs/STYLE.md:43-47` — The rule says Status must be one of a short list, but the documents use values such as “working record,” “in progress,” “owner directive,” and “evidence (immutable record).” **Proposed change:** define allowed status categories and permit a short qualifier, or expand the list to match the conventions in use. **Must fix**

### Index

4. `docs/README.md:10` — “Operating model” is described as the rules “in effect today,” but [operating-model.md](../../operations/operating-model.md) was last updated 15 October and predates the 19 October FIX40 pipeline amendment in `AGENTS.md`. **Proposed change:** update the summary from the current directive or label it as an older, dated summary. **Must fix**

5. `docs/README.md:11` — The new-contributor path omits the architecture overview, even though it now explains the main processes and where to read each subsystem. **Proposed change:** link `reference/architecture.md` before the IPC contract and runtime capabilities. **Should fix**

### Document samples

6. `docs/guides/windows-development.md:28-30` — The guide says updater keys and release hosting still need configuration, then says the updater is disabled. The beta.35 release checklist records a signed updater key and published update channel. **Proposed change:** distinguish the still-unsigned Windows installer and unverified clean-machine install from the configured updater. **Must fix**

7. `docs/plans/e2e-plan-v2.md:7` — It labels beta.23 as the current release, although the index and release checklist identify beta.35. **Proposed change:** remove that stale current-release claim or point readers to the implementation status for current release state. **Must fix**

8. `docs/remote/PROTOCOL.md:7-10` — The body says Remote is “not implemented,” but the daemon contains the Remote gateway implementation. The document also describes the Tailscale design while the current policy includes a Native method. **Proposed change:** label the protocol’s scope and implementation status accurately, and point to the Native method’s current requirements. **Must fix**

### Factual or link problems

9. `docs/reference/architecture.md:35` — It says `nativeBridge.ts` is the only place that talks to the native shell. `apps/desktop/src/tauri.ts:1-2` also imports and calls Tauri APIs; `nativeBridge.ts` itself describes exceptions. **Proposed change:** describe the transport seam and name the existing direct Tauri wrappers or exceptions. **Must fix**

10. `docs/reference/architecture.md:38,55` — The Remote section generalizes the loopback-only Tailscale listener to all Remote access and says Remote “never” uses a public bind. The Native method binds host interfaces and requires HTTPS, as documented in `crates/bloblex-daemon/src/remote/native.rs:15,78`. **Proposed change:** distinguish the loopback Tailscale gateway from the interface-bound Native gateway, including Native’s TLS requirement. **Must fix**

11. `README.md:53` — The signed updater feed is described as beta.6, while the release checklist says the rolling beta channel offers beta.35. **Proposed change:** update the feed reference or link readers to the current updater contract. This is separate from the README release-version figure noted in the known limits. **Must fix**

12. `docs/reference/architecture.md:18-20` — Several citations use `main.rs:...` instead of a repository-relative path, unlike the guide’s `path:line` rule; those references are ambiguous on their own. **Proposed change:** use full paths such as `crates/bloblex-daemon/src/main.rs:4299` consistently. **Should fix**

### Missing coverage

13. `docs/reference/architecture.md:33` and `docs/guides/windows-development.md:46-50` — They identify the database path and recommend isolated databases, but don’t give contributors a current schema-migration workflow: where migration order/version is defined, how to test against a scratch database, or how to handle backup and rollback. **Proposed change:** add a short database and migrations guide, or link to an existing current procedure if one exists. **Should fix**