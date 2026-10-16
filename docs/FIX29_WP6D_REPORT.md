# FIX29 WP6d report — the remote UI contract, hook and simulator on the Tailscale design

Lane: OpenCode `opencode-go/deepseek-v4.1-flash` (high effort), worktree `C:\fx48`, branch
`lane/fix29-wp6d`. Non-visual only. **No `git commit` was run.** Spec:
[FIX29_WP6D_CONTRACT_SPEC.md](FIX29_WP6D_CONTRACT_SPEC.md). Authoritative daemon shapes:
`docs/ipc-contract.md:141-165`, `docs/remote/PROTOCOL.md:167-207`,
`docs/remote/ARCHITECTURE.md`.

Files changed:

| File | Change |
|---|---|
| `apps/desktop/src/remote/remoteContract.ts` | New types; methods/events lists aligned to the daemon |
| `apps/desktop/src/remote/useRemote.ts` | Wrapped results, `request`, `lastOutcome`, pairing actions |
| `apps/desktop/src/preview/remoteFixture.ts` | Simulator rewritten for the Tailscale design |
| `apps/desktop/src/preview/remoteFixture.test.ts` | Rewritten and extended (12 → 19 tests) |
| `apps/desktop/src/remote/useRemote.test.tsx` | **New** hook test (6 tests) |
| `apps/desktop/src/preview/fixtureBridge.ts` | Preview seed flag, `remote.preview.pair` |
| `apps/desktop/src/ui/RemoteSettings.tsx` | Compile fallout only, marked |
| `apps/desktop/src/remote/RemoteApp.tsx` | Compile fallout only, marked |
| `apps/desktop/src/ui/CompanionPanels.tsx` | Compile fallout only, marked |
| `apps/desktop/src/ui/RemoteChip.mounted.test.tsx` | Status fixture for the new shape |
| `apps/desktop/src/ui/RemoteSettings.mounted.test.tsx` | Pairing flow adapted |
| `apps/desktop/src/remote/RemoteApp.mounted.test.tsx` | Seed no longer passes `hosts` |

`apps/desktop/src/remote/remoteTiers.ts` and `remoteTiers.parity.test.ts` are untouched
(WP6a/6b territory).

## 1. Types (`remoteContract.ts`)

- `RemoteLinkState = 'off' | 'starting' | 'online' | 'error'`. `connecting`/`reconnecting`
  are gone.
- `RemoteTailscaleState = 'not_installed' | 'logged_out' | 'https_disabled' | 'port_in_use'
  | 'funnel_on' | 'ready'` (named alias, used by `RemoteStatus.tailscale`).
- `RemoteStatus = { enabled, link, url: string | null, port: number, servePort: number | null,
  tailscale, hostName, deviceCount, connectedCount, keepAwake, error: string | null }`.
  Removed: `relay`, `latencyMs`, `since`, `direct`, `directAddress`.
- `PairingOffer = { code, url, qrPayload, expiresAt, attemptsLeft }` — no `relay`; `url` is the
  serve URL and `qrPayload` is that URL (`ARCHITECTURE.md:129-130`).
- `PairingRequest = { pairingId, name, kind: DeviceKind, platform, login: string | null,
  expiresAt }` — payload of `remote.pairing.requested`, flattened as the contract writes it.
- `PairingOutcome = 'approved' | 'rejected' | 'expired' | 'cancelled' | 'burned'`.
- `REMOTE_METHODS`: the twelve daemon methods (`remote.status`, `remote.enable`,
  `remote.disable`, `remote.pair.begin`, `remote.pair.cancel`, `remote.pair.confirm`,
  `remote.devices.list`, `remote.devices.update`, `remote.devices.revoke`,
  `remote.security.get`, `remote.security.set`, `remote.activity.list`).
  `remote.direct.set`, `remote.hosts.list`, `remote.hosts.select` are dropped.
- `REMOTE_EVENTS`: `remote.changed`, `remote.pairing.requested`, `remote.pairing.completed`,
  `remote.device.changed`, `remote.activity`. `remote.host.changed` is dropped.
