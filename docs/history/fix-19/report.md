# FIX19 report: `docs/remote/PROTOCOL.md`

> **What this is:** Report on FIX19: the remote protocol document.
> **Status:** historical
> **Last updated:** 2026-10-15

Lane: OpenCode `opencode-go/deepseek-v4.1-flash` (high effort, docs-only lane). Worktree: this
checkout only. Not committed (the Director commits after review).

Gates: **none** (FIX19 is docs-only; no typecheck, test, build or clippy gate applies). No code
or configuration file was changed. The only file added is `docs/remote/PROTOCOL.md`. The
`<!-- TIER-TABLE -->` line is left in place for the Director to fill from FIX18's
`renderTierTableMarkdown()`.

Sources read before writing: `DESIGN.md`, `docs/ipc-contract.md`,
`crates/bloblex-daemon/src/main.rs` (`/v1/rpc` and `/v1/events`, `events.replay`,
`ws_client` handshake and `afterSequence`, `replay.gap`, `events.replay.complete`,
`broadcast::channel(1024)`, `main_rpc` auth and error mapping, attachment limits and
magic bytes), `crates/bloblex-storage/src/lib.rs` (`app_events` sequence, `push_event`,
`replay_events`), `apps/desktop/src/remote/remoteContract.ts`, and `docs/history/fix-18/remote-tiers-spec.md`.

## Unsure about (five lines)

1. The Noise choice is a recommendation, not a measured fit: I could not test that `XX` for
   pairing and `IK` for known devices is what the eventual implementation uses, nor the 1 GiB /
   1 hour rekey figures.
2. The pairing prologue composition (`H(code ‖ hostId ‖ deviceId ‖ relay)`) is my design; the
   spec only required the code to be bound into the prologue, not its exact inputs.
3. The relay header fields and the 256 KiB frame cap are specified by the task, but I do not
   know whether they match the relay that will be built; the gateway-added error codes likewise
   have no daemon emitter to cite.
4. Attachment chunking and the staging lifetime are unspecified beyond "10 MiB, magic-byte
   check, returned `stagedId`"; I invented the chunk/offset shape and left staging lifetime as
   an open question.
5. `docs/remote/ARCHITECTURE.md` is referenced by `remoteContract.ts` but does not exist in this
   worktree, and FIX18's `remoteTiers.ts` is not present either, so the tier table and some
   cross-references are placeholders aimed at files other lanes will produce.
