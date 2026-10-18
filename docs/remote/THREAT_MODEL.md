# Remote mode: threat model

**Status: design.** Written 15 October 2026; amended 16 October 2026 for the owner's choice of
Tailscale. Scope: the gateway, Tailscale serve, paired devices and the pairing flow. Out of
scope: the coding agents' own sandboxing, provider accounts, and Tailscale's own security.

> **Superseded rows.** The 15 October model covered a relay, Noise sessions, X25519 device keys
> and a direct LAN listener. Those parts are gone. Rows that only made sense for them (relay
> reading or correlating traffic, browser key theft, recorded-frame replay, LAN handshakes,
> browser tickets) are marked superseded below. New rows T28–T33 cover Tailscale.

## 1. The core fact

A message sent from a remote device is a prompt to a coding agent on the host. Within the
host's approval mode, that prompt can read files, run commands and change the project.
**Remote access to prompts is remote code execution on the computer, bounded by approvals.**
Every control below exists because of that sentence, and the product says it in plain words.

## 2. Assets

| Asset | Why it matters |
|---|---|
| The host computer and the user's projects | A prompt can act on them. |
| Conversations and tool output | May contain code, secrets pasted by the user, internal paths. |
| Provider credentials (Claude, Codex, OpenCode auth files) | Read by the daemon locally; must never reach a device. |
| The daemon capability token | Full authority over the loopback API. |
| Device cookies | Prove a paired device; whoever holds one acts at its tier. |
| The owner's Tailscale account | Decides which nodes can reach the host at all. |
| The host's `tailscale serve` configuration | May hold other people's handlers; must not be clobbered. |
| Approvals | The brake on unattended action. |

## 3. Actors

- **Owner** on the host and on paired devices.
- **Thief or finder** of a paired, unlocked device.
- **Other members of the tailnet**, or people a node is shared with.
- **Network attacker** outside the tailnet.
- **Other local user or process** on the host.
- **Malicious web page** the owner visits in the same browser as the PWA.
- **Attacker who takes over the owner's Tailscale account.**
- **Compromised provider output** (prompt injection in a repository or web page the agent reads).

## 4. Trust boundaries

1. Device <-> host: WireGuard inside the tailnet, managed by Tailscale. HTTPS with the tailnet
   certificate, terminated by `tailscaled` on the host.
2. `tailscaled` <-> gateway: plain HTTP on `127.0.0.1:<remote.port>`. Any local process can
   reach this port too, so nothing that arrives here is trusted for its source.
3. Gateway <-> daemon dispatch: in-process, trusted.
4. Daemon <-> coding agents: existing boundary, unchanged.
5. Host <-> other local processes: the daemon API stays capability-protected. The gateway is the
   one new loopback listener, and only while Remote is on.

## 5. Abuse cases and mitigations