- Kept unchanged: `RemoteTier`/`REMOTE_TIERS`, `DeviceKind`, `RemoteDevice`,
  `RemoteSecurityOptions`, `RemoteActivityKind`/`RemoteActivityEntry`, `RemoteHostState` and
  `RemoteHost` (the phone client keeps its own list of computers on the device),
  `PAIRING_CODE_TTL_MS`, `isRemoteTier`, `tierAtLeast`, `DEFAULT_REMOTE_SECURITY`.
- Added `PAIRING_MAX_ATTEMPTS = 5` (the code's five wrong attempts).

## 2. Hook (`useRemote.ts`)

- `remote.devices.list` is read as `{devices}` and `remote.activity.list` as `{entries}`; a bare
  array is still accepted for both (`devicesFrom` / `activityFrom`).
- `RemoteState` gains `request: PairingRequest | null` (set on `remote.pairing.requested`,
  cleared on `remote.pairing.completed` or on the next reload once its `expiresAt` has passed)
  and `lastOutcome: { outcome: PairingOutcome; device: RemoteDevice | null } | null` (set on
  `remote.pairing.completed`; the device is resolved by `deviceId` from the reloaded list).
- `justPaired` is no longer state: it is **derived** (`lastOutcome.outcome === 'approved' ?
  lastOutcome.device : null`) and returned beside the state, because the current Settings page
  still reads it. `dismissPaired()` clears `lastOutcome`. `RemoteHookState` documents this.
- Actions: `confirmPairing(pairingId, tier)` → `remote.pair.confirm {pairingId, approve: true,
  tier}`; `rejectPairing(pairingId)` → `{pairingId, approve: false}`; `setDirect` is removed;
  `simulatePairing()` is kept as preview-only and now means "the phone submitted the right code"
  (it raises `remote.pairing.requested` through the simulator). `enable`, `disable`,
  `beginPairing`, `cancelPairing`, `updateDevice`, `revokeDevice`, `setSecurity` and
  `dismissPaired` keep their names and shapes.
- A failed action's message stays in `state.error`: `load()` no longer resets `error` (only the
  next action clears it at its start). Without this, the reload that follows a refused
  `remote.enable` wiped the `unsupported` message that names the Tailscale fix. Covered by a
  test.
- `useRemoteStatus` is unchanged apart from the new `RemoteStatus`/`RemoteLinkState` types.

## 3. Simulator (`remoteFixture.ts`)

Constructor options (`now`, `random`, `timers`), `subscribe`, `reset`, `dispose` and the
`call(method, params)` seam are unchanged. `RemoteSeed` is now
`{ enabled?, devices?, tailscale? }`.

Methods, results:

| Method | Result |
|---|---|
| `remote.status` | bare `RemoteStatus`: `url` `https://work-pc.tail1234.ts.net`, `port` 48620, `servePort` 443 while served, `tailscale`, `hostName` "Work PC" |
| `remote.enable` | `link: 'starting'` with `url`/`servePort` null, then after 700 ms `link: 'online'` with the serve address; emits `remote.changed` at each step. With any non-`ready` Tailscale state it changes nothing and rejects `unsupported` with a one-line fix naming install / sign-in / HTTPS certificates / ports 443+8443 / Funnel |
| `remote.disable` | `link` back to `off`, `url`/`servePort` null, every device marked offline (one `remote.device.changed` each); paired devices are kept |
| `remote.pair.begin` | `{code (K7QM-4XPD form), url, qrPayload = url, expiresAt (5 min), attemptsLeft: 5}`; a new code cancels the old one; `conflict` while Remote is off |
| `remote.pair.cancel` | burns the live offer; with a waiting request it emits `remote.pairing.completed {outcome: 'cancelled'}` |
| `remote.pair.confirm` | `{pairingId, approve, tier}`. Approve (tier required) creates the device with that tier, writes a `paired` activity line and emits `remote.pairing.completed {outcome: 'approved', deviceId}`, `remote.device.changed {action: 'added'}`, `remote.activity`, `remote.changed`. Reject writes a `denied` line and emits `{outcome: 'burned'}` as the spec asks. Bad `approve`, bad `tier`, unknown/expired `pairingId` are refused without consuming the request |
| `remote.devices.list` | `{devices}` |
| `remote.devices.update` | as before, now emitting `remote.device.changed {action: 'updated'}` |
| `remote.devices.revoke` | as before, emitting `{action: 'removed'}` |
| `remote.security.get` / `.set` | unchanged, including the operator downgrade when approvals from remote is switched off |
| `remote.activity.list` | `{entries}`, newest first, capped at 50 |

