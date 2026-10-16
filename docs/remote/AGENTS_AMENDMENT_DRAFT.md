# Draft amendment for AGENTS.md: Remote mode (for owner approval)

**Not in force.** `AGENTS.md` has not been edited. This is proposed wording for the owner to
accept, change or reject. Written 15 October 2026; rewritten 16 October 2026 for the owner's
choice of Tailscale. The earlier wording (relay, Noise sessions, device keys, direct LAN
listener) is superseded and is not proposed any more.

## Why an amendment is needed

Three standing statements conflict with Remote mode as designed:

1. `docs/ipc-contract.md`: the daemon "must never bind `0.0.0.0`, a LAN interface, or IPv6
   wildcard", is reachable only from loopback, and the capability "exists only in daemon memory
   and the desktop shell's child-process channel". Remote keeps the loopback-only rule but adds
   a second listener whose traffic comes from other machines through `tailscale serve`.
2. `docs/ipc-contract.md`: "If another UI client is needed, it must receive the secret through
   the same authenticated native shell path." The PWA is another UI client and never receives
   the capability.
3. `AGENTS.md`: no copied provider authentication; keep prompts in stdin/protocol (unchanged by
   this proposal, listed so reviewers can see nothing else moves).

## Proposed text

> **Amendment (date to be set by the owner): Remote mode over Tailscale.**
>
> Owner directive. Remote mode lets paired devices on the owner's tailnet reach a host's bots
> through a gateway inside the daemon. This amends the loopback and capability rules for this
> one path only.
>
> - **The daemon API is unchanged.** Its HTTP and WebSocket listeners stay on `127.0.0.1`,
>   protected by the capability, and the Tauri shell path is unchanged.
> - **The gateway is the only remote entry.** It is off by default and compiled into the
>   daemon. It is a second listener on `127.0.0.1:<remote.port>` (default 48620) and nothing
>   else. It never reads, accepts or exposes the capability; it calls `dispatch()` in-process.
> - **Tailscale is the only way in.** The gateway is published with
>   `tailscale serve --bg --https=443` (or 8443). Never `tailscale funnel`, never
>   `tailscale serve reset`, never a non-loopback bind. Turning Remote off removes only
>   Bitbots' own serve handler.
> - **Authorisation is per device.** Pairing needs a one-time code (5 minutes, 5 attempts) and
>   the owner's approval on the desktop, where the owner picks the tier (`viewer`, `chat` or
>   `operator`). The device gets a 256-bit token in an `HttpOnly; Secure; SameSite=Strict`
>   cookie; only its SHA-256 is stored. Every request checks the cookie, revocation and
>   `Origin`, and the Tailscale login when that header is present. Approvals from remote are off
>   by default.
> - **One policy, two languages.** The tier table, event policy and settings allowlist live in
>   `remote/tiers.json`, read by the Rust gateway and the TypeScript client, and a parity test
>   fails the build when a daemon method or event has no row.
> - **Never remote:** `settings.set`, every `remote.*` method, agent create/update/delete,
>   runtime profile changes, runtime refresh, file revert, automation writes, memory writes,
>   daemon shutdown, attachments (in v1) and every native Tauri command.
> - **Content stays private.** No message text appears in logs, push payloads or the activity
>   list. Tailscale status JSON is never logged.
> - **No provider credentials, tokens or environment values leave the host.** Results and
>   events are redacted and allowlisted before they leave.
> - **Release gate.** Remote does not ship until the checklists in
>   `docs/remote/THREAT_MODEL.md` sections 8 and 11 are complete and an independent reviewer
>   has signed off the cookie, Origin and Tailscale handling.

## Decisions the owner is asked to make

1. Accept the amendment as written, or narrow it.
2. Confirm that approvals from remote are **off** by default and that **Chat** is the
   preselected tier at approval.
3. Confirm that Tailscale is the only supported transport (no Bitbots relay, no LAN listener).
4. Confirm that a device with no `Tailscale-User-Login` header (for example a tagged node) may
   still pair, with the cookie as its only proof.
