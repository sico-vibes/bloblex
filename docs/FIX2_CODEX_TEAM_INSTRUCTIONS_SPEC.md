# FIX2: Codex threads keep stale team instructions

Written 14 October 2026. Backend only (Rust). The UI note in section 8 belongs to the Director.

## 1. Symptom

A blob that is the team leader, talking to the user through Codex, answered
"I can't create another bot… the team leader needs to add it" and "I can't see
who's designated team leader". The sidebar showed its leader badge. The same blob
in a **new** conversation would have been told it is the leader and offered
`create_blob`.

## 2. Root cause

`team::attach` (`crates/bloblex-daemon/src/team.rs`) builds a `<bloblex_team>`
block from the *current* database state: the blob's role and description, the
user's name, the project, **whether this blob is the leader**, and who the leader
is. It is prepended to the blob's own instructions in `ExecOptions.instructions`
on every `session.new`, `session.resume` and `session.prompt`.

The Codex adapter (`crates/bloblex-adapter-codex/src/lib.rs`) installs
instructions **only** as `developerInstructions` on `thread/start`
(`start_params`, ~line 677). Afterwards:

- `resume_params` (~line 681) never sends them.
- `prompt()` (~line 1456) compares the requested hash to `meta.baseline_hash`;
  when it differs it only reports `instructions: applied:false,
  reason:"instructions_change_requires_new_thread"` and sends nothing.
- The daemon stores `sessions.codex_thread_instruction_sha256` once, with
  `COALESCE(...)`, so it never advances (`crates/bloblex-storage/src/lib.rs`
  ~line 1653).

So any change after a thread started (leader flag toggled, role edited, project
attached, user renamed, leader replaced) is silently ignored for that thread's
whole life, including across app restarts. The daemon's tool gate is live
(`is_leader` is read from the database per call, `team.rs` ~line 208), so the
tool would work; the model is simply still told it cannot use it.

`docs/PHASE_2B_SPEC.md` (lines 76, 146, 192, 201, 205) records this as designed
("applies to new conversations"). That design is right for a user's own
`agent.instructions` edit, but wrong for the **team context**, which is
operational state the model must be able to rely on.

## 3. Goal

After the team context (or any instruction text) changes, the **next turn** on an
existing Codex thread runs under the new text, and Bloblex says so only when it
has evidence. A new thread behaves exactly as today.

Non-goals: Claude and OpenCode (their paths are separate; do not touch them),
the UI, `docs/PHASE_2B_SPEC.md` wording beyond a short addendum pointer, and any
live Codex run.

## 4. What the installed Codex (codex-cli 0.162.1) offers

Read from `codex app-server generate-json-schema [--experimental]`; re-generate
into a scratch directory outside the repo to confirm before relying on it.

- `thread/resume` params include `developerInstructions` and `baseInstructions`
  (stable schema). Whether a resumed *running or persisted* thread honors them is
  **unverified**.
- `turn/start` params include `collaborationMode` (EXPERIMENTAL): "Takes
  precedence over model, reasoning_effort, and developer instructions if set";
  `settings.developer_instructions: null` means the mode's built-in text.
  `CollaborationMode = { mode, settings: { model, reasoning_effort?,
  developer_instructions? } }`. The adapter **already** sends this on plan-mode
  turns and uses it to restore the blob's text when leaving plan mode (~line
  1495), which is evidence it is applied to the thread and persists beyond a
  single turn.
- `thread/settings/updated` notifications carry `threadSettings` including
  `collaborationMode`, which can echo the instructions actually in force.
- `turn/start` also has an experimental `additionalContext` map. Do **not** use
  it: it is per-turn context, not instructions, and its persistence is unknown.

## 5. Required behavior

Use the existing per-turn `collaborationMode` path; add no new experimental
surface.

1. **Detect.** In `prompt()`, when the requested instruction hash differs from the
   hash currently installed on this thread (`baseline_hash`), the change is
   pending. (Keep `desired_hash` as today.)
