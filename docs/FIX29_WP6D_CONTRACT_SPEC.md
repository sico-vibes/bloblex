# FIX29 (WP6d): align the remote UI contract, hook and simulator with the Tailscale design

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, own worktree. Director reviews, runs the gates and commits. **Do not run `git commit`.** Read `AGENTS.md` first.

The daemon's `remote.*` methods and events are fixed in `docs/ipc-contract.md` (lines ~140-165) and `docs/remote/PROTOCOL.md` §4.3. The renderer's model of them still describes the old relay design. Bring these files in line; **non-visual only**:
- `apps/desktop/src/remote/remoteContract.ts`
- `apps/desktop/src/remote/useRemote.ts`
- `apps/desktop/src/preview/remoteFixture.ts` (the browser-preview simulator) and its test
- the tests that cover them (`remoteFixture.test.ts`, any `useRemote` test)

## Changes
1. **Types (`remoteContract.ts`).**
   - `RemoteStatus` = `{ enabled, link: 'off'|'starting'|'online'|'error', url: string|null, port, servePort: number|null, tailscale: 'not_installed'|'logged_out'|'https_disabled'|'port_in_use'|'funnel_on'|'ready', hostName, deviceCount, connectedCount, keepAwake, error: string|null }`. Remove `relay`, `latencyMs`, `since`, `direct`, `directAddress`. `RemoteLinkState` follows the new `link` values.
   - `PairingOffer` = `{ code, url, qrPayload, expiresAt, attemptsLeft }` (no `relay`).
   - New `PairingRequest` = `{ pairingId, name, kind: DeviceKind, platform, login: string|null, expiresAt }` (payload of `remote.pairing.requested`).
   - New `PairingOutcome` = `'approved'|'rejected'|'expired'|'cancelled'|'burned'`.
   - `REMOTE_METHODS`: the daemon list from the contract (`remote.status`, `remote.enable`, `remote.disable`, `remote.pair.begin`, `remote.pair.cancel`, `remote.pair.confirm`, `remote.devices.list`, `remote.devices.update`, `remote.devices.revoke`, `remote.security.get`, `remote.security.set`, `remote.activity.list`). Drop `remote.direct.set`, `remote.hosts.list`, `remote.hosts.select` from this list; keep the `RemoteHost` types, because the phone client keeps its list of computers on the device.
   - `REMOTE_EVENTS`: `remote.changed`, `remote.pairing.requested`, `remote.pairing.completed`, `remote.device.changed`, `remote.activity`.
2. **Hook (`useRemote.ts`).**
   - Read the contract's wrapped results: `remote.devices.list` → `{devices}`, `remote.activity.list` → `{entries}` (accept a bare array too, for safety).
   - State gains `request: PairingRequest | null` (set on `remote.pairing.requested`, cleared on `remote.pairing.completed` or when it expires) and `lastOutcome: { outcome: PairingOutcome; device: RemoteDevice | null } | null` (from `remote.pairing.completed`; look the device up by `deviceId` after the reload). Remove `justPaired` only if nothing else needs it; otherwise derive it from `lastOutcome`.
   - Actions: add `confirmPairing(pairingId, tier)` → `remote.pair.confirm {pairingId, approve:true, tier}` and `rejectPairing(pairingId)` → `{pairingId, approve:false}`. Remove `setDirect`. Keep `simulatePairing` as a preview-only action, now meaning "the phone submitted the right code" (it makes the simulator raise `remote.pairing.requested`).
   - `remote.enable` failing with `unsupported` keeps its message in `state.error` (it names the Tailscale fix).
   - `useRemoteStatus` unchanged apart from the new type.
3. **Simulator (`remoteFixture.ts`).** Answer every method and emit every event with the new shapes: Tailscale states (seed `ready`; a `?remote=not_installed|logged_out|https_disabled` preview flag switches the seed), `url` like `https://work-pc.tail1234.ts.net`, owner-confirmed pairing (`remote.preview.pair` → `remote.pairing.requested`; `remote.pair.confirm` → device created with the chosen tier and `remote.pairing.completed {outcome:'approved', deviceId}`; reject → `burned`), attempts left, expiry. Drop the relay and direct-address behaviour.
4. **Compile fallout.** `ui/RemoteSettings.tsx`, `remote/RemoteApp.tsx` and other UI may stop compiling. Make the **smallest** change that compiles (drop a reference to a removed field, or feed a placeholder), add `// FIX29 UI: Director` beside each, and list them in the report. Do not redesign or restyle anything; the Director rewrites Settings › Remote afterwards.
5. **Parity.** `apps/desktop/src/remote/remoteTiers.parity.test.ts` and `remoteTiers.ts` are WP6a/6b territory: do not edit them.

## Gates
`cd apps/desktop && npx tsc -b && npx vitest run && npm run build`

## Report
`docs/FIX29_WP6D_REPORT.md`: the new types, hook API, simulator behaviour, the list of `// FIX29 UI: Director` spots, gate results.
