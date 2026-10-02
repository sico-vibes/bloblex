# Runtime capabilities (Phase 1.5)

Verified 2 October 2026 against the CLIs installed on this machine: Claude Code **2.1.286** (`claude`), codex-cli **0.159.3** (`codex`), OpenCode **1.18.34** (`opencode`). All three are npm shims under `%AppData%\Roaming\npm` and were invoked from PowerShell. No production code was changed. No model completion was run.

## How to read this

| Status | Meaning |
| --- | --- |
| CONFIRMED | The installed CLI, its package binary, or a schema generated from that CLI showed this in this session. |
| REFUTED | A plan claim is contradicted by that evidence. |
| PARTIAL | One part is confirmed and another was not executed. |
| UNVERIFIED | Static evidence did not settle it, and no live check was run. |

Evidence is a command plus a trimmed excerpt, or `file:line` in this repo or in the installed package. Excerpts are shortened. Nothing here is a credential, auth file, or account email.

Checked-in Codex schemas at `docs/qa-schema/codex-0.159.3/` match a fresh `codex app-server generate-json-schema` written only under `%TEMP%\bloblex-cap-codex-schema` (ThreadStartParams, ThreadResumeParams, and TurnStartParams property sets are equal; `model/list` is present).

## Claude Code 2.1.286

| ID | Plan claim | Status | Evidence | Implication for Phase 2b |
| --- | --- | --- | --- | --- |
| C1 | `--model` accepts aliases fable/opus/sonnet/haiku and full ids; invalid ids fail | CONFIRMED | `claude --help`; flag probe; `list_models` response; alias table in `claude.exe` | Accept aliases and full ids. An unknown id is a warning, not a hard CLI error. |
| C2 | `--effort <level>` exists and applies to `-p` stream-json | PARTIAL | `claude --help`; flag probe with `-p`; `list_models` effort arrays | Levels are `low`, `medium`, `high`, `xhigh`, `max`. Unknown values are ignored. Haiku advertises no effort. The API request body was not captured. |
| C3 | Instructions via `--append-system-prompt-file`, out of argv, and how they survive resume | PARTIAL | `claude --help` (`--system-prompt-snapshot`); flag probe | File flags exist. Default snapshot keeps the first prompt and ignores a different prompt on later launches until compaction. Resume was not executed. |
| C4 | Model catalog is stream-json `list_models`, else a static fallback | CONFIRMED | stdin `control_request` on a `-p` stream-json process | `list_models` works. A static fallback is unnecessary for 2.1.286. There is no models subcommand. |
| C5 | No speed / service-tier flag | CONFIRMED | `claude --help`; `--speed` and `--service-tier` rejected | Hide the speed picker. Some models still advertise `supportsFastMode`, and usage objects can report `speed`, but no spawn flag was found. |
| C6 | How the Claude adapter launches, and which flags can be added | CONFIRMED | `crates/bloblex-adapter-claude/src/lib.rs:202-221` and `:373-382` | Add `--model`, `--effort`, and `--append-system-prompt-file` beside the existing permission flags. Do not let the user replace protocol or permission flags. |
| C7 | stream-json `result` carries input/output/cache tokens, total cost, and model | CONFIRMED | Zod schema strings in `claude.exe` 2.1.286 | Read `usage.*`, `total_cost_usd`, and `modelUsage` keys. The result object has no top-level `model`. Not observed on a live completion. |

### C1

`claude --help` says `--model` takes "an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name." `--model haiku|fable|sonnet|opus` and `--model bloblex-not-a-model`, each with `-p` and no prompt, were accepted as flags. The invalid id warned and then failed only because no prompt was supplied:

```text
"bloblex-not-a-model" isn't described by this version's model catalog; ...
Until then auto-compact keeps this session within 200k tokens
```

The installed binary's alias table maps, for the first-party default: `opus` → `claude-opus-5-5`, `sonnet` → `claude-sonnet-5-5`, `haiku` → `claude-haiku-4-5`, `fable` → `claude-fable-5-1`. The live `list_models` catalog (below) resolves haiku to `claude-haiku-4-5-20251001` and lists fable by full id `claude-fable-5-1`. The string `API model not found:` exists in the binary; an invalid id was not sent to the API.

### C2

```text
--effort <level>   Effort level for the current session (low, medium, high, xhigh, max)
```

`--effort low|medium|high|xhigh|max -p` reached the missing-prompt error, so the flag is accepted on `-p`. An unknown level does not fail the process:

```text
Warning: Unknown --effort value 'bogus' — ignoring it and using the default effort.
Valid values: low, medium, high, xhigh, max.
```