| # | Abuse | Mitigation | Residual risk |
|---|---|---|---|
| T1 | Stolen unlocked phone sends prompts | Device removable from the host at once; removing the node from the tailnet also cuts it off; owner picks the tier at approval; quiet hours; idle expiry; activity list shows every prompt source | Until removed, the thief can send prompts that run within the approval mode. Document it; recommend "Ask first" mode. |
| T2 | Attacker approves a command from a stolen phone | Approvals from remote are **off by default**; the operator tier only acts while that switch is on | If the owner enables it and loses the phone, approvals are possible until removal. |
| T3 | *Superseded:* relay reads or alters traffic | There is no relay. WireGuard and HTTPS protect the link | — |
| T4 | Pairing code guessed or shoulder-surfed | 8 characters from a 32-symbol alphabet; 5-minute life; 5 wrong attempts burn it; only reachable from inside the tailnet; the owner must approve the device and its tier | A watcher on the tailnet who reads the code and submits first locks the offer; the owner sees an unexpected device and rejects it. |
| T5 | Remote client calls a dangerous method (settings, runtime profile, file revert, `remote.*`) | Host-side tier table in `tiers.json`; never-remote methods denied at every tier; parity test fails the build when a daemon method has no rule | A bug in the table; mitigated by the parity test and review. |
| T6 | Snapshot leaks secrets (env values, instructions, absolute paths) | `redactSnapshotForRemote` strips env values and instruction text, shortens paths, drops keys named like secrets | New fields added later; the redaction test uses an allowlist-minded fixture and must be extended with each new snapshot field. |
| T7 | Attachment used to read arbitrary files | Attachments are refused from remote in v1 | None while refused. |
| T8 | *Superseded:* device key theft from a browser | No device keys; the cookie replaces them (see T32) | — |
| T9 | Malicious web page drives the PWA | Cookie is `SameSite=Strict` and `HttpOnly`; a state-changing request and the WebSocket upgrade must carry an `Origin` equal to an accepted origin, and a safe `GET`/`HEAD` that carries one must match (a browser omits it same-origin); `Sec-Fetch-Site: cross-site`/`same-site` is refused; CSP `connect-src 'self'`, `frame-ancestors 'none'` | Browser vulnerabilities. |
| T10 | *Superseded:* replay of recorded Noise frames | TLS inside WireGuard; a recorded request is useless without the cookie | — |
| T11 | Denial of service on the host | Per-device rate limits; 256 KiB body cap; one event socket per device; reachable only from the tailnet | A paired device can still cost bandwidth until removed. |
| T12 | Prompt injection makes a bot exfiltrate through Remote | Remote adds no new tool or egress; the bot's capabilities and approval mode are unchanged | Existing agent risk, unchanged. |
| T13 | *Superseded:* another user connects to the direct LAN address | There is no LAN listener; see T28 for local processes | — |
| T14 | Audit log leaks content | Entries are one short templated sentence, never message text, paths or command lines | Template mistakes; covered by a unit test on every entry kind. |
| T15 | Host left serving while the owner thinks Remote is off | One master switch; status chip in the sidebar and tray; off stops the listener and removes our serve handler at once | None expected. |

## 6. Defaults that carry the model

1. Remote is off.
2. Approvals from remote are off globally.
3. The owner picks each device's tier at approval; the dialog preselects **Chat**.
4. Idle devices expire in 30 days.
5. Never Funnel, never `serve reset`, never a non-loopback bind.
6. No message text in logs, push payloads or the activity list.

## 7. Not mitigated by design

- A compromised host computer. Remote adds nothing here.
- A user who turns approvals from remote on, sets bypass mode and loses a phone. The product
  warns, and bypass mode is already a typed-confirmation setting.
- Data the user chooses to paste into a chat.
- Tailscale itself being broken. Bitbots relies on WireGuard and the tailnet's access rules.

## 8. Review checklist before P1 ships

- [ ] Every daemon method has a tier rule (parity test green).
- [ ] The gateway calls internal dispatch only; the capability token never appears in a
      response, event, log or error.
- [ ] Snapshot and event redaction covered by tests with the real field set.
- [ ] Rate limits and size limits tested.
- [ ] Pairing: 5-minute expiry, 5 attempts then burned, offer locked by the first correct code,
      owner approval required; all tested.
- [ ] Activity entries tested for content-free templates.
- [ ] Independent review of the cookie, `Origin` and Tailscale-login checks and of the serve and
      Funnel handling.

## 9. Additions from the independent review (15 October 2026)

Source: [REVIEW_NOTES.md](REVIEW_NOTES.md). These rows continue the table in section 5.

| # | Abuse | Mitigation | Residual risk |
|---|---|---|---|
| T16 | Two devices race for one pairing code | The first correct code locks the offer; later submissions are refused; the owner approves name, platform and Tailscale login before a record exists | A watcher who wins the race is caught by the owner's approval |
| T17 | *Superseded:* relay correlates devices and hosts | No relay. Tailscale's coordination server sees node metadata, as it does for every tailnet | Covered by T33 |
| T18 | Cloned device credential | One live event socket per device; a second closes the first and writes an activity line; Tailscale-login check when the header is present (see T32) | A clone used while the original is offline |
| T19 | Push counts reveal activity | Push payload is "check in" only, no counts; counts stay inside the tailnet | Existence of a push is itself a signal |
| T20 | Staged attachment ids guessed or reused, decompression bombs | Attachments are refused in v1 | Returns when staging is designed |
| T21 | Event payloads carry secrets (message bodies, tool output) | Event allowlist and per-event scrubbing; tool detail off by default; message text is the conversation and is shown | A secret pasted into a chat is visible to the owner's own devices by design |
| T22 | Snapshot fields outside the redactor (paths, args, attachments) | The redactor's field policy in `tiers.json` and `policy.rs`; results of other reads go through `redactResultForRemote`; golden fixtures run in both Rust and Vitest | New fields added later must be added to the policy and its test |
| T23 | *Superseded:* browser WebSocket cannot carry headers | The same-origin cookie travels on the upgrade; `Origin` is checked | — |
| T24 | CSRF or framing of the PWA | `SameSite=Strict` cookie, `Origin` check, `frame-ancestors 'none'`, `connect-src 'self'`, approvals need a user gesture inside the PWA | Browser bugs |
| T25 | Quiet hours bypassed through cancel, archive or queue send | Quiet hours are a hard read-only override applied before dispatch | None expected |
| T26 | Revocation leaves a session open | Revoking marks the device revoked and closes the event socket on the host; the next request fails with `device_revoked` | None expected |
| T27 | Viewer forces provider polling or reads host config | `runtime.models refresh` refused remotely; executable paths and arguments redacted | None expected |

