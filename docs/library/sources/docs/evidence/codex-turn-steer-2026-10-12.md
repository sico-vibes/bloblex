# Codex turn/steer evidence inventory (Phase 2B, 12 October 2026)

> **What this is:** Evidence inventory for Codex turn/steer (Phase 2B), 12 October 2026.
> **Status:** evidence; immutable record
> **Last updated:** 2026-10-15

Read-only inventory for the Phase 2B `session.steer` backend. Steering is off by
default and reported as unproven (`evidence: "none"`) until a real Codex turn
accepts it live.

## Schema source

Generated read-only with the installed CLI (nothing generated is committed):

```
codex app-server generate-json-schema --out <OS temp dir>   # codex-cli 0.162.1
```

Schema paths below are relative to that output directory.

| field / method | schema path | notes |
|---|---|---|
| method `turn/steer` | `ClientRequest.json`, `codex_app_server_protocol.v2.schemas.json` | listed alongside `turn/start` and `turn/interrupt` as a client request |
| `TurnSteerParams` | `v2/TurnSteerParams.json` | `required: ["expectedTurnId","input","threadId"]`; optional `clientUserMessageId` |
| `threadId` | `v2/TurnSteerParams.json` → `properties.threadId` | provider thread id |
| `expectedTurnId` | `v2/TurnSteerParams.json` → `properties.expectedTurnId` | described as "Required active turn id precondition. The request fails when it does not match the currently active turn." |
| `input` | `v2/TurnSteerParams.json` → `properties.input` | array of `UserInput`; text variant `{"type":"text","text":...}` |
| `TurnSteerResponse` | `v2/TurnSteerResponse.json` | `required: ["turnId"]` |
| JSON-RPC error shape | `JSONRPCErrorError.json` | `required: ["code","message"]` |

## Implementation

- `crates/bloblex-agent-core/src/lib.rs`: `SteerRequest { turn_id, text }`,
  `SteerOutcome { Accepted, Stale }`, and a defaulted
  `AgentAdapter::steer` that returns
  `AdapterError::Unsupported("steering is unavailable for this runtime")`.
- `crates/bloblex-adapter-codex/src/lib.rs`: `CodexAdapter::steer` builds
  `{"threadId": <provider thread>, "expectedTurnId": <provider active turn id>,
  "input":[{"type":"text","text":<text>}]}` and calls `turn/steer`. The
  daemon's `SteerRequest.turn_id` is *not* sent; the adapter uses the provider
  turn id it tracks from `turn/start` (`Conn::turn.id`), which the fake names
  `turn-1`. `TurnSteerResponse` is not parsed beyond success.
- `crates/bloblex-adapter-codex/src/lib.rs`: `steer_stale_evidence` lowercases
  the JSON-RPC error text and treats "not active" / "expected turn" /
  "does not match" style messages as `SteerOutcome::Stale`; every other
  `AdapterError::Rejected`/`Process`/`Timeout` stays an error.
- `crates/bloblex-daemon/src/main.rs`: `session.steer` validates, checks the
  `exec_gate.codex.steer` gate (default false) and the capability table, then
  requires an active turn. On `Accepted` it appends the text as a user message
  with `meta.kind == "steer"` and emits `message.completed`; on `Stale` it calls
  `queue::enqueue_steer` (position 0). The runtime capability table reports
  `steer` with `scope: "turn"` and `evidence: "none"` for every provider.

## What the fixture proves (request shape only)

`crates/bloblex-adapter-codex/src/bin/fake_codex_server.rs` handles
`turn/steer` with modes `steer-accept` (default when the expected turn is
active), `steer-stale`, and `steer-reject`. The adapter test
`steer_accepts_with_the_schema_exact_request_and_reports_stale_and_reject`
asserts the recorded request method and params shape (`threadId`,
`expectedTurnId == "turn-1"`, `input[0].type == "text"`) and the three outcomes.
The daemon tests
`steer_requires_the_gate_codex_and_an_active_turn`,
`stale_steer_falls_back_to_the_queue_at_position_zero`,
`steer_is_unsupported_for_other_runtimes_and_side_conversations`, and
`runtime_capabilities_report_steer_none_and_follow_the_gate` cover the RPC
contract. This proves only that Bitbots sends a schema-shaped request to a fake
peer and routes the fake's accept/stale/reject replies.

## Not verified live

- **Acceptance by a real Codex turn.** No real `turn/steer` has been sent to
  `codex-cli 0.162.1`. The generated schema documents the request; the response
  and the real acceptance semantics are unverified.
- **Behaviour when the turn is in a tool call.** Whether Codex accepts a steer
  while executing a tool, and how it orders the injected text against pending
  tool output, is unknown. The fixture accepts unconditionally.
- **Ordering relative to streamed output.** Where the steered text appears
  relative to already-streamed `item/agentMessage/delta` events, and whether a
  steer produces its own streamed acknowledgement, is unknown.
- **Real stale wording.** `steer_stale_evidence` matches on the provider's
  error *text*, which is not in the generated schema. The real mismatch message
  is unverified; the fake emits `expected turn is not active`. A wrong match
  would misclassify a hard error as `Stale` (queued rather than surfaced).