Pairing lifecycle the simulator models: one live offer; a wrong code counts an attempt
(`pairing_invalid`); the fifth wrong attempt burns the code; the first correct code (matched
case-insensitively and without the group dash) locks the offer to a `PairingRequest`, clears the
offer and raises `remote.pairing.requested`; the request expires with the code, and that expiry
is a `remote.pairing.completed {outcome: 'expired'}`. `simulatePhoneRequest({ code?, name?, kind?,
platform?, login? })` is the preview seam for the phone's `POST /api/pair`, replacing the old
`simulatePairingCompleted`.

Preview flags (`fixtureBridge.ts`): `?remote=off|on|<tailscale state>` — `off` (default) is off
with the serve address none, `on`/`ready` seed a working serve address, and
`not_installed|logged_out|https_disabled|port_in_use|funnel_on` seed Remote off with that
Tailscale state so the refusal path can be inspected. `?devices=0|1|3` is unchanged. Unknown
values fall back to `off`. `?host=offline` no longer exists (there is no host list in the
simulator).

Dropped from the simulator: the relay, the direct address (`remote.direct.set`), the latency
field and its 5-second jitter, `remote.hosts.list`/`remote.hosts.select`, and the
`remote.host.changed` event.

## 4. `// FIX29 UI: Director` spots

Six markers, all compile fallout, none a restyle or a rewrite:

1. `ui/RemoteSettings.tsx` — the "Allow remote devices" toggle's disabled check
   (`connecting` → `starting`).
2. `ui/RemoteSettings.tsx` — the status line: `relay`/`latencyMs`/`since` replaced by
   `status.url` and the device counts; before the change it read "Waiting for the relay".
3. `ui/RemoteSettings.tsx` — the pairing offer names `state.offer.url` instead of
   `state.offer.relay`.
4. `ui/RemoteSettings.tsx` — the Advanced "also listen on this network" group (and
   `remote.setDirect`) removed; there is no direct LAN listener.
5. `ui/CompanionPanels.tsx` — `REMOTE_DOT` map keys (`connecting`/`reconnecting` →
   `starting`).
6. `remote/RemoteApp.tsx` — the phone client's computer list: `remote.hosts.list`/
   `remote.hosts.select` no longer exist, so a `PREVIEW_HOSTS` placeholder stands in for the
   device-side store (`PROTOCOL.md:164`, `ARCHITECTURE.md:152-157`).

Copy that still says "relay" (the Settings hint, the preview ribbon, the device screen) was left
alone: it is the Director's UI text and is rewritten with the page.

Two UI-test edits were needed to keep the suite green, and are declared here rather than as
production work:

- `ui/RemoteChip.mounted.test.tsx` — its `RemoteStatus` fixture carried the removed fields; the
  "connecting or reconnecting" case became "starting".
- `ui/RemoteSettings.mounted.test.tsx` — `remote.preview.pair` now raises a request instead of
  creating a device, and the current page has no approve control (the Director's rewrite adds
  it), so the pairing test answers through the simulator's host side
  (`remote.pair.confirm`), which is what the page will call.
- `remote/RemoteApp.mounted.test.tsx` — dropped `hosts: 3` from the seed (the key is gone).

## 5. Deliberate alignments worth a look

