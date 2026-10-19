# FIX3: OpenCode 2 does not accept `acp --cwd`

> **What this is:** Spec for FIX3: OpenCode 2 does not accept the ACP `--cwd` launch argument.
> **Status:** historical
> **Last updated:** 2026-10-15

Written 14 October 2026. Backend only (`crates/bloblex-adapter-acp`).

## 1. Symptom

On a machine with OpenCode 2.0.28, Bitbots finds the CLI and (since beta.23)
reads its version and sign-in, but the blob settings screen shows "The provider
could not be reached." and "Model unavailable". The model catalog fails, and
real OpenCode sessions very likely fail to start for the same reason.

## 2. Root cause (reproduced against the installed CLI)

Bitbots starts ACP as `opencode acp --cwd <dir>` in two places:

- `crates/bloblex-adapter-acp/src/lib.rs` ~line 300 (`spawn_process`, real sessions)
- `crates/bloblex-adapter-acp/src/catalog.rs` ~line 103 (`fetch_config_options`)

OpenCode 2 (`opencode v2.0.28`) has no `--cwd`. `opencode acp --help` lists only
`--login`. With the extra flag the CLI prints its help text on stdout and never
answers JSON-RPC, so the handshake times out. The first catalog path,
`opencode models --verbose`, is also gone in v2 (exit 1 "Unrecognized flag"), so
both catalog paths fail and the daemon reports provider-unavailable.

Without `--cwd`, and with the working directory set on the process, the handshake
works. Observed live (a throwaway Node script, no model call):

- `initialize` → keys `protocolVersion, agentCapabilities, authMethods, agentInfo`.
- `session/new {cwd, mcpServers: []}` → `{ sessionId, configOptions }`.
- `configOptions` has three `select` options:
  - `id:"model", category:"model"`, 115 options such as
    `{"value":"opencode/big-pickle","name":"opencode/Big Pickle"}`, `currentValue`
    like `opencode-go/gemini-4-argon-contributor`.
  - `id:"effort", category:"thought_level"`, options `low, medium, high, default`
    (these are the **current model's** levels), `currentValue:"default"`.
  - `id:"mode", category:"mode"`, options `build, plan`.

OpenCode 1.x accepts the working directory from the process cwd and from the
`cwd` field of `session/new`, so the flag is redundant for both.

## 3. Required changes

1. Remove `.arg("--cwd").arg(cwd)` from both spawn sites. Keep
   `.current_dir(cwd)` and the `cwd` inside `session/new`. Do not add a version
   check; the flag is not needed on either major version.
2. Keep `fetch_verbose_catalog` first (v1 still prints gateway JSON there). On v2
   it exits non-zero and falls through to `fetch_config_options`, which now
   works. Make sure a failed `models --verbose` cannot leave a child process
   running or consume the whole timeout (it must fall through quickly).
3. Check how the daemon and UI use `ModelCatalog.validated`
   (`crates/bloblex-daemon/src/main.rs`, `apps/desktop/src/executionContract.ts`
   are read-only references for you; do not edit `apps/`). The config-option
   catalog is currently `validated:false`. Decide, and justify in your report,
   whether a catalog read from the provider's own `session/new` should stay
   `validated:false`. Do not change it unless the existing code's own definition
   of "validated" clearly allows it; if unsure, leave it and report.
4. Effort levels from `configOptions` (`category:"thought_level"`) must reach the
   model entries so the effort picker has levels for the **current** model. Look
   at how `exec::config_option_catalog` / `options_from_result` handle a
   `thought_level` option today and add it only if it is missing. Do not
   invent levels for the other models.
5. Do not change `crates/bloblex-runtime` (discovery and sign-in were fixed in
   beta.23).

## 4. Tests (fake CLIs only; no installed OpenCode, no network)

- A fake `opencode` that exits with help text and no JSON-RPC when it sees
  `--cwd`, and otherwise speaks the v2 shape from section 2. Prove the real
  session spawn and the catalog both succeed, and that the argv contains no
  `--cwd`.
- Catalog from the v2 fixture: `source:"config_options"`, the 115-style model
  list, the current model flagged, and the three effort levels plus `default`
  mapped for that model only.
- A v1-shaped fake (verbose JSON works) still yields `source:"cli_list"` and
  `validated:true`.
- `models --verbose` failing fast does not delay the fallback beyond a small
  bound and leaves no process running.
- Update any existing test that asserted `--cwd` in argv.

## 5. Gates

```
cargo test -p bloblex-adapter-acp
cargo test -p bloblex-adapter-opencode
cargo test -p bloblex-daemon          # RUST_MIN_STACK=33554432 on this machine
cargo clippy -p bloblex-adapter-acp -p bloblex-adapter-opencode --all-targets -- -D warnings
```

`cargo fmt --check` already fails on HEAD; report only.

## 6. Out of scope

Live verification against the installed OpenCode is run by the Director after
review. Do not run the real `opencode` binary for anything except
`opencode --version` and `--help`. Never run `auth login/logout/export`.