### Corrections to earlier rows

- **T5:** the tier table is an executable specification and a parity test of method **names**.
  Enforcement does not exist until the gateway applies it. The risk stays open until then.
- **T9:** the content security policy is a requirement, not a present fact.
- **T14:** a unit test over every activity-entry template is a requirement for P1; none exists.
- **Idle expiry:** the "Never" option removes the only automatic containment for a forgotten
  device; the UI keeps 30 days as the default and warns on "Never".
- **Redaction is not defence in depth.** It is the only layer between the host and a device for
  fields the daemon keeps.

## 10. Tailscale threats (16 October 2026)

| # | Abuse | Mitigation | Residual risk |
|---|---|---|---|
| T28 | A local process spoofs `tailscaled`: it connects straight to `127.0.0.1:<remote.port>` and forges `Tailscale-User-Login` or `Origin` | The cookie is required on every `/api/*` request; the login header and `Origin` are extra checks, never proof on their own; pairing still needs the live code and the owner's approval | A local process that can read the browser's cookie store already owns the user's account |
| T29 | Other tailnet members, or people the node is shared with, reach the serve address | They need a pairing code and the owner's approval; the approval shows their Tailscale login; the Remote page says that everyone on the tailnet can reach the address and links to Tailscale's access rules | A member who shoulder-surfs a code still has to get past the owner's approval |
| T30 | Accidental Funnel exposes the gateway to the internet | Bitbots never runs `tailscale funnel`; it checks Funnel is off for its port at start and on each status refresh, and stops serving if Funnel appears | The owner turns Funnel on by hand between checks; the cookie and `Origin` checks still apply |
| T31 | Bitbots clobbers the user's own `tailscale serve` setup | Never `serve reset`; add and remove only our own handler; fall back from 443 to 8443 when 443 is taken; refuse rather than overwrite | Tailscale CLI changes; covered by tests that assert the exact commands issued |
| T32 | Cookie theft (malware, a shared browser profile, a backup of browser data) | `HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-` prefix; only its SHA-256 is stored; login check when the header is present; one live socket per device; idle expiry; one-click revoke | A stolen cookie used from another node with no login header, until revoked |
| T33 | The owner's Tailscale account is taken over | An attacker can add nodes, but still needs a pairing code and the owner's approval on the desktop; existing cookies stay bound to their recorded login; the Remote page recommends two-factor sign-in for Tailscale | An attacker who also controls a paired device acts at its tier |

## 11. Checklist additions for P1

- [ ] The gateway applies `authorizeRemoteCall`, `redactResultForRemote` and the event allowlist
      (Rust ports, same `tiers.json`); a test proves no code path returns raw daemon output to a
      device.
- [ ] Pairing offer locked by the first correct code; later submissions refused; owner approval
      implemented.
- [ ] Cookie attributes, the `Origin`/`Sec-Fetch-Site` check and the Tailscale-login check tested,
      including a browser-like `GET` with no `Origin`, a cross-site `GET`/`POST` refused, and a
      request with a forged login header and no cookie.
- [ ] Tests prove the gateway never issues `tailscale serve reset` or `tailscale funnel`, and
      that it refuses to start when Funnel is on.
- [ ] The listener binds `127.0.0.1` only (test).
- [ ] Static server rejects paths outside its manifest, including traversal.
- [ ] PWA content security policy written and tested.
- [ ] One live event socket per device enforced.
- [ ] Activity entry templates covered by a test.
- [ ] Tailscale status JSON never logged.

