# Wave 14 follow-up brief: OpenCode effort race, the question tool, error text in the MCP

**Lane:** Claude Sonnet 5.5 at medium effort.
**Worktree:** `D:\wv15`, branch `wave14/opencode-fixes`, with Cargo target `D:\wv15\target`.

**Rules:**
- Never run `git commit`.
- Change nothing outside the worktree.

**Read first:** `.claude/skills/bitbots-development/SKILL.md`, with its `references/codebase-map.md` and `references/lessons.md`.

**Research:** this session's scratchpad holds `opencode-effort-review.md` (Haiku's research, with file:line evidence), the probes `acp_probe.py` and `acp_probe2.py`, the test-daemon driver `mcp_smoke.py`, and the `shim\` folder (an `opencode` wrapper that logs ACP traffic). The scratchpad is `C:\Users\SicoZ\AppData\Local\Temp\claude\D--Basem-s-Coding-Blolblex\78f0ecdc-5dc6-4b6e-808c-ffcc0b851c54\scratchpad`. OpenCode's source is cloned at `scratchpad\opencode`, T3 Code's at `scratchpad\t3code`.

## 1. "OpenCode rejected the effort setting" (a race inside OpenCode)

### What was seen

This is reproduced and logged; the logs were taken through the shim (29 October 2026).

- **When it happens:** a bot with instructions (its own, or Bitbots' team instructions, which every bot gets when there are several) switches OpenCode to the injected `bloblex` agent before setting effort.
- **The sequence:** Bitbots sends model, then `mode=bloblex`, then `effort=high`. OpenCode accepts each call.
- **The failure:** in 3 of 4 runs, the effort reply echoes `currentValue: "default"` instead of `"high"`. `select()` in `crates/bloblex-adapter-acp/src/lib.rs` (around 760–800) then fails the turn with `ERR_EFFORT_REJECTED`.
- **Without instructions** there is no mode switch, and it never failed.
- **Where it starts:** OpenCode's agent switch publishes a model without the variant. When that event lands after the effort call, it replaces the model and drops the variant (OpenCode `packages/cli/src/acp/sessions.ts` 54–91, `config-option.ts` 118–132).

### Fix, in the ACP adapter

1. **Send model and effort as one value**, as T3 Code does with its model ref. OpenCode's ACP accepts a model value with the variant attached, `provider/model/<variant>` (`packages/cli/src/acp/config-option.ts` `parseModelSelection`, lines 103–116; `requireModel` 118–132).
   - **When the effort is not `default`** and the model's options offer an effort: after the mode is set, send one `session/set_config_option` with `configId: "model"` and `value: "<model>/<effort>"`.
   - **Read the result:** the model echo is the base id, and the effort echo is in the same response. Record `applied.model` and `applied.effort` from that one reply.
   - **When the model has no effort option**, or the effort is `default` or empty, keep today's calls.
2. **Order:** mode first, then model-with-effort. The agent switch then happens before the variant is set.
3. **Verify, and retry.** If the effort echo still differs, wait about 200 ms and set it again (effort alone, or the combined model value), at most 2 more times, before failing.
4. **Keep the reason.** On failure, put OpenCode's RPC error message, or the echoed value against the wanted one, in the failure reason that reaches the UI's Details. Today the error is discarded around line 786.
5. **Don't** put the variant into the injected agent config (`exec::config_content`). It is fixed at process start, and a variant the model lacks could break the start.

### Tests

These are adapter-crate tests with a fake ACP peer; there is a `fake-acp-peer` binary and existing peer tests to copy.

- The peer echoes `default` on the first effort set and the right value on the second: the turn succeeds.
- The peer always echoes `default`: the failure reason names both values.
- The combined `model/<variant>` value is sent in one call when effort is offered, and the old path is used when it isn't.
- An RPC error's message reaches the failure reason.

### Live check

Run a throwaway daemon from PowerShell; loopback HTTP from the Bash tool is reset here:

```
$env:SMOKE_MODEL="opencode-go/deepseek-v4.1-flash"; $env:SMOKE_EFFORT="high"; $env:SMOKE_INSTR="1"; $env:SMOKE_AGAIN="5"
python -u -I <scratchpad>\mcp_smoke.py D:\wv15\target\debug\bitbotsd.exe
```

Optionally also set `SMOKE_SHIM=<scratchpad>\shim` to log the traffic to `shim\acp-*.log`. All 6 conversations must answer "bong". Before the fix, 3 of 4 failed.

## 2. OpenCode's `question` tool always fails inside Bitbots

- **Why it fails:** Bitbots sends `clientCapabilities: {}` in `initialize` (`lib.rs` ~480 and `catalog.rs` ~161). OpenCode 2.2 asks questions through ACP elicitation (`elicitation/create`, form mode), which needs `clientCapabilities.elicitation.form`. Without it, the question is cancelled and shows as a failed tool card. The bot then carries on in text.
- **Do now:** add `"permission": {"question": "deny"}` to the injected `OPENCODE_CONFIG_CONTENT` (`exec::config_content`). Bots then rely on Bitbots' own `ask_user` team tool where it is offered.
  - **Check by probe first** that the config deny wins over the build agent's built-in `question: allow` (`scratchpad\opencode\packages\core\src\plugin\agent.ts:60`; precedence in `permission.ts` 86–96 and 159–164). A real OpenCode turn whose prompt asks it to use its question tool should show the tool refused, or not offered.
  - **If the deny does not win**, report it, and do not ship a half-measure.
- **The card:** hide tool cards for a refused or failed `question` call where ACP tool updates are translated, so no failed card appears.
- **Later (not this brief):** support elicitation as a real Bitbots question card.

## 3. The MCP should say why a turn failed

`crates/bloblex-daemon/src/external.rs`:

- **`wait_for_turn`:** when the turn ended in an error, include `error: {message, detail}`, the same text the app shows ("Something went wrong…" and its Details line). It survives a reload, so find where it is stored.
- **`read_conversation`:** include error notices as `{role: "error", text}`.
- **`turn_metrics`:** add `error` for failed turns.
- **Tests:** a failed turn through a fake adapter shows its error in all three.

## Gates (from `D:\wv15`)

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
- `cargo clippy --workspace --exclude bloblex-desktop --all-targets -- -D warnings`
- `npm run typecheck`
- `npm test`

## Report

- Files changed, with one line each.
- Tests added and their results.
- The live check (`n` of 6).
- The probe result for the question deny.
- Anything not verified.
- A proposed update for the skill's `lessons.md` (in the report, not the file).