These follow `docs/ipc-contract.md`, which the spec calls authoritative, but go beyond the
bullets in the spec:

- `remote.changed` now carries `{status}` and `remote.device.changed` carries
  `{action, device}` (the contract's written shape), where the simulator previously sent a bare
  `RemoteStatus` and `{device, change}`. Nothing in the renderer read either payload.
- `remote.pair.begin` while Remote is off is `conflict`, as the contract's row says, not the
  simulator's old `remote_disabled`.
- A rejection emits `outcome: 'burned'` per the spec's parenthetical, not `'rejected'`; the
  `rejected` member stays in the type because the phone-side poll returns it
  (`PROTOCOL.md:189-191`).
- `remote.devices.list`/`remote.activity.list` results are wrapped `{devices}`/`{entries}`, and
  the simulator now also *answers* in that shape (it used to return bare arrays).
- A rejected pairing writes a content-free `denied` activity line, matching the gateway's
  "audit for writes, approvals and denials" rule.

## 6. Tests

- `preview/remoteFixture.test.ts` — 19 tests: enable timeline, all five refusal states, status
  identity, disable, code format/`url`/`qrPayload`/`attemptsLeft`/TTL, wrong-code counting and
  burning, case-insensitive acceptance, offer replacement, the owner-confirmed lifecycle
  (request → approve → device with the chosen tier → completed/added/activity), rejection →
  burned, expiry, cancel, security/operator downgrade, device update/revoke, activity cap,
  "answers every method the contract lists", "emits every event the contract lists", unknown
  method, dispose.
- `remote/useRemote.test.tsx` (new, happy-dom) — wrapped and bare results; `request` set and
  cleared with `lastOutcome` resolved by `deviceId`; `justPaired` derivation and
  `dismissPaired`; an out-of-date request dropped on reload; `confirmPairing`/`rejectPairing`
  call arguments; a failed `enable` message surviving the reload; the offer cleared when the
  phone locks it.

What these prove: the TypeScript contract, the hook's reading of the wrapped results and events,
and the simulator's behaviour, against the documented shapes. What they do **not** prove: any
real daemon, any real Tailscale behaviour, or that a real phone can pair. No daemon code answers
`remote.*` in this repository yet; on a real desktop `available` stays false.

## 7. Gates

Run in `apps/desktop` on the final content, in the order the spec gives
(`npx tsc -b && npx vitest run && npm run build`):

| Gate | Result |
|---|---|
| `npx tsc -b` | clean, no output |
| `npx vitest run` | **138 files passed, 913 tests passed, 0 failed** (72 s) |
| `npm run build` | `built in 5.83s`; only the pre-existing fontsource/chunk-size warnings |

Baseline before the change, same checkout: `tsc -b` clean, 137 files / 900 tests passed, build
clean. Net: +1 file, +13 tests.

## 8. Not done, and honest notes

- **The Settings page cannot finish a pairing by clicking yet.** It shows the code and the
  "Simulate a phone pairing" button, but it has no owner-approval control, because adding one is
  the Director's rewrite. The preview's pairing path therefore needs the simulator's
  `remote.pair.confirm` (which is exactly what the mounted test does) until then.
- **Stale design docs, not edited.** `docs/remote/UX_FLOWS.md:8` still lists `?remote=on|off` and
  `?host=offline`, and `docs/FIX17_REMOTE_SIMULATOR_SPEC.md` / `docs/FIX17_REPORT.md` describe
  the old relay-era simulator. Those are Director documents or historical records, and the spec
  did not list them; this report is the pointer to update them.
- **`RemoteHost`/`RemoteApp` remain a preview-only device shell.** The host list is a placeholder
  and `RemoteApp` still talks to the same `remote.*` bridge; a real PWA over `remoteTransport.ts`
  is WP6c's territory.
- Removal of the flags/fields is only checked by the TypeScript compiler and the tests above;
  no runtime preview was opened by this lane (browser/Companion Use verification is deferred per
  `AGENTS.md`).