`list_models` gives opus/sonnet/fable `supportedEffortLevels` of low, medium, high, xhigh, max. Haiku has `supportsEffort: null` and `supportedEffortLevels: null`. Whether `-p --output-format stream-json` puts the level on the API request was not captured.

### C3

Help lists `--append-system-prompt <prompt>` and `--system-prompt <prompt>` (text in argv). A probe of the file forms treated the next argument as a path:

```text
Error: Append system prompt file not found: ...\-p
Error: System prompt file not found: ...\-p
```

So `--append-system-prompt-file` and `--system-prompt-file` exist and keep the prompt body out of argv. `--system-prompt-snapshot` defaults to `on`: the first request records `--system-prompt` or `--append-system-prompt`, and every later request and resume sends that record even if a later launch passes different text, until compaction. `off` re-renders every request. The snapshot sentence names the inline flags, not the `-file` forms. No `--resume` / `--continue` process was started.

### C4

There is no `models` subcommand. A stream-json process (adapter flags plus `--no-session-persistence`, no user message) answered:

```text
{"type":"control_request","request_id":"m1","request":{"subtype":"list_models"}}
→ control_response subtype success, 5 models
```

| value | resolvedModel | supportsFastMode | effort levels |
| --- | --- | --- | --- |
| default | claude-opus-5-5 | true | low, medium, high, xhigh, max |
| opus | claude-opus-5-5 | true | same |
| claude-fable-5-1 | claude-fable-5-1 | null | same |
| sonnet | claude-sonnet-5-5 | null | same |
| haiku | claude-haiku-4-5-20251001 | null | none |

The binary describes this subtype as the worker model catalog (`toModelInfos()`). Typing a custom id must still be allowed; the CLI does not reject unknown ids at startup.

### C5

`claude --help` has no speed or service-tier option. `--speed fast` and `--service-tier fast` both exit with `unknown option`. The usage schema in the binary describes `service_tier` as "standard, priority or batch" and `speed` as "standard or fast", and the result schema has `fast_mode_state`. `fastMode` is a settings/keybinding name. No `--fast` or `CLAUDE_CODE_FAST_MODE` string was found. Hide the picker; do not invent a flag.

### C6

`ClaudeAdapter::start` (`lib.rs:202-221`) spawns `executable` plus runtime args, then:

`-p --output-format stream-json --input-format stream-json --verbose --include-partial-messages --include-hook-events --permission-mode default --permission-prompt-tool stdio`, plus `--resume <id>` or `--session-id <uuid>`.

`prompt` (`lib.rs:382`) writes one stdin JSON line: `{"type":"user","message":{"role":"user","content":<text>}}`. Permission replies are `control_response` lines (`lib.rs:42`).

`--permission-mode default` is accepted. Help's choice list shows `manual` instead of `default`; the binary maps `manual` → `default` and still contains `default` in the internal set. `bogus` is rejected:

```text
argument 'bogus' is invalid. Allowed choices are acceptEdits, auto,
bypassPermissions, manual, dontAsk, plan.
```

Flags that can be added without replacing that flow: `--model`, `--effort`, `--append-system-prompt-file <app-owned path>`, and `--system-prompt-snapshot off` when instructions must change on resume. Do not put instruction text in `--append-system-prompt` (it lands in argv).

### C7

The success `result` schema in `claude.exe` includes `total_cost_usd`, `usage`, `modelUsage` (map of model id → usage), `num_turns`, `session_id`, and `stop_reason`. It does not include a top-level `model`. `usage` is `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, nullable `cache_creation`, `server_tool_use`, `service_tier`, and optional `speed`. The adapter (`lib.rs:132-141`) reads `usage.input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and `result.model`, and does not read `total_cost_usd` or `modelUsage`. Provider-side proof of the model is a `modelUsage` key, or `model` on an assistant stream message, not `result.model`.

## Codex CLI 0.159.3

