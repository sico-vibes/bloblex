# Remote mode: phases

> **What this is:** The phases of the Remote mode work.
> **Status:** historical plan; see the status of each phase in docs/operations/session-handoff.md
> **Last updated:** 2026-10-16

**Status:** P0 done in the repository (docs, contract, policy, simulator, mock UI). P1 and P3
are plans. Written 15 October 2026; amended 16 October 2026 for the owner's choice of
Tailscale.

> **Superseded.** The 15 October plan had P1 as a local Noise gateway with a direct LAN address
> and P2 as a hosted relay. With Tailscale, P1 is the Tailscale gateway and P2 (relay) is
> removed. The phase number P2 is left unused so references to P3 stay valid.

| Phase | Outcome | Not included |
|---|---|---|
| **P0 Design and mock** | Docs; contract types; method-tier policy with a parity test; simulator; Settings > Remote; phone client shell; transport seam | Any network, daemon change |
| **P1 Tailscale gateway** | Second loopback listener in `bitbotsd`; `tailscale serve` control; owner-confirmed pairing; device cookies; `remote.*` methods; shared `tiers.json` with Rust enforcement; redaction and event allowlist; audit; PWA build (`dist-remote`) with a real service worker, shipped as a Tauri resource; Settings > Remote wired to the daemon | Attachments, push, a multi-computer switcher |
| ~~**P2 Relay**~~ | Removed on 16 October 2026 | — |
| **P3 Push and polish** | Content-free push notifications; install prompts; notification permission flow; Badging API; a switcher that opens other computers' addresses | Native app stores |

## P0 deliverables (this repository)

- `docs/remote/*` (this folder).
- `src/remote/remoteContract.ts`, `remoteTiers.ts` (+ tests, parity test against the daemon).
- `src/preview/remoteFixture.ts` and the `remote.*` routing in `fixtureBridge.ts`.
- `src/ui/RemoteSettings.tsx`, `src/remote/RemoteApp.tsx`, `remote.html`, `remote.webmanifest`,
  `remote-sw.js` (inert).
- `src/transport/*` (FIX16): `platform()` flags and no direct `@tauri-apps` imports in UI code.

## P1 deliverables

Work packages from the approved plan (WP6a–d). The backend spec is
`docs/FIX29_REMOTE_TAILSCALE_SPEC.md` (to be written); the UI is FIX30.

- **WP6a policy.** Tier table, event policy and settings allowlist move to `remote/tiers.json`.
  Rust loads it with `include_str!`; `remoteTiers.ts` imports the same JSON. Redactors are
  ported to `policy.rs` and kept equal with golden fixtures run by both Rust and Vitest.
- **WP6b gateway.** `crates/bloblex-daemon/src/remote/` (`mod`, `policy`, `tailscale`,
  `pairing`, `web`); tables `remote_devices` and `remote_activity` (capped at 500 rows); the
  settings `remote.enabled`, `remote.port`, `remote.servePort` and `remote.security`, which
  `settings.set` refuses.
- **WP6c PWA build.** `vite.remote.config.ts` (input `remote.html`, output `dist-remote`,
  public folder `remote-public/` with the manifest and 192, 512 and maskable icons);
  `remoteTauri.ts` on `remoteTransport.ts`; a real service worker; the `remote-web/` Tauri
  resource and `BITBOTS_REMOTE_WEB_DIR`.
- **WP6d docs.** This folder and `docs/ipc-contract.md`, amended 16 October 2026.

## P1 exit criteria

1. Every daemon method and event has a tier row in `tiers.json`; the parity test is green and
   covers new methods.
2. The gateway calls internal dispatch only; a test proves the capability token is absent from
   responses, events, errors and logs.
3. Redaction tests use the real snapshot shape, and the golden fixtures pass in Rust and Vitest.
4. Pairing: 5-minute expiry, 5 attempts then burned, offer locked by the first correct code,
   owner approval with a tier, cookie issued, only its hash stored, revoke; all covered.
5. A paired phone on the tailnet can read a conversation and send a message; a `viewer` device
   cannot send; `permission.reply` from a `chat` device is refused with `tier_required`, and from
   an `operator` device while approvals from remote are off with `approvals_disabled`.
6. Quiet hours and idle expiry enforced on the host.
7. The owner-approved AGENTS.md amendment is merged ([AGENTS_AMENDMENT_DRAFT.md](AGENTS_AMENDMENT_DRAFT.md)).
8. Threat-model review items checked off, including THREAT_MODEL.md sections 9, 10 and 11.
9. Tests prove the gateway binds loopback only and never issues `tailscale serve reset` or
   `tailscale funnel`.
10. Open questions 3, 4, 5 and 7 in REVIEW_NOTES.md answered by the owner (1, 2, 9 and 10 are
    superseded by the Tailscale choice).

## P3 exit criteria

1. A push payload contains no text beyond "check in".
2. The service worker never serves a stale shell after a version change.
3. Install prompt flows tested on iOS Safari and Android Chrome.
4. Notification permission is asked only after a user action.

## Risks to schedule around

- iOS PWA cookie behaviour: whether an installed app keeps the cookie set in Safari is
  unverified.
- `Tailscale-User-Login` header behaviour on tagged nodes and nodes shared from other tailnets is
  unverified.
- Tailscale CLI changes to `serve` and `status --json`; parsing is covered by fixtures.
- iOS PWA limits on background connections and push (requires home-screen install).
- Keeping the tier table in step with the daemon: the parity test is the guard.