## 12. Native (Direct) threats: a port on the public internet (17 October 2026)

Native is the second Remote method ([AGENTS.md](../../AGENTS.md), amendment of 17 October 2026,
later). While it is on, the gateway's own listener binds the host's interfaces on
`remote.nativePort` (default 48621), serves HTTPS only with a certificate Bitbots generates, and
may be reachable from the whole internet once the owner forwards the port (by hand or through
UPnP with consent). Everything in §4–§11 still applies; this section covers what is new. Facts
below come from the lane reports ([FIX35_C1](../FIX35_C1_REPORT.md), [FIX35_C2](../FIX35_C2_REPORT.md))
and the Director's review; none of it has been tested against a live router, a real phone on
mobile data or an outside attacker.

| # | Abuse | Mitigation | Residual risk |
|---|---|---|---|
| N1 | Password guessing from the internet | Argon2id hash only; a wrong username still runs one verify against a dummy hash (no timing oracle); 5 failures per source in 15 min → that source gets `429` for 15 min; 30 failures across all sources in 1 h → every sign-in pauses for 30 min and the desktop shows it; a content-free activity line when a limit starts (not one per guess, so the 500-row log cannot be flooded) | A slow, distributed guesser below the global limit against a weak password. The UI requires 12+ characters, not the username |
| N2 | A correct password from a stranger's device | A new device still needs the owner's approval on the desktop, with the tier picked there (Chat preselected); approvals from remote stay off by default | An owner who approves without reading the request |
| N3 | Flooding unauthenticated routes (`/api/login`, `/api/pair`, `/api/ping`, static files) | Per-source token bucket, 30 requests / 10 s with burst 60, before any work | A botnet spread across many addresses; the daemon is not a hardened public web server |
| N4 | Man in the middle on first contact | TLS is mandatory (plain HTTP refused); the browser warns once because the certificate is self-made, and Settings › Remote shows the SHA-256 fingerprint to compare | An owner who clicks through the warning without comparing the fingerprint on a hostile network |
| N5 | Theft of the TLS key | The key lives in the data folder with user-only access (`icacls /inheritance:r /grant:r <user>:F` on Windows, mode 0600 elsewhere); "New certificate" replaces it and changes the fingerprint | Malware running as the user can read it, and the cookie store too |
| N6 | Cross-site use of a device cookie, or a hostile name pointed at the host (DNS rebinding) | `Origin` (when sent; a safe `GET` may omit it) and `Host` must name the certificate's own addresses; a Tailscale origin is refused under Native and the reverse; cookies keep `Secure`, `HttpOnly`, `SameSite=Strict` | None known beyond §9 |
| N7 | UPnP opens more than Bitbots asked for, or leaves a mapping behind | Only with the owner's consent; maps only `remote.nativePort` over TCP; removed on disable and at daemon shutdown; the lease is renewed while on | A crash between mapping and removal leaves the forward until the lease ends; a router with a broken UPnP stack |
| N8 | Firewall changes without the owner knowing | One inbound rule, `Bitbots-Remote`, for the Native port only, added and removed only through an elevated prompt the owner accepts; no console window | The owner widens the rule by hand |
| N9 | Bitbots contacting third parties (IP echo, relays, DNS) | None: the external address comes from the router (UPnP) or the owner; carrier-NAT and private addresses are detected locally; the self-test is the owner opening `/api/ping` from a phone | — |
| N10 | `/api/ping` as a probe | Answers only a fixed, content-free marker, `{"ok":true,"app":"bitbots","role":"remote-gateway"}` (FIX39 P3; nothing about the host, owner or account); records "reached from" as a public address or "this network"; rate-limited like other unauthenticated routes | Anyone who can reach the port learns that something answers there, which the sign-in page shows anyway |
| N11 | A signed-out device learns which method is on | `/api/me` refusals name `native` or `tailscale` and nothing else (no host name, no device data) | The method is visible from the address anyway |
| N12 | Test runs open firewall prompts or bind the internet | Under `#[cfg(test)]` the listener binds `127.0.0.1` only; no test runs real `netsh`, PowerShell or UPnP discovery | — |

## 13. Checklist additions for Native (owed before a non-beta release)