| ID | Plan claim | Status | Evidence | Implication for Phase 2b |
| --- | --- | --- | --- | --- |
| X1 | `thread/start` fields for model, effort, service tier, instructions, cwd, approval, sandbox, config | CONFIRMED | generated `v2/ThreadStartParams.json`; same file under `docs/qa-schema/codex-0.159.3/` | Use the camelCase RPC fields below. Effort is inside `config`, not a top-level field. |
| X2 | `thread/resume` and `turn/start` can override model, effort, and serviceTier per turn | CONFIRMED | `ThreadResumeParams.json`, `TurnStartParams.json` | Those overrides apply to that turn and subsequent turns. `serviceTierForTurn` is the turn-only speed override. |
| X3 | `codex debug models` returns slugs, reasoning levels, default level, and service tiers; compare with `model/list` | CONFIRMED | `codex debug models`; `model/list` in the generated schema | Both exist. Prefer `model/list` inside the app-server the adapter already speaks. |
| X4 | Valid reasoning effort per model, and the unsupported combination | PARTIAL | `codex debug models` | Levels differ by slug and include `ultra` on some models. A rejected combination was not sent. |
| X5 | How "fast" is expressed | CONFIRMED | `codex debug models`; `TurnStartParams.serviceTierForTurn` | The catalog id is `priority` (name "Fast"), not the string `fast`. |
| X6 | Developer instructions persist across resume and per turn | PARTIAL | start/resume params vs `TurnStartParams` | Re-pass `developerInstructions` on start and resume. It is not a `turn/start` field. Persistence without re-sending was not executed. |
| X7 | Token-usage notification names and fields | CONFIRMED | `ThreadTokenUsageUpdatedNotification.json`; adapter `lib.rs:159-172` | Notification is `thread/tokenUsage/updated`. It has no model and no dollar cost. |
| X8 | How the Codex adapter calls `thread/start` today | CONFIRMED | `crates/bloblex-adapter-codex/src/lib.rs:46-48` and `:278` | Today it sends only cwd, approvalPolicy, and sandbox. |

### X1

`codex app-server generate-json-schema --out <temp>` (2 October 2026) produced the same `thread/start` properties as `docs/qa-schema/codex-0.159.3/v2/ThreadStartParams.json`:

| Setting | Field |
| --- | --- |
| Model | `model` (string or null) |
| Provider | `modelProvider` |
| Effort | `config.model_reasoning_effort` (snake_case inside `config`; the config object is open) |
| Speed | `serviceTier` (string or null). `config.service_tier` also exists on the config schema |
| Developer instructions | `developerInstructions` |
| Base instructions | `baseInstructions` |
| Working directory | `cwd` |
| Approval | `approvalPolicy`: `untrusted`, `on-request`, `never`, or a `granular` object |
| Sandbox | `sandbox`: `read-only`, `workspace-write`, `danger-full-access` |
| Other overrides | `config` (`additionalProperties: true`) |

`thread/start` has no top-level `effort` or `model_reasoning_effort`.

### X2

`thread/resume` requires `threadId` and repeats `model`, `serviceTier`, `developerInstructions`, `baseInstructions`, `config`, `approvalPolicy`, `sandbox`, and `cwd`. Its `model` description says "Configuration overrides for the resumed thread".

`turn/start` requires `threadId` and `input`. Optional overrides, each described as applying to this turn and subsequent turns:

- `model`
- `effort` (non-empty string)
- `serviceTier`
- `cwd`, `approvalPolicy`, `sandboxPolicy`

`serviceTierForTurn`: "Override the service tier only when this request starts a new turn. Use `"default"` for standard speed. Omitted or null inherits the thread's tier. Does not change the thread's tier."

There is no developer-instructions field on `turn/start`.

### X3

`codex debug --help` includes `models` ("Render the raw model catalog as JSON"). `codex debug models` wrote a UTF-16 JSON object `{ "models": [ ... ] }` with 10 entries. Item keys include `slug`, `display_name`, `default_reasoning_level`, `supported_reasoning_levels` (`[{ "effort": "..." }]`), `service_tiers` (`[{ "id", "name" }]`), and `additional_speed_tiers`. The payload also contains large `model_messages` instruction templates; do not log that command's raw stdout.

`model/list` is a client request in the generated schema (`ModelListParams`: `cursor`, `includeHidden`, `limit`). `ModelListResponse.data[]` uses camelCase: `id`, `model`, `displayName`, `defaultReasoningEffort`, `supportedReasoningEfforts[]`, `serviceTiers[]` (`id`, `name`, `description`), `defaultServiceTier`, and deprecated `additionalSpeedTiers`. It was not called live.

Recommend `model/list` on the existing app-server for `runtime.models`. Keep `codex debug models` as a CLI cross-check. Do not parse `debug models` in the daemon: the extra instruction text is large and must not be stored.

### X4 and X5

Slugs returned by `codex debug models`, with default effort and supported efforts. Every entry had `additional_speed_tiers: ["fast"]` and `service_tiers: [{ "id": "priority", "name": "Fast" }]`.