2. **Apply.** If the turn is not a plan-mode turn and a model is known (the same
   `model` resolution plan mode uses), send `collaborationMode = {mode:"default",
   settings:{model, reasoning_effort: thinking, developer_instructions: <full
   current text>}}` on that `turn/start`. The text is the same string that would
   have been sent to `thread/start` (team context + the blob's own instructions).
   If a model is not known, do not guess: keep today's `applied:false` outcome
   with the existing reason.
3. **Plan mode.** Unchanged: plan turns send `developer_instructions: null`.
   Remember the pending text; the first non-plan turn after plan mode sends it
   (the existing restore code already does this; make it use the current text,
   not whatever was last sent).
4. **Resume.** In `resume_params`, send `developerInstructions` = the current text
   when it differs from the stored thread hash. It is accepted by the schema.
   Do not report it as applied (section 6).
5. **Advance the baseline only on success.** After `turn/start` is accepted and the
   turn completes without a rejection of the settings, treat the new text as
   installed: set `meta.baseline_hash` to the new hash and update the in-memory
   `thread_instruction_hashes` map. If `turn/start` is rejected before the
   prompt is delivered, leave the baseline unchanged so the next turn retries.
6. **Storage.** `sessions.codex_thread_instruction_sha256` must advance when an
   instruction change is applied with evidence (section 6). Keep the `COALESCE`
   behavior for the first write on a new thread; add a separate, explicit update
   path used only by the applied-with-evidence case. Do not break migration
   idempotency or the existing "must not overwrite on resume" tests.

## 6. Honesty rules (these are the project's, not optional)

- `applied: Some(true)` for `instructions` requires evidence. Accept exactly one of:
  (a) a `thread/settings/updated` notification for this thread whose
  `collaborationMode.settings.developer_instructions` hashes (SHA-256, same
  function as `instruction_sha256`) to the desired hash, or (b) the existing
  successful-turn sentinel path if one exists for instructions. A `200`/accepted
  `turn/start` alone is **not** evidence.
- Without evidence report `applied: None` with reason
  `instructions_sent_unverified` (new, fixed string) rather than `Some(true)`.
  Never claim `Some(true)` from the request shape alone.
- Never put instruction text, env values or raw provider JSON in events,
  snapshots or logs; hashes only.
- Existing reason `instructions_change_requires_new_thread` stays for the case
  where the change cannot be sent (no known model, or the provider rejects the
  settings).
- If the provider rejects `collaborationMode` for a default-mode turn, do not
  retry without it silently: report `applied:false` with the existing reason and
  deliver the user's prompt normally (other options remain usable).

## 7. Tests (fake peers only; no installed CLI, no network)

In `crates/bloblex-adapter-codex/tests/app_server.rs` and unit tests:

- Changed hash on an existing thread: `turn/start` carries `collaborationMode`
  with the new `developer_instructions`, `mode:"default"`, the known model.
- Unchanged hash: no `collaborationMode` is sent (no churn on normal turns).
- After an applied change the **next** turn sends no `collaborationMode` again.
- Echo present (`thread/settings/updated` with the matching text): outcome
  `applied:true`, stored thread hash advances. Echo absent: `applied:null`,
  reason `instructions_sent_unverified`, stored hash does **not** advance.
  Echo with a different text: `applied:false`.
- Plan turn sends `developer_instructions:null`; the next default turn sends the
  *current* text.
- No model known: today's `applied:false` outcome, nothing sent.
- `turn/start` rejected: baseline unchanged, retried next turn.
- Resume with a differing hash sends `developerInstructions`; resume with an
  equal hash sends none.
- Storage: first write sets the hash; an applied-with-evidence update changes it;
  resume alone never does; migration idempotency tests unchanged.
- No test asserts on instruction text in events/snapshots.
- Existing test at `tests/app_server.rs:288` (changed hash → applied:false) is
  updated to the new rules, not deleted.

## 8. Not in this change (Director)

When an instruction change could not be applied (`applied:false`), the UI should
tell the user "applies to new conversations" next to the leader toggle and role
fields. The event (`exec.options.changed`) already carries the outcome; only the
copy is missing. This is UI/UX and is done separately.

## 9. Gates

```
cargo test -p bloblex-adapter-codex
cargo test -p bloblex-storage
cargo test -p bloblex-daemon           # set RUST_MIN_STACK=33554432 on this machine
cargo clippy -p bloblex-adapter-codex -p bloblex-storage -p bloblex-daemon --all-targets -- -D warnings
```

`cargo fmt --check` fails on the repository at HEAD; report only, do not reformat.

## 10. Verification that is NOT part of this change

Whether the installed Codex honors `collaborationMode.developer_instructions` and
`thread/resume.developerInstructions` for a *running or persisted* thread is only
proven by a live turn. That probe is run separately by the Director with the
owner's approval (it spends a turn of the owner's plan). Until then the release
note must say "sent, not verified" for Codex instruction updates.
