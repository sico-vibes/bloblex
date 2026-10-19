# OpenCode effort evidence, 2026-10-13

> **What this is:** Evidence for OpenCode effort levels, 13 October 2026.
> **Status:** evidence; immutable record
> **Last updated:** 2026-10-13

Lane: OpenCode (backend). Method: live probes against the installed `opencode` CLI in throwaway
temp directories with an isolated `OPENCODE_CONFIG_CONTENT`. Prompts were trivial
("Reply with the single word OK"); no user config, session, or credential value was read or logged.
This record keeps names and protocol structure only.

Installed CLI: **OpenCode 1.18.35** (docs previously recorded 1.18.34; this snapshot is 1.18.35),
Node v24.11.1, on the user's real signed-in profile.

## 1. `opencode models --verbose`

44 model blocks were emitted; 34 carried a non-empty `variants` object. Block: **live no-model
probe**, real host.

For three models with variants and one without:

| model id | `variants` keys | per-variant keys | `capabilities.reasoning` |
|---|---|---|---|
| `opencode-go/deepseek-v4.1-flash` | `low`, `high`, `max` | `reasoningEffort` | true |
| `opencode-go/grok-4.7` | `low`, `medium`, `high`, `xhigh` | `reasoningEffort`, `reasoningSummary`, `include` | true |
| `opencode-go/kimi-k3` | `max` | `reasoningEffort` | true |
| `opencode-go/gpt-6-luna` | `none`, `low`, `medium`, `high`, `xhigh`, `max` | `reasoningEffort`, `reasoningSummary`, `include` | true |
| `opencode/big-pickle` | (empty) | – | true |

There is no `default` key in any `variants` object. `variants` is therefore the authoritative
per-model level source, and `default` is not a level.

## 2. ACP config options (structure only)

Block: **live no-model probe**, real host. `initialize` → `initialized` → `session/new`, then
`session/set_config_option` for `model`.

`session/new` returned three `configOptions` while `OPENCODE_CONFIG_CONTENT` already named
`opencode-go/deepseek-v4.1-flash` as the process model:

| id | category | currentValue | option values |
|---|---|---|---|
| `model` | `model` | `opencode-go/deepseek-v4.1-flash` | 44 model ids (names omitted) |
| `effort` | `thought_level` | `low` | `low`, `high`, `max`, `default` |
| `mode` | `mode` | `build` | `build`, `plan` |

After `session/set_config_option` for `model` the same three options were echoed; the response
carried only the `configOptions` array. The `effort` option's category is `thought_level` (not
`effort`), so a client that finds it by hard-coded id is relying on the id, not the category.
`default` is a synthetic option value that is not a `variants` key.

`session/get_config_options` is not a method this build answers; the adapter does not use it.

## 3. Two effort runs

Block: **live prompt probe**, real host. Two prompts were sent in one ACP session, selecting
`effort` first via `session/set_config_option` (`configId: effort`). Both were accepted and both
turns completed with `stopReason: end_turn` and `text: "OK"`.

| run | selected effort | currentValue after set | stopReason | prompt `usage` | `usage_update` (cumulative) |
|---|---|---|---|---|---|
| A | `low` | `low` | `end_turn` | input 12551, output 2, total 14345, cachedRead 1792 | used 14343, size 1000000, cost 0.001889226 USD |
| B | `high` | `high` | `end_turn` | input 12564, output 2, total 14358, cachedRead 1792 | used 14356, size 1000000, cost 0.003780402 USD |

The cost/`used` figures rise across turns because `usage_update.cost.amount` is a session-cumulative
snapshot, so run B is not a clean per-turn deltas. The two runs' token buckets are essentially
identical apart from ordering. **No behaviour change is claimed.** The selection round-trip is
accepted and the turn completes; that is the only conclusion drawn. Evidence stays `provider_echo`.

## 4. Conclusion

`opencode-go/deepseek-v4.1-flash` **does expose selectable effort levels**: `low`, `high`, `max`.
The owner's expectation is correct for this model. There is no "this model has no effort levels"
case for DeepSeek V4.1 Flash. The disabled control in the app is caused by the daemon gating
OpenCode `thinking` behind `exec_gate.opencode.thinking` (default off) and labelling the evidence
`none`, not by an absent provider capability.

Models with an empty `variants` object (for example `opencode/big-pickle`) expose no `effort`
option; those get a truthful "no effort levels" report and no picker.