| slug | default | efforts |
| --- | --- | --- |
| gpt-6.1-sol | low | low, medium, high, xhigh, max, ultra |
| gpt-6-astra | low | low, medium, high, xhigh, max, ultra |
| gpt-6-sol | medium | low, medium, high, xhigh, max, ultra |
| gpt-6-luna | medium | low, medium, high, xhigh, max |
| gpt-reserve | medium | low, medium, high, xhigh, max |
| gpt-5.6-sol | low | low, medium, high, xhigh, max, ultra |
| gpt-5.6-terra | medium | low, medium, high, xhigh, max, ultra |
| gpt-5.6-luna | medium | low, medium, high, xhigh, max |
| gpt-5.5 | medium | low, medium, high, xhigh |
| codex-auto-review | medium | low, medium, high, xhigh, max |

`ReasoningEffort` in the schema is any non-empty string, not an enum. What the server does with an effort the model does not list was not sent. The plan's `service_tier` values `standard` / `fast` do not match this catalog: fast is tier id `priority`. Standard speed is omit / null, or `"default"` on `serviceTierForTurn`.

`thread/start` and `thread/resume` responses echo top-level `model`, `reasoningEffort`, and `serviceTier` (required model/cwd/approval/sandbox on start; `reasoningEffort` and `serviceTier` optional). `thread.model` and `thread.reasoningEffort` are described as the configured value, "not per-turn execution telemetry." `developerInstructions` is not echoed. `thread/settings/updated` carries `model`, `effort`, and `serviceTier`.

### X6

Supply `developerInstructions` on `thread/start` and again on `thread/resume` when the text must be present. `turn/start` cannot change it. Whether the server keeps the original text across a resume that omits the field was not executed. `baseInstructions` is a separate nullable string on the same two requests.

### X7

Method `thread/tokenUsage/updated`. Params: `threadId`, `turnId`, `tokenUsage.last` and `tokenUsage.total`. Each breakdown has `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens` (default 0), `outputTokens`, `reasoningOutputTokens`, `totalTokens`. No `model` and no cost field. The adapter reads `tokenUsage.last` and `params.model`, so model on this notification will be empty. Use the `model` echoed by `thread/start` / `thread/resume` or `thread/settings/updated` as the provider-side model proof.

### X8

Spawn (`lib.rs:46-48`): `app-server --listen stdio://`. Initialize (`lib.rs:232`): `initialize` with `clientInfo` Bloblex 0.1.0 and `capabilities.experimentalApi: false`, then `initialized`. `thread/start` (`lib.rs:278`):

```json
{"cwd":"<project>","approvalPolicy":"on-request","sandbox":"workspace-write"}
```

`thread/resume` (`lib.rs:305-308`): `{"threadId","cwd"}`. `turn/start` (`lib.rs:336-339`): `{"threadId","input":[{"type":"text","text":"..."}]}`. No model, effort, serviceTier, or instructions are sent today.

## OpenCode 1.18.34

| ID | Plan claim | Status | Evidence | Implication for Phase 2b |
| --- | --- | --- | --- | --- |
| O1 | `opencode models --verbose` lists provider/model ids, variants, and cost/limits | CONFIRMED | command output, 8 models | Parse provider/id, `variants`, `cost`, and `limit`. This machine's verbose list was only OpenCode Zen free models. |
| O2 | `OPENCODE_CONFIG_CONTENT` is honoured and can set an agent prompt and model | CONFIRMED | binary merge plus `opencode debug config` | Env JSON is a real local-scope merge. A custom agent is not the active mode until ACP selects it. |
| O3 | ACP can choose model, mode, and variant per session | CONFIRMED | `opencode acp` handshake in a temp XDG home | Use `session/new` `configOptions`, `session/set_config_option`, and `session/set_model` (`modelId`). |
| O4 | Per-session instructions and whether they persist across turns | PARTIAL | debug config + ACP mode list | Put the prompt on a custom agent and set mode to that agent. Cross-turn survival was not executed. |
| O5 | OpenCode reports no usage/cost on ACP | REFUTED | `ACPUsage.sendUpdate` in `opencode.exe` | Count `session/update` `usage_update` (`used`, `size`, `cost`). Do not treat every run as unreported. A live event was not captured. |
| O6 | Variant values per model and how ACP selects them | CONFIRMED | verbose variants; ACP `effort` option after `set_config_option` | Map thinking to config option id `effort`, which appears only after a model that has variants is selected. |
| O7 | How the OpenCode and ACP adapters launch | CONFIRMED | `bloblex-adapter-opencode` and `bloblex-adapter-acp` | Spawn is `acp --cwd`. `session/new` sends only cwd and `mcpServers`. |

### O1

`opencode models --verbose` printed `provider/model` headers and a JSON object each. Shape: `id`, `providerID`, `name`, `api`, `status`, `cost` (`input`, `output`, `cache.read`, `cache.write`), `limit` (`context`, sometimes `input`, `output`), `capabilities` (including `reasoning`), `variants`. All eight were `providerID: opencode` and reported cost 0 (free catalog prices, not a Bloblex default). Variants:

| id | variant keys |
| --- | --- |
| big-pickle | none |
| ling-3.0-flash-fin-free | low, medium, high |
| longcat-2.5-preview-free | low, medium, high |
| mimo-v2.6-flash-free | none |
| muse-spark-1.3-contributor-free | minimal, low, medium, high, xhigh |
| nemotron-3-ultra-free | none |
| nemotron-3.5-lightning-free | none |
| space-bunny-free | low, medium, high, xhigh, max |

A variant object is typically `{ "reasoningEffort": "<level>" }`. Muse also sets `reasoningSummary` and `include`. No Claude or OpenAI provider ids appeared.

### O2

The binary documents and implements the env var: inline JSON is parsed and merged as a final local-scope config (`process.env.OPENCODE_CONFIG_CONTENT`). With only that variable set for one process:

```text
opencode debug config
```

resolved:

```json
{
  "model": "opencode/big-pickle",
  "agent": {
    "bloblex-cap": {
      "mode": "primary",
      "model": "opencode/big-pickle",
      "prompt": "BLOBLEX_CAP_MARKER reply only OK"
    }
  }
}
```

Minimal config that did this:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode/big-pickle",
  "agent": {
    "bloblex-cap": {
      "mode": "primary",
      "model": "opencode/big-pickle",
      "prompt": "BLOBLEX_CAP_MARKER reply only OK"
    }
  }
}
```

No model completion was used. The username field from the resolved config is omitted.

### O3

`opencode acp --help` only documents server flags (`--cwd`, logging, `--pure`). Methods come from the protocol. A handshake with `XDG_*` pointed at a temp directory (no user prompt) returned:

`initialize` result: `protocolVersion: 1`, `agentInfo` OpenCode 1.18.34, `agentCapabilities.loadSession: true`, `sessionCapabilities` close/fork/list/resume, `promptCapabilities` embeddedContext and image. No model list on initialize.

`session/new` params used by Bloblex (`cwd`, `mcpServers: []`) succeeded. Result keys were only `sessionId` and `configOptions` (no `models` / `availableModels` object on this response):

- `model` select, current `opencode/big-pickle`, 9 values. The extra id versus `models --verbose` was `opencode/fledge-alpha-free`.
- `mode` select, current `build`, values `build` and `plan`.

`session/set_config_option` with `configId: "model"` and `value: "opencode/ling-3.0-flash-fin-free"` stuck and added an `effort` option (see O6).

`session/set_model` requires `modelId` (string). `{"sessionId","modelId":"opencode/big-pickle"}` returned an empty result. `model` instead of `modelId` returned invalid params: `modelId` expected string, received undefined.

The client notification `initialized` is rejected (`Method not found`). `session/new` still works if that notification is skipped. Bloblex sends it today (`bloblex-adapter-acp/src/lib.rs:357`).

### O4

Instructions travel as an agent `prompt` inside `OPENCODE_CONFIG_CONTENT`, not as ACP prompt text. On a second handshake with the O2 config, `mode` values were `build`, `bloblex-cap`, and `plan`, and current mode stayed `build`. The custom prompt is therefore not active until `session/set_config_option` sets `configId: "mode"` to that agent. The env is process-scoped, so a new spawn (including resume, which spawns again) must set it again and select the mode again. No second turn was sent, so survival inside one process was not observed. There is no instructions field on `session/prompt`.

### O5

The plan says OpenCode reports none. The installed `opencode.exe` contains `ACPUsage.sendUpdate`, which emits:

```text
session/update
sessionUpdate: "usage_update"
used, size, cost: { amount, currency: "USD" }
```

It returns early when there is no assistant message, provider id, model id, or context limit. The bundled ACP schema also allows a prompt result `usage` of `inputTokens`, `outputTokens`, `totalTokens`, optional `cachedReadTokens`, `cachedWriteTokens`, and `thoughtTokens`. That prompt-result object was not shown to be filled. No live `usage_update` was captured. The "reports none" claim is still false: the server has an emitter.

### O6

Verbose `variants` are above. Over ACP they show up as config option id `effort`, category `thought_level`, only after the selected model has levels. For `opencode/ling-3.0-flash-fin-free` the option values were `low`, `medium`, `high`, and `default` (current `low`). `default` is not a key in the verbose `variants` object. Models with `"variants": {}` did not show `effort` on `session/new`. Select with `session/set_config_option` `configId: "effort"`.

### O7

`bloblex-adapter-opencode/src/lib.rs:1-5` re-exports `AcpAdapter`. Spawn (`bloblex-adapter-acp/src/lib.rs:44-48`): `executable` + runtime args + `acp --cwd <project>`. `new_session` (`lib.rs:350-362`): `initialize` (`protocolVersion: 1`, empty client capabilities, clientInfo Bloblex 0.1.0), notify `initialized`, then `session/new` with `cwd` and `mcpServers: []`. `prompt` (`lib.rs:435-438`): `session/prompt` with `prompt: [{type:text, text}]`. Probe capabilities set `usage: false` (`lib.rs:336`). No model, mode, effort, or config env is set today.

## Z1. Setting mechanisms

Provider-side proof means a field the runtime itself returns, not Bloblex's snapshot of what it intended to send.

| Runtime | Setting | Mechanism | Scope | Provider-side proof |
| --- | --- | --- | --- | --- |
| Claude | model | `--model` | process spawn; session via `--resume` | `list_models` `resolvedModel`; `result.modelUsage` keys; assistant `model` |
| Claude | thinking | `--effort` | process spawn. Unknown value ignored. Haiku: no levels | not on `result`. No live request capture |
| Claude | speed | none | n/a | `usage.speed` / `supportsFastMode` are reports, not a setter |
| Claude | instructions | `--append-system-prompt-file` | recorded on first request when `--system-prompt-snapshot` is `on` (default); later resume ignores a different text until compaction | snapshot flag help only; not echoed as a result field |
| Claude | extra args | spawn argv | process | not echoed |
| Claude | env | process env | process | not echoed. Do not log values |
| Codex | model | `thread/start.model`, `thread/resume.model`, `turn/start.model` | turn override also sticks for later turns | response `model`; `thread/settings/updated.model` |
| Codex | thinking | `config.model_reasoning_effort` on start/resume; `turn/start.effort` | same, sticks for later turns | response `reasoningEffort`; settings `effort` |
| Codex | speed | `serviceTier` (`priority` = Fast); `serviceTierForTurn: "default"` for standard on one turn | thread, or one turn | response / settings `serviceTier` |
| Codex | instructions | `developerInstructions` on start and resume | not on `turn/start`. Re-pass on resume until persistence is proven | not echoed |
| Codex | extra args | do not use argv for these | n/a | n/a |
| Codex | env | process env only for non-secret process config | process | not echoed |
| OpenCode | model | `OPENCODE_CONFIG_CONTENT` `model`, or ACP `session/set_model` `modelId`, or config option `model` | session once set; env is process | `configOptions` currentValue for `model` |
| OpenCode | thinking | ACP config option `effort` when the model has variants | session, after model selection | `configOptions` id `effort` |
| OpenCode | speed | none | n/a | none found |
| OpenCode | instructions | agent `prompt` in `OPENCODE_CONFIG_CONTENT`, then mode = that agent | process env + session mode. Re-apply on every spawn | mode `currentValue` equals the agent id. Prompt text is not echoed |
| OpenCode | extra args | do not use argv | n/a | n/a |
| OpenCode | env | `OPENCODE_CONFIG_CONTENT` and non-secret process env | process | `opencode debug config` (do not log the raw env) |

## Z2. Custom-arg allowlists

Allowlists only. Anything not listed is rejected. Paths in allowlisted file flags must be files Bloblex created, not a user-supplied path.

**Claude spawn allowlist:** `--model`, `--effort`, `--fallback-model`, `--append-system-prompt-file`, `--system-prompt-snapshot`.

**Never user-controlled for Claude:** `-p` / `--print`, `--output-format`, `--input-format`, `--verbose`, `--include-partial-messages`, `--include-hook-events`, `--permission-mode`, `--permission-prompt-tool`, `--permission-prompts`, `--resume`, `--continue`, `--session-id`, `--fork-session`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--settings`, `--setting-sources`, `--mcp-config`, `--strict-mcp-config`, `--plugin-dir`, `--plugin-url`, `--agents`, `--agent`, `--add-dir`, `--tools`, `--allowed-tools`, `--disallowed-tools`, `--bare`, `--safe-mode`, `--system-prompt` (replaces the prompt and puts text in argv).

