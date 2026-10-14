# FIX6: OpenCode turns fail when the blob's instructions change

Written 14 October 2026. Backend only (`crates/bloblex-adapter-acp`; the daemon
only if a contract or compile fix strictly needs it).

## 1. Symptom (owner, beta.25, OpenCode 2.0.28)

A message to an OpenCode DeepSeek blob ends with "Turn failed: provider protocol
error: instructions are fixed for the running OpenCode process".

## 2. Cause

OpenCode takes a blob's instructions only through `OPENCODE_CONFIG_CONTENT`, an
environment variable read **when the `opencode acp` process starts**
(`exec::config_content`, `exec::apply_child_env`). The adapter remembers the text
it started with (`Conn::spawned_instructions`) and, on every turn,
`apply_options` (`lib.rs` ~line 735) compares the turn's instructions with it:

```
if c.spawned_instructions != Some(instructions) {
    fail_setting("instructions", ERR_INSTRUCTIONS_FIXED);
    return Err(Protocol(ERR_INSTRUCTIONS_FIXED))
}
```

The instructions are not only the blob's own text: `team::attach`
(`crates/bloblex-daemon/src/team.rs`) prepends a `<bloblex_team>` block built from
current state: the blob's role and description, the user's name, its project, and
**whether it is the team leader and who the leader is**. Any change to those
between the session's start and a later turn (making a blob the leader, which also
demotes the previous leader; editing a role; attaching a project) makes the next
turn fail, and every turn after it, until a brand-new conversation is created.
The same applies to `env` (`ERR_ENV`).

Process key: `spawn` hashes runtime, executable, args, cwd, env, the config
content (model + instructions) and the inherited environment into
`process_key`; processes are shared per key. A changed instruction text therefore
means a different key, i.e. a different process.

## 3. Required behavior

When a turn arrives whose normalized instructions differ from
`c.spawned_instructions` (or whose `env` differs from `c.spawned_env`), the
adapter must **re-establish the session on a process started with the new
configuration and carry on**, instead of failing. The conversation must continue
with its history.

1. Add a `reconnect` path next to `resume_after_crash` (`lib.rs` ~line 509),
   reusing its structure: compute the new `process_key` with the same key
   construction as `spawn` but from the turn's `exec_options` (extract that key
   construction into one helper used by both), `acquire_process` with the new
   options, `initialize`, then `session/load {sessionId: <existing provider id>,
   cwd, mcpServers}`; fall back to `session/new` only for the cases
   `resume_after_crash` already falls back (`ResumeRejected`, no `loadSession`),
   and in that case report that context was reset the same way
   `resume_after_crash` does.
2. New `Conn` carries the new `spawned_instructions`, `spawned_env` and
   `base_options`. Replace the entry in `self.sessions`, and detach the old `Conn`
   (`detach_route` with shutdown-when-empty) so the old process is reaped after
   its last session leaves it; never kill a process that another session still
   uses (it is shared).
3. Do it in `prompt()` before `apply_options`, under the same lifecycle guarantees
   as the crash path: no turn is in flight on this session (the daemon serializes
   prompts per session; assert and return a clear error if a turn is active).
4. A stable text must not respawn: when the requested instructions equal
   `spawned_instructions`, nothing changes (no new process, no extra
   `session/load`). Add a test.
5. Model and effort changes already go through `session/set_config_option` and
   must not trigger a respawn. Do not change that.
6. If the reconnect itself fails, return the provider error (not
   `ERR_INSTRUCTIONS_FIXED`) and leave the old connection untouched and usable.
7. Keep `ERR_INSTRUCTIONS_FIXED` only for the case reconnect is impossible; do not
   leave it reachable on the normal path. Never put instruction text, env values
   or raw provider JSON in events, outcomes or logs (hashes only), as today.
8. Report the instruction outcome honestly: after a successful reconnect the
   `instructions` setting is `applied:true` with the evidence kind the adapter
   already uses for OpenCode instruction application (read how the first turn
   proves it today and reuse it); do not invent a new evidence kind.

## 4. Tests (fake CLI only; never the real opencode beyond `--version`/`--help`)

- Instructions change between two turns of one session: the second turn succeeds,
  the new process saw the new text (the fake peer records a hash of the
  configuration it was started with), the provider session id is the same, and the
  fake received `session/load` with it.
- The old process is gone once no session uses it; a second session that shares the
  old process keeps working (shared-process case).
- Unchanged instructions across turns: no respawn, no `session/load`.
- `env` change behaves like instructions.
- `session/load` rejected on the new process: falls back to `session/new` and the
  turn still runs, with the context-reset signal the crash path emits.
- Reconnect failure leaves the old connection usable and returns the provider
  error.
- FIX3 and FIX5 tests stay green.

## 5. Gates

```
cargo test -p bloblex-adapter-acp
cargo test -p bloblex-daemon          # RUST_MIN_STACK=33554432 on this machine
cargo clippy -p bloblex-adapter-acp -p bloblex-daemon --no-deps --all-targets -- -D warnings
```

The tree is clippy-clean for `-D warnings`; keep it that way (no new findings).
`cargo fmt --check` fails on HEAD; report only.

## 6. Report

Files changed, exact test lines, how you made the process-key helper shared, and
what you were unsure about. The Director then verifies against the real OpenCode.
