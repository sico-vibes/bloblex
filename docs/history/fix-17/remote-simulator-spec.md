# FIX17: the Remote mode simulator for the web preview

> **What this is:** Spec for FIX17: the Remote mode simulator for the web preview.
> **Status:** historical
> **Last updated:** 2026-10-15

Written 15 October 2026. Remote mode is being designed in `docs/remote/`. The browser
preview needs a believable, deterministic simulation of the host side and of the paired
computers a phone sees. No network, no daemon changes.

Read `apps/desktop/src/remote/remoteContract.ts` first: the types, method names and event
names are fixed by it. Do not edit that file; if something is missing, list it in the report.
Do not touch any `.css`, any component, `src/transport/*` (other lane) or the Rust crates.

## 1. `apps/desktop/src/preview/remoteFixture.ts`

A small in-memory state machine, pure TypeScript, no timers started at import time:

```ts
export interface RemoteSimulator {
  call(method: RemoteMethod, params: Record<string, unknown>): Promise<unknown>
  subscribe(listener: (event: { type: RemoteEventType; payload: unknown }) => void): () => void
  reset(seed?: RemoteSeed): void
  /** Preview-only: act as the phone finishing pairing with the current offer. */
  simulatePairingCompleted(device?: Partial<RemoteDevice>): RemoteDevice | null
  dispose(): void
}
export interface RemoteSeed { enabled?: boolean; devices?: number; host?: 'online' | 'offline'; hosts?: number }
export function createRemoteSimulator(options?: { now?: () => number; random?: () => number; timers?: TimerLike }): RemoteSimulator
```

Behaviour (all through injected `now`/`random`/`timers` so tests are deterministic):

- `remote.status`: returns `RemoteStatus`. `hostName` "Work PC", relay "relay.bitbots.app".
- `remote.enable`: `link` goes `connecting` then `online` after 700 ms; latency 24 to 60 ms
  (jitter every 5 s while online emits `remote.changed`). `remote.disable` goes straight to
  `off`, disconnects every device (events), keeps the device list.
- `remote.pair.begin`: returns a `PairingOffer`, code 8 chars from an unambiguous alphabet
  (no 0/O/1/I) grouped `XXXX-XXXX`, `qrPayload` like `bitbots://pair?r=<relay>&c=<code>&h=<hostId>`,
  expires after `PAIRING_CODE_TTL_MS`. Beginning again replaces the offer. `remote.pair.cancel`
  clears it. Pairing while disabled is an error `{ code: 'remote_disabled' }`.
- `simulatePairingCompleted`: only when an offer is live; creates a device (default name
  "Pixel 8", kind phone, tier `chat`), clears the offer, appends activity `paired`, emits
  `remote.pairing.completed` and `remote.device.changed`.
- `remote.devices.list/update/revoke`: update accepts `{deviceId, tier?, name?}` (validate
  tier with `isRemoteTier`, name 1 to 40 chars trimmed); revoke removes, appends `revoked`,
  emits events. Unknown id: `{ code: 'not_found' }`.
- `remote.security.get/set`: `RemoteSecurityOptions` with `DEFAULT_REMOTE_SECURITY`; setting
  `approvalsFromRemote` false downgrades any `operator` device to `chat` (emit changes and an
  activity line "Approvals from remote turned off").
- `remote.direct.set` `{enabled}`: toggles `direct` and `directAddress` ("192.168.1.24:7843").
- `remote.activity.list`: newest first, max 50, summaries never contain message content.
- `remote.hosts.list` (client side): `RemoteHost[]` for `hosts` (default 3): "Work PC"
  online (this host, tier chat, 5 bots, 1 waiting), "Home laptop" asleep (last seen 2 h ago),
  "Studio Mac" offline (yesterday). `remote.hosts.select` `{hostId}` marks the active one and
  emits `remote.host.changed`; selecting an offline host succeeds but state stays `offline`.

## 2. Wire into the fixture bridge

In `apps/desktop/src/preview/fixtureBridge.ts` route every `remote.*` method of
`REMOTE_METHODS` in the existing `rpc()` to one shared simulator instance, and forward its
events through the existing event listener set as daemon-style events (a `sequence` that
continues the fixture's counter). URL flags: `?remote=on|off`, `?devices=0|1|3`,
`?host=offline`. Default is `off`, `devices` 0 so the empty state is what people see first.
Also add `remote` to the fixture `app.snapshot` as `remote: RemoteStatus`.

## 3. Tests

`remoteFixture.test.ts` with fake timers: enable timeline, code alphabet and grouping,
expiry, replace offer, pairing completion, tier downgrade on security change, revoke,
activity ordering and cap, host selection, error codes. At least 25 assertions.

## Gates

`npm run typecheck`, `npm run test`. Never commit. Leave the diff and write
`docs/history/fix-17/report.md` (final exported API, flags, anything the contract was missing).
