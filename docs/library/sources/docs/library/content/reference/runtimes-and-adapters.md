# Runtimes and adapters

> **What this is:** how Bitbots finds Claude Code, Codex and OpenCode, how each adapter talks to its CLI, and which execution options each provider supports.
> **Status:** current; capability facts are from `docs/reference/runtime-capabilities.md` (CLI builds observed 2–13 October 2026) and the adapter sources. Models and authentication are host-dependent.
> **Last updated:** 2026-10-19

## Purpose

A **runtime** is one installed coding-agent CLI that Bitbots can drive. The runtime layer finds it, records its executable and version, and reports what it supports. An **adapter** owns the protocol. The daemon never reads a provider's terminal output to guess what happened; every adapter speaks a structured protocol or parses a documented stream.

This page explains the four adapters and the execution options they accept. Exact parameter shapes are in [IPC and events](ipc-and-events.md); the evidence for each capability is in `docs/reference/runtime-capabilities.md`.

## How discovery works

`bloblex-runtime` resolves native Windows executables and configured WSL hosts. Discovery runs at startup and on **Scan again**. Each runtime reports:

- provider and display name (`Claude Code`, `Codex`, `OpenCode`);
- absolute executable path, version and host;
- protocol family (`claude_stream`, `codex_app_server`, `acp`);
- aggregate auth state and per-gateway auth states where a CLI has more than one gateway;
- a status: online, error or unavailable.

`runtime.models` returns a catalog with a `source`:

| Source | Meaning |
| --- | --- |
| `live_query` | The provider itself answered. Authoritative for model ids. |
| `cli_list` | The CLI listed models in a documented command. A suggestion. |
| `config_options` | The protocol exposed the options for this session. A suggestion until a turn proves it. |
| `fallback` | Bitbots' fallback list. Never authoritative. |

The catalog is cached per runtime and profile for 60 seconds; `refresh:true` bypasses the cache. A fallback or unvalidated catalog is shown as a suggestion and does not validate execution. This is why typing an arbitrary model id is not equivalent to choosing one the runtime reported.

## Claude Code

- **Transport:** the CLI in print mode with `--output-format stream-json`. Turns go in on stdin; one JSON object per line comes back.
- **Process model:** one process per session. Claude's CLI session model does not support multiplexing several conversations through one child (`docs/reference/runtime-capabilities.md`, "Shared provider processes").
- **Permissions:** `--permission-mode default` plus host `control_request` / `control_response` messages over stream-json. `ask` and `auto` use that channel; `bypass` adds `--permission-mode bypassPermissions` and, when the installed CLI requires it, `--allow-dangerously-skip-permissions`. The flags are verified against the installed CLI's help before they are relied on.
- **Model and effort:** `--model` and `--effort` are accepted with `-p`. The five observed levels are `low`, `medium`, `high`, `xhigh` and `max`. An unknown level is ignored by the CLI with a warning, so Bitbots hides the picker when the catalog row has no levels and does not claim an effort was applied until a successful turn shows it.
- **Speed:** there is no speed or service-tier launch flag. Do not invent one; fast-mode fields in usage are reports, not a spawn option.
- **Usage:** stream-json `result` reports input, output and cache token fields. A result from an API error can contain zeroes and a null model; those are not a successful turn.

## Codex

- **Transport:** `codex app-server` over JSON-RPC on stdio. Bitbots never scrapes terminal text.
- **Process model:** one lazily started app-server per process key. The key hashes the runtime id, executable, launch arguments, project working directory, allowlisted environment overrides, provider config and a fingerprint of the daemon's inherited environment. Different working directories or environment values get separate children. The child closes 30 seconds after its last attached session; a shutdown closes every child immediately.
- **Threads:** model, effort, approval policy and developer instructions are sent on `thread/start`, `thread/resume` or per-turn `turn/start`. They are thread-scoped and do not split the process key. A change to instructions requires a new thread because instructions are part of the identity.
- **Approvals:** `approvalPolicy: "on-request"` with `sandbox: "workspace-write"` for ask and auto. Bypass uses `"never"` with `danger-full-access` and records `permission.bypass_active`.
- **Effort:** `turn/start` accepts an `effort` string; the picker is built from the selected model's `supportedReasoningEfforts`, including `ultra` only where that model advertises it. Fast is the `priority` service tier, shown as Fast.
- **Usage:** `thread/tokenUsage/updated` gives input, cached input, cache-write, output, reasoning and total tokens, without a model or cost. The model comes from the thread settings.
- **Steering:** Codex is the only provider whose adapter can accept guidance into a running turn today.

