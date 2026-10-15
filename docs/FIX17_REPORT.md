# FIX17 report: the Remote mode simulator for the web preview

Written 15 October 2026. Lane: OpenCode (`opencode-go/deepseek-v4.1-flash`). No commit.

## What shipped

- `apps/desktop/src/preview/remoteFixture.ts` — new, pure-TypeScript in-memory simulator.
- `apps/desktop/src/preview/remoteFixture.test.ts` — new, 12 tests / 82 `expect` calls, fake timers.
- `apps/desktop/src/preview/fixtureBridge.ts` — routes every `remote.*` method of
  `REMOTE_METHODS` to one shared simulator and forwards its events; seeds it from URL flags;
  adds `remote: RemoteStatus` to the fixture `app.snapshot`.
- `apps/desktop/src/types.ts` — `Snapshot` gains an optional `remote?: RemoteStatus`.
- `apps/desktop/src/remote/remoteContract.ts` — **not edited**.

No `.css`, component, `src/transport/*` or Rust file was touched. No timers are started at
import time: the simulator only schedules when `remote.enable` is called or a seed with
`enabled: true` is applied (and the bridge applies the seed lazily on the first `remote.*`
call or `fetchSnapshot`, not at module load).

## Final exported API

`apps/desktop/src/preview/remoteFixture.ts`:

```ts
export interface TimerLike {
  setTimeout(handler: () => void, delay: number): unknown
  clearTimeout(handle: unknown): void
}
export interface RemoteSimulator {
  call(method: RemoteMethod, params: Record<string, unknown>): Promise<unknown>
  subscribe(listener: (event: { type: RemoteEventType; payload: unknown }) => void): () => void
  reset(seed?: RemoteSeed): void
  simulatePairingCompleted(device?: Partial<RemoteDevice>): RemoteDevice | null
  dispose(): void
}
export interface RemoteSeed { enabled?: boolean; devices?: number; host?: 'online' | 'offline'; hosts?: number }
export function createRemoteSimulator(options?: { now?: () => number; random?: () => number; timers?: TimerLike }): RemoteSimulator
```

Nothing else is exported. `now`, `random` and `timers` are injected; the defaults are
`Date.now`, `Math.random` and `globalThis.setTimeout/clearTimeout`. Under `vi.useFakeTimers()`
the defaults are faked, so the tests need no explicit `timers`.

### Method return shapes (the contract only names methods, not results)

| Method | Returns |
| --- | --- |
| `remote.status` | `RemoteStatus` |
| `remote.enable` / `remote.disable` | `RemoteStatus` (the post-call state) |
| `remote.pair.begin` | `PairingOffer` |
| `remote.pair.cancel` | `{ cancelled: true }` |
| `remote.devices.list` | `RemoteDevice[]` |
| `remote.devices.update` | `RemoteDevice` |
| `remote.devices.revoke` | `{ revoked: true; deviceId: string }` |
| `remote.security.get` / `remote.security.set` | `RemoteSecurityOptions` |
| `remote.activity.list` | `RemoteActivityEntry[]` (newest first, ≤ 50) |
| `remote.direct.set` | `RemoteStatus` |
| `remote.hosts.list` | `RemoteHost[]` |
| `remote.hosts.select` | `RemoteHost` |

### Event payloads (all objects, so the bridge can forward them as daemon-style `payload`)

| Event | Payload |
| --- | --- |
| `remote.changed` | `RemoteStatus` |
| `remote.device.changed` | `{ device: RemoteDevice; change: 'added' \| 'updated' \| 'removed' }` |
| `remote.pairing.completed` | `{ device: RemoteDevice }` |
| `remote.activity` | `{ entry: RemoteActivityEntry }` |
| `remote.host.changed` | `{ hostId: string; host: RemoteHost; activeHostId: string }` |

Errors are thrown as `Error` whose `message` is `` `${code}: ${detail}` `` and which carries a
`code` property, so both `rejects.toThrow('not_found')` and
`rejects.toMatchObject({ code: 'not_found' })` work.

## Behaviour notes and judgement calls

