# Live CLI checks (Phase 2b entry gate)

Run by the Director with the user's REAL, authenticated CLIs. Each script sends a handful of trivial prompts ("status", "Reply with the single word OK") in throwaway temp directories, with non-secret sentinel instructions, and prints structure and verdicts only (never raw provider JSON or prompt text). They spend a little real usage: run them only when a CLI version changes or a gate needs re-evidence.

- `live-claude.mjs`, `live-claude2.mjs`: model + effort + instruction FILE, resume with a changed file (default snapshot vs `--system-prompt-snapshot off`), unknown model id, effort evidence (thinking tokens). Env: `CLAUDE_EXE`.
- `live-codex.mjs`, `live-codex-echo.mjs`: `model/list`, `developerInstructions` at start/resume, effort and service tier acceptance, per-turn usage; the echo script sends no prompt.
- `live-opencode.mjs`, `live-opencode-effort.mjs`: ACP model/effort/mode selection with a custom agent from `OPENCODE_CONFIG_CONTENT`, prompt-result usage and cumulative `usage_update` cost, control without the agent mode, effort comparison. Env: `OPENCODE_EXE`, `OC_MODEL`, `OC_EFFORT`.

Results and gate decisions: docs/runtime-capabilities.md, section "Live entry-gate results".
