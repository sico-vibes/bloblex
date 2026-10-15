# Draft amendment for AGENTS.md: Remote mode (for owner approval)

**Not in force.** `AGENTS.md` has not been edited. This is proposed wording for the owner to
accept, change or reject. Written 15 October 2026.

## Why an amendment is needed

Three standing statements conflict with Remote mode as designed:

1. `docs/ipc-contract.md`: the daemon "must never bind `0.0.0.0`, a LAN interface, or IPv6
   wildcard", is reachable only from loopback, and the capability "exists only in daemon memory
   and the desktop shell's child-process channel".
2. `docs/ipc-contract.md`: "If another UI client is needed, it must receive the secret through
   the same authenticated native shell path."
3. `AGENTS.md`: no copied provider authentication; keep prompts in stdin/protocol (unchanged by
   this proposal, listed so reviewers can see nothing else moves).

## Proposed text

> **Amendment (date to be set by the owner): Remote mode.**
>
> Owner directive. Remote mode lets paired devices reach a host's bots through a gateway
> inside the daemon. This amends the loopback and capability rules for this one path only.
>
> - **The loopback API is unchanged.** The daemon's HTTP and WebSocket listeners stay on
>   `127.0.0.1`, protected by the capability, and the Tauri shell path is unchanged.
> - **The gateway is the only remote entry.** It is off by default, compiled into the daemon,
>   and never exposes the capability. It calls internal dispatch and applies the method-tier
>   policy in `apps/desktop/src/remote/remoteTiers.ts` (mirrored in the daemon), which is
>   enforced by a parity test against the dispatch table.
> - **Authorisation is per device.** Each device has its own key, tier and revocation. The
>   default tier is Chat. Approvals from remote are off by default and require an explicit
>   host setting plus the Chat and approve tier.
> - **Never remote:** `settings.set`, agent create/update/delete, runtime profile changes,
>   runtime refresh, file revert, automation writes, memory writes, daemon shutdown and every
>   native Tauri command.
> - **Content stays private.** Traffic is end-to-end sealed between device and host. Relays
>   store nothing. No message text appears in logs, push payloads or the activity list.
> - **Direct (LAN) listening is an advanced option,** off by default, and uses the same
>   handshake and tiers. It is the only permitted non-loopback bind and only while enabled.
> - **No provider credentials, tokens or environment values leave the host.** Snapshots are
>   redacted by `redactSnapshotForRemote`.
> - **Release gate.** Remote does not ship until the checklist in
>   `docs/remote/THREAT_MODEL.md` section 8 is complete and an independent reviewer has signed
>   off the secure channel and key storage.

## Decisions the owner is asked to make

1. Accept the amendment as written, or narrow it (for example: relay only, no direct listener).
2. Confirm that the default tier is **Chat** and approvals from remote are **off**.
3. Confirm that Bitbots may operate a public relay, or that a self-hosted relay is the only
   supported option at first.
4. Confirm that no account is required for pairing (device keys only).