## OpenCode

- **Transport:** Agent Client Protocol over stdio. `bloblex-adapter-opencode` adds `acp` and `--cwd` to the resolved executable and uses the shared ACP adapter.
- **Process model:** shared per process key like Codex, with one important addition: the key includes the exact Bitbots-generated `OPENCODE_CONFIG_CONTENT`, because that JSON carries the session model and instructions.
- **Instructions:** ACP's `session/new` and `session/prompt` have no instruction field. Bitbots keeps a Bitbots-owned agent prompt and selects it as the session mode only when instructions are non-empty; with no instructions, the provider default mode stays active.
- **Model and effort:** select the model with `session/set_config_option` (`configId: "model"`) or `session/set_model` (`modelId`). After a variant-capable model is selected, ACP exposes an `effort` option (`configId: "effort"`, category `thought_level`). The values come from the model's `variants` plus the synthetic `default` when the option lists it. Hide the picker when the model has no variants.
- **Environment:** the read-only model listing runs `opencode models --verbose` with the inherited user environment but removes `OPENCODE_CONFIG_CONTENT`. A session inherits the user's home and XDG/OpenCode directory variables, removes any inherited config content, then sets the Bitbots JSON. Custom environment is limited to `LANG`, `LC_ALL`, `TZ`, `NO_COLOR` and `TERM`.
- **Usage:** `usage_update` is session-cumulative. A low-effort and a high-effort turn that both complete are not proof that effort changed provider behaviour; the capability record says exactly that.

## Shared execution options

Every session builds an `ExecOptions` from the bot, then overlays a per-conversation lock when one exists (`crates/bloblex-daemon/src/main.rs:1459-1479`):

- approval mode, model, thinking/effort and service tier;
- plan mode;
- instructions and their hash;
- custom arguments (the allowlist is empty for all three providers, so free-form arguments are refused);
- custom environment (five keys only);
- maximum concurrency for the provider child;
- Claude dynamic workflows, on unless explicitly disabled.

Non-null values are validated against the runtime's authoritative catalog before a turn. An unknown model or an unsupported combination is a turn-scoped `invalid_argument`; when discovery is unavailable or the catalog is a fallback, a non-empty custom id may be accepted without validation. A rejected preflight writes the user message, an error turn and an `exec.options.rejected` event, and does not reserve concurrency.

The applied settings and the provider's evidence are stored in an execution snapshot. Payloads never contain instruction text, environment values, arguments, file paths or raw provider JSON.

## Adding a provider

1. Add an adapter crate that speaks the provider's documented structured protocol. No terminal scraping.
2. Implement the shared adapter trait: start or resume, send a turn, cancel, answer permissions, close, and report capabilities and usage.
3. Translate its messages into Bitbots events. Do not pass provider JSON through.
4. Add discovery and a launch specification in `bloblex-runtime`.
5. Add the provider to the runtime capabilities record and to `runtime.models` with a real `source`.
6. Add the provider to the approval-mode mapping and the Remote policy, then update the parity test.
7. Add a fake-peer test for the protocol and a live, opt-in check that is clearly labelled as consuming provider quota.

## Gotchas

- **A model list is not a promise.** Only a `live_query` catalog validates an id.
- **Effort is per model.** Do not ship one global enum; build the picker from the model row.
- **Bypass widens the provider sandbox.** For Codex it must widen to `danger-full-access`; for Claude it adds two flags; for OpenCode the adapter answers every request with the allow option and audits it.
- **OpenCode's `usage_update` is cumulative.** Do not treat one turn's delta as the cost of that turn without subtracting the previous total.
- **An error result with zeroes is still an error.** Preserve unknown usage; never infer a successful, free turn.
- **The CLI version is host-dependent.** The recorded evidence names the builds it observed; a later CLI may change a flag. Re-check the installed help before relying on a new option.
