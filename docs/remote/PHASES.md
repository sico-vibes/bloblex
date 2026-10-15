# Remote mode: phases

**Status:** P0 done in the repository (docs, contract, policy, simulator, mock UI). P1 to P3
are plans. Written 15 October 2026.

| Phase | Outcome | Not included |
|---|---|---|
| **P0 Design and mock** | Docs; contract types; method-tier policy with a parity test; simulator; Settings > Remote; phone client shell; transport seam | Any network, crypto, daemon change |
| **P1 Local gateway** | `remote.*` methods in `bitbotsd`; Noise sessions; device records; tier enforcement; snapshot redaction; audit; direct address on LAN; browser client talking to a second browser on the same network | Relay, push, PWA install flow |
| **P2 Relay** | Stateless forwarding service; host and device hello; rate limits; self-host option; end-to-end test over the internet | Push, offline shell |
| **P3 Push and PWA** | Content-free wake pings; service worker caching of the shell; install prompts; notification permission flow; Badging API | Native app stores |

## P0 deliverables (this repository)

- `docs/remote/*` (this folder).
- `src/remote/remoteContract.ts`, `remoteTiers.ts` (+ tests, parity test against the daemon).
- `src/preview/remoteFixture.ts` and the `remote.*` routing in `fixtureBridge.ts`.
- `src/ui/RemoteSettings.tsx`, `src/remote/RemoteApp.tsx`, `remote.html`, `remote.webmanifest`,
  `remote-sw.js` (inert).
- `src/transport/*` (FIX16): `platform()` flags and no direct `@tauri-apps` imports in UI code.

## P1 exit criteria

1. Every daemon method has a tier; the parity test is green and covers new methods.
2. The gateway calls internal dispatch only; a test proves the capability token is absent from
   frames, errors and logs.
3. Redaction tests use the real snapshot shape.
4. Pairing: one-time code, expiry, attempt limits, device record, revoke; all covered.
5. A device on another browser can read a conversation and send a message; a View only device
   cannot send; an approval from a non-operator is refused with `approvals_disabled`.
6. Quiet hours and idle expiry enforced on the host.
7. The owner-approved AGENTS.md amendment is merged ([AGENTS_AMENDMENT_DRAFT.md](AGENTS_AMENDMENT_DRAFT.md)).
8. Threat-model review items checked off, including the additions in THREAT_MODEL.md sections 9 and 10.
9. Open questions 1, 3, 4, 5, 7 and 10 in REVIEW_NOTES.md answered by the owner.

## P2 exit criteria

1. The relay stores nothing (verified by a test that inspects its data directory).
2. Host reconnects and devices resume from cursor after a relay restart.
3. Rate limits and frame limits enforced with tests.
4. A self-hosted relay works with a changed address in the pairing payload.
5. Load test for 1,000 idle host connections.

## P3 exit criteria

1. A push payload contains no text beyond "check in".
2. The service worker never serves a stale shell after a version change.
3. Install prompt flows tested on iOS Safari and Android Chrome.
4. Notification permission is asked only after a user action.

## Risks to schedule around

- Noise library choice and review for both Rust and browser (WebCrypto lacks X25519 in some
  browsers; a WASM implementation may be needed).
- iOS PWA limits on background connections and push (requires home-screen install).
- Relay operations (abuse handling, uptime) if Bitbots hosts it.
- Keeping the tier table in step with the daemon: the parity test is the guard.
