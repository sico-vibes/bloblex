6 items remain.

docs/guides/windows-development.md:28 — Says updater keys and release hosting still need configuration, contradicting the beta.35 note at line 30 and the release checklist. Update the sentence to distinguish the still-open Windows code signing and clean-install work from the configured updater. **Must fix**

crates/bloblex-storage/src/lib.rs:1218 — The architecture claim that schema-changing migrations take a verified backup is too broad: `migrate_context_failure_class` alters the schema without calling `verified_backup`. Qualify the claim to migrations that use the backup step, or ensure this migration also backs up. **Must fix**

docs/reference/architecture.md:35,44 — The migration and Native TLS citations use shortened paths (`lib.rs` and `native.rs`), contrary to the style guide’s repository-relative citation rule. Use full paths consistently. **Should fix**

docs/operations/operating-model.md:1,4-5 — The title still calls this “the rules in effect today”; its status says “current” despite noting it is an outdated summary, and its last-updated date predates the front-block changes. Retitle it as a dated summary, use a status that does not imply current rules, and update the date. **Should fix**

docs/README.md:11 — The index says the operating model is dated and that AGENTS.md wins, but omits that it was not updated for the 16–19 October amendments. Add that caveat so it matches the document’s front block. **Should fix**

docs/STYLE.md:48 — The qualifier rule is not consistently followed: for example, `operating-model.md:4`, `architecture.md:4` and `PROTOCOL.md:4` place qualifiers after the status word without a semicolon. Require the semicolon consistently or clarify that it is optional. **Should fix**