**Codex spawn allowlist:** empty. Model, effort, speed, and instructions are JSON-RPC fields on `thread/start`, `thread/resume`, and `turn/start`, not argv. The adapter owns `app-server`, `--listen`, `approvalPolicy`, and `sandbox`.

**Never user-controlled for Codex argv:** `--listen`, `--stdio`, `-c` / `--config`, `-s` / `--sandbox`, `-a` / `--ask-for-approval`, `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `-C` / `--cd`, `--profile`, `--strict-config`, websocket auth flags.

**OpenCode spawn allowlist:** empty. Model, effort, and mode are ACP config options. Instructions are `OPENCODE_CONFIG_CONTENT`.

**Never user-controlled for OpenCode argv:** `acp`, `--cwd`, `--port`, `--hostname`, `--auto`, `--pure`, `-m` / `--model` on the TUI entrypoint, `-c` / `--continue`, `-s` / `--session`, `--prompt`, `--agent`.

**Env:** reject secret-looking keys the same way `settings.set` already does. Never log env values or instruction text. `OPENCODE_CONFIG_CONTENT` is Bloblex-owned, not a user-supplied env blob.

## Z3. Corrections `docs/E2E_PLAN_V2.md` needs

The plan file was not edited.

- **Phase 2b Claude instructions (around lines 100-101).** `--append-system-prompt-file` exists, so the argv fallback is not required for 2.1.286. `--system-prompt-snapshot` defaults to `on`, so re-passing a different file on `--resume` does not replace the recorded prompt until compaction. Pass `--system-prompt-snapshot off` when instructions must change, or treat them as frozen for that session id.
- **Phase 2b Claude effort (line 100).** Accepted levels are `low`, `medium`, `high`, `xhigh`, `max`. An unknown level is ignored, not a hard error. Haiku's `list_models` row has no effort levels.
- **Phase 2b Claude catalog (line 121).** `list_models` works as a stdin `control_request` on stream-json in 2.1.286. Do not start from the static fallback for this version. Keep the fallback only if the control response fails.
- **Phase 2b Claude speed (line 102) and the execution enum (line 58).** No CLI speed flag, so hiding the picker is right. Do not describe speed as absent from the protocol: `supportsFastMode` and `usage.speed` exist, with no setter found.
- **Phase 2b usage gate (lines 129-134).** Claude's proof of model is `result.modelUsage`, not `result.model`. Cost is `total_cost_usd`. The adapter currently reads `result.model` and skips cost.
- **Phase 2b Codex effort (line 105).** Confirmed as `config.model_reasoning_effort` on start/resume and `effort` on `turn/start`. There is no top-level effort on `thread/start`. `turn/start` overrides also stick for subsequent turns.
- **Phase 2b Codex speed (line 106) and line 58.** Do not send `fast` or `standard` as `serviceTier`. Fast is catalog id `priority`. Standard is omit/null, or `serviceTierForTurn: "default"` for a single turn.
- **Phase 2b Codex instructions (line 107).** The field name is `developerInstructions`. It is not on `turn/start` and is not echoed. Re-pass it on resume. `baseInstructions` is a different field.
- **Phase 2b Codex catalog (line 120).** `codex debug models` does return slugs, per-model reasoning levels, a default, and service tiers, in snake_case, plus large instruction templates that must not be logged. `model/list` exists on app-server and is the better `runtime.models` source. Efforts are not one global enum (`ultra` on some slugs; `gpt-5.5` stops at `xhigh`).
- **Phase 2b Codex usage proof (line 134).** `thread/tokenUsage/updated` has token counts and no model. Model proof is the thread/start response or `thread/settings/updated`.
- **Phase 2b OpenCode (lines 109-110).** `OPENCODE_CONFIG_CONTENT` works, but a custom agent prompt is not selected until ACP `mode` is set to that agent (`session/set_config_option`). Effort is ACP config option `effort`, present only when the model has variants, not a spawn flag. Values include a synthetic `default` and differ per model.
- **Phase 2b OpenCode usage (line 131).** Do not assume no usage events. The 1.18.34 binary emits `usage_update` with `used`, `size`, and USD `cost`. Token fields on the prompt result were not shown to be filled. A live event was not captured.
- **Phase 2b OpenCode catalog (line 122).** `opencode models --verbose` works. On this machine it listed eight Zen free models. The ACP model option listed those plus `opencode/fledge-alpha-free`. Do not expect Claude/OpenAI ids from this install.
- **ACP adapter.** `initialized` is rejected by OpenCode 1.18.34 (`Method not found`). `session/new` still succeeds. `session/set_model` takes `modelId`, not `model`.

## Unverified / open questions

- No model completion was run. Claude effort-on-the-wire, Codex rejection of an unsupported effort, Codex `developerInstructions` surviving a resume that omits the field, and a live OpenCode `usage_update` are unexecuted.
- Claude `--system-prompt-snapshot` help names the inline prompt flags. It does not say the `-file` forms are recorded the same way.
- Claude `API model not found` was not provoked. Startup only warns and assumes a 200k window.
- Codex `model/list` was not called. The recommendation rests on the generated schema plus the executed `debug models` catalog.
- Whether `serviceTier: "priority"` is accepted on `thread/start` was not sent. The catalog id and the `serviceTierForTurn` comment are the evidence.
- OpenCode prompt-result `usage.inputTokens` may stay empty even when `usage_update` fires.
- `opencode models --verbose` and the ACP model list disagreed by one id (`fledge-alpha-free`). Which list `runtime.models` should prefer is a product choice.
- How to set Claude fast mode. `supportsFastMode` is true for Opus and no CLI flag was found.

## Commands run

Versions and help, PowerShell, repo not used as the CLI cwd unless noted:

- `claude --version` → `2.1.286 (Claude Code)`
- `codex --version` → `codex-cli 0.159.3`
- `opencode --version` → `1.18.34`
- `Get-Command claude, codex, opencode`
- `claude --help` → `%TEMP%\bloblex-cap-claude-help.txt`
- `codex --help` → `%TEMP%\bloblex-cap-codex-help.txt`
- `opencode --help` → `%TEMP%\bloblex-cap-opencode-help.txt`
- `codex debug --help`
- `codex app-server --help`
- `codex app-server generate-json-schema --help`
- `opencode acp --help`
- `opencode debug --help`
- `opencode debug paths`
- `opencode debug paths` again with `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` under `%TEMP%\bloblex-cap-xdg`

Claude flag probes in `%TEMP%\bloblex-cap-claude-wd`, no prompt, so they stopped before a completion: `--permission-mode` default, manual, and bogus; `--effort` low, medium, high, xhigh, max, and bogus; `--model` haiku, fable, sonnet, opus, and `bloblex-not-a-model`; `--append-system-prompt-file`, `--system-prompt-file`, `--append-system-prompt`, `--system-prompt`; `--speed fast`; `--service-tier fast`. Each was `claude.exe` plus `-p` except the file flags, which consumed `-p` as the path.

Claude `list_models`, twice, cwd `%TEMP%\bloblex-cap-claude-list`, flags `-p --output-format stream-json --input-format stream-json --verbose --permission-mode default --permission-prompt-tool stdio --no-session-persistence`, stdin only the control request, then the process was killed. No user prompt.

Codex and OpenCode catalogs:

- `codex debug models` → `%TEMP%\bloblex-cap-codex-models.json`
- `codex app-server generate-json-schema --out %TEMP%\bloblex-cap-codex-schema`
- `opencode models --verbose` → `%TEMP%\bloblex-cap-opencode-models.txt`
- `opencode debug config` with `OPENCODE_CONFIG_CONTENT` set only for that process, then cleared

ACP handshakes, no `session/prompt`, XDG dirs under `%TEMP%`:

- `%TEMP%\bloblex-cap-acp-wd` and `%TEMP%\bloblex-cap-xdg`: initialize, `initialized`, `session/new`, `session/set_model`
- `%TEMP%\bloblex-cap-acp-wd2` and `%TEMP%\bloblex-cap-xdg2`: `session/set_config_option` model, then `session/set_model` with `modelId` and with `model`
- `%TEMP%\bloblex-cap-acp-wd3` and `%TEMP%\bloblex-cap-xdg3`: `session/new` with `OPENCODE_CONFIG_CONTENT` defining agent `bloblex-cap`

Read-only package and schema inspection: Claude `package.json`, `sdk-tools.d.ts`, `cli-wrapper.cjs`, `README.md`; string scans of `claude.exe` and `opencode.exe`; `docs/qa-schema/codex-0.159.3/v2/ThreadStartParams.json`, `ThreadResumeParams.json`, `TurnStartParams.json`, `ThreadStartResponse.json`, `ThreadTokenUsageUpdatedNotification.json`, `ModelListParams.json`, `ModelListResponse.json`, `ConfigReadResponse.json`, `ThreadSettingsUpdatedNotification.json`; adapter sources listed above.

Live model calls: **none**.

Writes outside the temp dir, then what was done about them:

- The `list_models` probes created `%USERPROFILE%\.claude\sessions` and `.last-cleanup` even with `--no-session-persistence`. On this machine `USERPROFILE` is `C:\Users\jbmst\AppData\Local\bloblex-cursor-home`. Those new session files and `.last-cleanup` were deleted. The pre-existing `backups\.claude.json.backup.*` was left unread and in place.
- `opencode models --verbose`, `opencode debug paths`, and `opencode acp --help` ran before `XDG_*` was set. They left a default `opencode.jsonc` (schema stub only), `.gitignore`, `opencode.db` (+ `-shm`/`-wal`), and a `log` directory under that same home's `.config\opencode` and `.local\share\opencode`. Those files were not deleted. Later ACP handshakes used temp XDG dirs. `~/.codex` under that home was not created. No `login`, `logout`, or `config set` was run.
