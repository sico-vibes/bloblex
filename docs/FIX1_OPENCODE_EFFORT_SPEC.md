# Fix 1B spec: OpenCode effort levels for DeepSeek (and every OpenCode model that has variants)

Owner: OpenCode lane (backend only). Reviewer: Director. **Do not touch `apps/desktop/src`** (the Director builds the UI) **and do not touch `crates/bloblex-daemon/src/team.rs`, `memory.rs`, `automations.rs`, `queue.rs`, `retry.rs`, `questions.rs`** (another lane edits team/leader code in parallel).
Scope: `crates/bloblex-adapter-acp` (OpenCode runs through it; `crates/bloblex-adapter-opencode/src/lib.rs` is a 5-line re-export), the OpenCode-related parts of `crates/bloblex-daemon/src/main.rs` (catalog, `runtime.capabilities`, session model lock), `crates/bloblex-agent-core` if types need a field, tests, `docs/runtime-capabilities.md`, `docs/evidence/`.

## Symptom (owner report)
In a blob running OpenCode with `DeepSeek V4.1 Flash` (`opencode-go/deepseek-v4.1-flash`) the effort control is disabled and shows the tooltip "OpenCode doesn't let Bloblex pick an effort level yet, so it uses the model's own default." The owner wants an effort selector there, like Codex and Claude have. Today the daemon test (`main.rs` ~L5216) even builds this model with `supportedThinking: []`.

Facts already known (see `docs/runtime-capabilities.md` O1, O6): `opencode models --verbose` lists per-model `variants`; over ACP, after `session/set_config_option` for `model`, a config option `effort` (category `thought_level`) appears with values like `low|medium|high|default`; `opencode run --variant high` is the CLI-level equivalent. The daemon gates OpenCode effort behind `exec_gate.opencode.thinking` (default off) with evidence `none` (`main.rs` ~L1479 and ~L1499).

## Rules
- Never run `git commit`, `git push`, `git checkout`, `git stash`. Leave changes uncommitted. Work only inside this worktree. Never read or list paths outside it (except running the installed `opencode` CLI, below).
- Live probes use the installed `opencode` CLI in throwaway temp dirs with an isolated `OPENCODE_CONFIG_CONTENT`; never touch the user's real OpenCode config or sessions; never send a prompt that does more than "Reply with the single word OK" and use at most 4 prompts in total. `scripts/live-checks/live-opencode-effort.mjs` already does most of this: read it and reuse it.
- Cargo: `CARGO_TARGET_DIR=D:/b-p1`.
- Match repo style. No `unwrap()` in non-test code you add. No raw provider JSON may reach the UI; only normalized fields.

## Task A: investigate with evidence (write it down first, in `docs/evidence/opencode-effort-2026-10-13.md`)
1. `opencode models --verbose`: for `opencode-go/deepseek-v4.1-flash` (and 2 other models with variants), what exactly is the `variants` object (names, any per-variant options)? Is it empty for this model?
2. ACP: start `opencode acp` with an isolated config selecting that model, `session/new`, then `session/set_config_option` model; record the `configOptions` ids, categories, current value and option values before and after model selection, **names and structure only**. Does `effort` appear for this model? What are its values? What is `currentValue`?
3. One prompt ("Reply with the single word OK") with a non-default effort selected via `session/set_config_option`, to confirm the option is accepted and the turn completes; record `usage_update`/token facts if they differ between `low` and `high` (two prompts total for this), but do not claim behaviour change unless the numbers show it.
4. If DeepSeek V4.1 Flash really exposes no variants, say so clearly: then the right UX is an honest "this model has no effort levels", and the owner's expectation is wrong for this model only. In that case still implement Tasks B and C for models that do.

## Task B: expose real effort levels from OpenCode's own catalog
1. Populate `ModelInfo.supported_thinking` (and `default_thinking` when OpenCode reports one) for every OpenCode model from the verbose catalog's `variants` keys (normalise names, keep OpenCode's own spelling; keep deterministic ordering low -> high; `default` is a synthetic "use the model's default" and must not be listed as a level but must stay selectable as "no explicit effort").
2. Make `runtime.capabilities` for OpenCode report `thinking.supported` and `enabled` **from the catalog**, per model: enabled exactly when the selected model has at least one level. Remove the need for `exec_gate.opencode.thinking` to be hand-enabled: that gate should default to **on** for OpenCode (the live-checks evidence above is the justification) but keep it as an off-switch if it already exists. Evidence label stays honest (`provider_echo` or equivalent, never claim `usage_effect` unless Task A step 3 showed it).
3. Update the daemon unit tests that assert the old behaviour (`opencode_thinking_support_and_gate_share_one_source_of_truth` and neighbours) and add new ones: a model with variants gets levels and is enabled; a model without variants gets none and a truthful reason string (add a `reason` field for a disabled thinking setting if one does not exist: `"model_has_no_effort_levels"` vs `"provider_unsupported"`, camelCase JSON, so the UI can say which).

## Task C: apply the selection
Make sure a chosen level really is sent: at session start and when the session model lock changes, the ACP adapter calls `session/set_config_option` for the effort option (category `thought_level`, discovered by category, not by hard-coded id when category is present), after the model is set (the option only exists after model selection). Unknown/unsupported level -> typed error, never a silent drop. Cover with the fake ACP peer (`crates/bloblex-adapter-acp/tests` or the existing fake binary): effort selection order, missing option, rejected value.

## Gates (run and report real output)
```
CARGO_TARGET_DIR=D:/b-p1 cargo test -p bloblex-adapter-acp
CARGO_TARGET_DIR=D:/b-p1 cargo test -p bloblex-daemon
CARGO_TARGET_DIR=D:/b-p1 cargo test --workspace --exclude bloblex-desktop
```

## Final report (plain text, last message)
1. Files changed. 2. Task A findings in plain words (does DeepSeek V4.1 Flash expose levels? which?). 3. Per task: what changed + exact test names. 4. Gate output. 5. Unverified items and spec mismatches. Fake-peer verified vs live-verified must be labelled separately.