- **Enable timeline.** `remote.enable` emits `remote.changed` with `link: 'connecting'`, then
  after 700 ms emits `link: 'online'`, sets `since` and a latency in 24–60 ms, and starts a
  self-rescheduling 5 s jitter that re-rolls the latency and emits `remote.changed` each tick.
  `remote.disable` cancels the connect/jitter timers and the pairing timer.
- **Seeded-online hosts skip the timeline.** `reset({ enabled: true })` (i.e. `?remote=on`)
  goes straight to `link: 'online'` with a latency; it does not replay connecting→online,
  because it models a host that is already enabled when the window opens.
- **`keepAwake`** is `true` whenever remote is enabled — `RemoteStatus` documents the field but
  the contract gives no policy, so this is a deliberate fixture value.
- **`host: 'offline'` (`?host=offline`)** marks the current host (the `Work PC` entry in
  `remote.hosts.list`) `offline` with a recent last-seen. The host Side input has no `offline`
  link state in `RemoteLinkState`, so the flag is applied to the client-side host list.
- **Devices.** Seed devices cycle `Pixel 8` (phone, chat), `iPad Air` (tablet, viewer),
  `Loft laptop` (browser, operator). The operator preset means `?devices=3` gives the security
  downgrade something to act on.
- **`remote.hosts.select`** stores `activeHostId` internally and reports it in the
  `remote.host.changed` payload; selecting an offline/sleeping host succeeds without changing
  its state.
- **Security activity line.** `remote.security.set` with `approvalsFromRemote === false` always
  appends the `"Approvals from remote turned off"` activity entry and downgrades every
  `operator` device, even if the value was already `false`. Its activity `kind` is `approval`
  (the closest of the seven contract kinds); `deviceId` is empty and `deviceName` is the host
  name, because no single device owns the change.
- **Device update does not block `operator`.** Setting `tier: 'operator'` is allowed regardless
  of `approvalsFromRemote`; only turning approvals *off* forces the downgrade, which is the
  literal reading of the spec.
- **Pairing code.** `qrPayload`'s `c=` carries the grouped code (`K7QM-4XPD`), matching the
  `<code>` placeholder.
- **Activity cap** is enforced on insert (unshift, then truncate to 50), and every summary is a
  short sentence about pairing/removal/settings — never message content.

## URL flags (fixture bridge)

- `?remote=on|off` — default `off`.
- `?devices=0|1|3` — default `0`; any other value is treated as `0`.
- `?host=offline` — default `online`.
- `?hosts=<n>` is supported by `RemoteSeed`/`reset` but is not wired to a URL flag (not in the
  spec); the bridge always uses 3.

The seed is read once, lazily, on the first `remote.*` call or the first `fetchSnapshot()`.

## What the contract (`remoteContract.ts`) was missing

The contract fixes types, method names and event names but leaves these to the implementer;
none were blocking, and none required editing the contract:

1. **No response payload types.** `REMOTE_METHODS` names methods only; the returned shapes above
   are my choice, so the daemon lane will need to adopt or override them.
2. **No event payload types.** `REMOTE_EVENTS` names events only; payload shapes are invented
   here (kept as objects so they can flow through `DaemonEvent.payload`, which is
   `Record<string, unknown>`).
3. **No error type or code constants.** Only `remote_disabled` and `not_found` appear in the
   FIX17 prompt prose; `invalid_argument` and `unsupported` are used here for bad params and an
   unknown method.
4. **No `keepAwake` policy** on `RemoteStatus`, and **no "active host" field** on `RemoteHost` /
   `RemoteStatus`, so host selection state lives only in the simulator and its event payload.
5. **No grouping rule for `PairingOffer.qrPayload`** (grouped vs. ungrouped code) and no
   documented return value for `remote.enable` / `remote.disable` / `remote.direct.set`.
6. **The design docs it points at do not exist yet.** `remoteContract.ts` refers to
   `docs/remote/ARCHITECTURE.md`, and the FIX17 prompt to `docs/remote/`; that directory is
   absent at this commit, so the simulator was written from the prompt and the contract alone.

## Gates

- `npm run typecheck` — clean (`tsc -b --pretty false`).
- `npm run test` — 109 files / 701 tests passed (includes the 12 new tests).
- No `git commit` was run; the diff is left in the worktree for review.