Implementer-tested means the lane's own unit tests, re-run by the Director on `main`; nothing
here is independently reviewed yet.

- [x] Native refuses plain HTTP; a non-TLS client gets nothing usable (implementer-tested).
- [x] Argon2id verify with a dummy hash for unknown usernames; uniform `login_invalid` (implementer-tested).
- [x] Per-source lockout and global pause, with one activity line each (implementer-tested).
- [x] `Origin`/`Host` checks per method (implementer-tested).
- [x] UPnP mapping removed on disable and shutdown, against a fake gateway (implementer-tested).
- [x] Firewall add/remove argv asserted against fakes; one rule name, one prompt (implementer-tested).
- [x] Tests bind loopback only (implementer-tested; the owner's firewall prompts stopping is not yet observed).
- [ ] An independent review of the TLS listener, sign-in, lockouts and `Origin`/`Host` handling.
- [ ] A live test from a phone on mobile data: port forward, certificate warning and fingerprint check, sign-in, approval.
- [ ] A live UPnP test on a real router, including that the mapping is gone after Remote turns off.
- [ ] A check that the key file's permissions are applied on a real Windows install.

## 14. FIX39 changes (18 October 2026)

Implementer-tested means the package's own unit, mounted and fake-process tests. Nothing in this section is independently reviewed, and nothing was exercised on a real tailnet, router or phone.

### 14.1 Remote

- **Origin: no change.** The FIX39 packages did not alter the `Origin` rule in [PROTOCOL.md](PROTOCOL.md) §4.1. The rule that safe reads may omit `Origin` comes from FIX38 and still stands.
- **Tool steps (P2).** Over Remote, a tool step's `title` is replaced by a generic "Tool" unless the device is allowed tool output. `label`, `pattern`, `url`, `path` and `command` are withheld by default. Titles such as "Ran cargo test C:/…" can carry paths and command text. The shared policy goldens prove this in both Rust and TypeScript.
- **Ping marker (P3).** `GET /api/ping` answers a fixed marker that names the app and its role and nothing else. It lets one Bitbots copy recognise another on the same port.
- **Remote discard of a task branch (P10, finding 6, not yet reviewed).** `proposal.decide` with `discard: true` on a `merge` proposal removes a task's copy and branch. The operator tier may call `proposal.decide` when approvals from remote are on, so a paired operator device can discard a task branch. The discard is bounded to that repository's own `<repo>-bitbots` copy and `bitbots/*` branch, and it is refused while the task is still working. Whether a phone should be able to discard at all is an owner decision.
- **One copy only (P3).** A second copy of Bitbots that already serves Remote is refused, not shared. The daemon exits when its app exits (a parent watchdog), so a stale process cannot keep a port. Single-instance focus was not exercised live.
- **Wide layout (P3).** The wide browser layout is a presentation change. It does not change what any device may call.

### 14.2 Local diagnostics (P12)

The export is local. It is written only after the owner picks a path in the native save dialog. Nothing is uploaded. No paired device can call `diagnostics.preview` or `diagnostics.export`; both are `never` remote.

**The logs never contain:** message, prompt, reply, streamed or thinking text; recap or summary text; command text or output; file contents or diffs; credentials, tokens, passwords, cookies (including Remote cookies), capability values or provider sign-in data; environment values; or Tailscale status JSON.

**The logs do contain:** IDs, error classes, provider names, versions, timings and exit codes. The daemon and the shell both write through a central redacting writer. A test scans every log call site and fails if one logs a field named text, prompt, content, message, command, secret, token, cookie, password or credential. Logs are daily files, 14 kept, at most about 20 MB in total.

**The export zip contains:**
- `README.txt`, saying what is inside;
- `environment.json`: app and protocol versions, OS, architecture and OS version, coding-agent names and versions. No executable paths;
- `settings.json`: secrets removed; `profile.about` and every `internal.*` key omitted;
- `events.json`: the last 200 app events, through an allowlist of identifiers, states, error classes, providers, versions, timings, counters and flags. Questions, titles, inputs, content and paths are dropped;
- the recent log files, redacted again on the way in.

**Known limits.** Redaction is pattern-based, so a secret in an unusual shape could pass it. `remote.native.account.username` is kept, as a label that says which account is configured. The zip is not encrypted, and sending it anywhere is the owner's decision.
