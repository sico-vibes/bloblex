# FIX18 report: remote method tiers

> **What this is:** Report on FIX18: remote method tiers.
> **Status:** historical
> **Last updated:** 2026-10-15

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`. Worktree: `C:\fx33c` (branch unchanged). Nothing was
committed. Rust, components, CSS, `src/transport/*`, `src/preview/*` and `remoteContract.ts` were
not touched.

## Files

- `apps/desktop/src/remote/remoteTiers.ts` — the policy: `METHOD_RULES`, `ruleFor`,
  `authorizeRemoteCall`, `redactSnapshotForRemote`, `renderTierTableMarkdown` and the two
  `ParamRule`s.
- `apps/desktop/src/remote/remoteTiers.test.ts` — 13 unit tests (classes, authorization, params,
  redaction, table).
- `apps/desktop/src/remote/remoteTiers.parity.test.ts` — 4 parity tests against the daemon dispatch.
- `scripts/print-remote-tiers.mjs` — prints the docs table.
- `docs/history/fix-18/report.md` — this file.

## Counts

Dispatch arms in `crates/bloblex-daemon/src/main.rs` (`async fn dispatch`, 86 method strings):

| Class | Dispatched methods | Rules |
| --- | --- | --- |
| read | 28 | 25 (23 exact + 2 family) |
| chat | 16 | 10 (9 exact + 1 family) |
| approve | 1 | 1 |
| never | 41 | 37 (32 exact + 5 family) |
| **total** | **86** | **73** |

`mcp.*` has no dispatch arm: the daemon answers it earlier, in the `/v1/rpc` handler
(`crates/bloblex-daemon/src/main.rs:324`, `if req.method.starts_with("mcp.")`), so its family rule is
matched through that prefix guard rather than a match arm.

Family rules used where the spec enumerated a family: `exec.snapshot.*` (3 methods), `usage.*` (2),
`session.queue.*` (7), `session.delete.*` (2), `pricing.*` (2), `subscription.*` (2), `budget.*` (3),
`mcp.*` (prefix guard). Everything else is an exact rule.

## Parity test

It reads `main.rs`, locates `async fn dispatch`, and takes the body by scanning braces while skipping
string literals and comments (fails loudly if the function or its closing brace cannot be found).
Inside the body it matches arm patterns at eight spaces of indentation and collects every quoted
method from `a | b | c =>` alternations. Method prefix guards are collected across the whole file,
but only from RPC-method receivers (`m`, `method`, `req.method`), so `k.starts_with("exec_gate.")`
(a setting key) and the provider/model `starts_with` calls are not mistaken for methods. It then
asserts: every dispatched method has an exact rule or a family prefix; every prefix guard has a
family rule; and no rule is stale. It also asserts the extraction found >30 arms, >70 methods, and
the `mcp.` guard, so a parse failure fails the test instead of passing it.

I checked the test is not vacuous with scratch runs against a mutated source: dropping the
`session.prompt` rule reports `session.prompt` as uncovered; adding a bogus rule reports it as stale;
a family rule with no match reports itself as stale.

## Docs hand-off

`renderTierTableMarkdown()` returns the four-column table (Method, Class, Minimum tier, Why). The
script prints it from the repository root:

```
npx vite-node scripts/print-remote-tiers.mjs
```

`vite-node` (3.2.4, already installed through vitest) resolves the TypeScript module and its
`./remoteContract` import, so nothing is duplicated. The script is `.mjs` as the spec asked; it
imports the `.ts` module with an explicit extension. Output starts `| Method | Class | Minimum tier | Why |`
and has 73 rows. FIX19 can fill `<!-- TIER-TABLE -->` from this.

## Judgement calls, and what I was unsure about

- **`quota.refresh`** is dispatched but the spec classifies only `quota.list`. I put it in **never**
  (least privilege: a device only needs to read `quota.list`; triggering a host provider poll is an
  action). It is the one method whose class the spec did not state; if the Director prefers, moving
  it to `chat` is a one-line change and the parity test still passes.
- **Family vs exact rules.** The spec writes some families with `*` (`exec.snapshot.*`, `usage.*`,
  `session.queue.*`, `session.delete*`, `pricing.*`, `subscription.*`, `budget.*`). I encoded exactly
  those as family rules; every other dispatched name is an exact rule. `session.delete` is kept as
  its own exact rule so the `session.delete.*` family does not swallow it.
- **`customEnv` redaction.** "Removes `customEnv` values" is ambiguous. I keep the key and remove the
  values (`customEnv: {}`), consistent with `instructions` becoming `{ hasInstructions: true }`,
  which keeps a truthful marker rather than deleting the key. Deleting the key entirely is the other
  defensible reading.
- **Path reduction.** Per the spec ("absolute filesystem paths"), only absolute paths are reduced;
  relative `projectPath` values pass through. The last two segments are joined with `/`, and a drive
  prefix counts as a segment (`C:\Users\sam\repos\bloblex` → `repos/bloblex`; `C:\repo` → `C:/repo`).
- **Instruction guard.** `instructions` is replaced only when it is a non-empty string; empty string
  and non-string values are passed through unchanged, as written.

## Gates

- `npm run typecheck` — pass (`tsc -b`, no output).
- `npm run test` — pass, 110 files / 706 tests (17 new).

Not run: `git commit` (forbidden for this lane).
