# FIX5: OpenCode 2 per-model effort levels and a validated catalog

Written 14 October 2026. Backend only (`crates/bloblex-adapter-acp`, and
`crates/bloblex-daemon` only if a compile or contract fix strictly needs it).
Follows FIX3 (`acp --cwd` removal, beta.24).

## 1. Symptoms (owner, on beta.24 with OpenCode 2.0.28)

- Settings shows "Suggested models, not checked with OpenCode." under the model
  picker even after choosing a model.
- A DeepSeek V4.1 Flash conversation's effort control says "Model default. This
  model does not report selectable effort levels." Orca offers effort for the same
  model.

## 2. Cause

After FIX3 the catalog comes from `fetch_config_options` (ACP `session/new`).
That response carries ONE `effort` option, for the session's *current* model
only (`opencode-go/gemini-4-argon-contributor` on the owner's machine). FIX3
therefore attached levels to that model alone and left every other model with
none, and kept `validated:false` because levels for the other models were not
known. OpenCode 2 no longer offers `models --verbose` (which carried per-model
`variants` on 1.x).

## 3. What OpenCode 2.0.28 does (observed live, 14 Oct 2026)

In a single ACP session, `session/set_config_option` with
`{sessionId, configId:"model", value:"<provider/model>"}` returns the full
`configOptions` again with the `effort` option **rebuilt for the newly selected
model**:

- before: model `opencode-go/gemini-4-argon-contributor`, effort `low,medium,high,default`
- after selecting `opencode-go/deepseek-v4.1-flash`: effort `low,high,max,default`

Walking all 115 models in one session took 1.1 s (about 10 ms each; it is a local
config change, no model call). Sample of what came back, by level set:
`none,low,medium,high,xhigh,max,default` (13 models), `high,max,default` (7),
`low,high,max,default` (8, includes `deepseek-v4.1-flash`), `max,default` (2),
`none` meaning no `effort` option at all (24, e.g. `opencode/big-pickle`),
and sets containing `minimal`, `none` and `thinking`.
The model list (115) equals `opencode models` (115).
`default` is OpenCode's synthetic "use the model's own default", not a level.

## 4. Required behavior

1. In `catalog.rs::fetch_config_options`, after `session/new` succeeds, walk the
   `model` option's values **sequentially in the same session**:
   `session/set_config_option {sessionId, configId:"model", value}`; read the
   `effort` option (category `thought_level`, fall back to id `effort`) from the
   returned `configOptions`; the model's `supported_thinking` is its options minus
   `default`, ordered with `catalog::effort_rank` (keep unknown names, e.g.
   `thinking`, after known ones, stable). A model with no `effort` option gets an
   empty list (it genuinely has none). `default_thinking` stays `None` unless the
   provider's `currentValue` is a concrete level.
2. The walk must be bounded: a per-call timeout (about 2 s) and an overall budget
   inside the existing catalog timeout. One failing model must not fail the
   catalog; that model keeps an empty list.
3. `validated`: set `true` only when the walk completed for **every** model
   without a failure or budget cut. The justification, to be put in a code
   comment: the list is the provider's own complete model list for the account and
   each level set is the provider's own answer for that model, so this is the
   authoritative source `validated` means. If any model was skipped, keep
   `validated:false` and return what was learned.
4. The probe session is throwaway: never send a prompt, never change anything but
   the in-session model option, and always terminate the child (reuse the existing
   `process_tree`/kill path). Restoring the original model is not required.
5. Keep `source:"config_options"`; keep the 60 s `expires_at`.
6. Selecting an effort for a real conversation must still work for the chosen
   model. Read the session code in `exec.rs` and confirm the order is model first,
   then effort (effort options depend on the model). If it sets effort before the
   model, fix the order and say so.
7. Do not touch `crates/bloblex-runtime`, `apps/`, or any UI file.

## 5. Tests (fake CLI only; never the real opencode beyond `--version`/`--help`)

- Extend the fake ACP peer's `--v2` mode so `session/set_config_option` for
  `model` rebuilds `effort` per model from a table, with at least: a model with
  `low,medium,high,default`, one with `low,high,max,default`, one with no effort
  option, and one that returns an error.
- Catalog: every model gets its own levels; the no-option model gets none;
  `default` is never a level; order is low→high; the erroring model has none and
  `validated` is `false`.
- Catalog with all models answering: `validated` is `true`.
- Budget: a peer that stops answering after N models returns within the budget,
  keeps what it learned, `validated:false`, and leaves no child running.
- The existing v1 verbose catalog path is unchanged (`cli_list`, `validated:true`).
- Keep FIX3's tests green (no `--cwd`, help-on-`--cwd` fake).
- A test that selecting model then effort sends `set_config_option` in that order.

## 6. Gates

```
cargo test -p bloblex-adapter-acp
cargo test -p bloblex-daemon          # RUST_MIN_STACK=33554432 on this machine
cargo clippy -p bloblex-adapter-acp --all-targets   # report the delta only; HEAD is not clean
```

`cargo fmt --check` fails on HEAD; report only.

## 7. Report

Files changed, test results as exact lines, what you chose for the budget and why,
and anything you were unsure about. The Director runs the live check against the
installed OpenCode afterwards.
