# Remote mode: threat model

**Status: design.** Written 15 October 2026. Scope: the gateway, the relay, paired devices and
the pairing flow. Out of scope: the coding agents' own sandboxing and provider accounts.

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
| Provider credentials (Claude, Codex, OpenCode auth files) | Read by the daemon locally; must never reach a device or relay. |
| The daemon capability token | Full authority over the loopback API. |
| Device and host keys | Prove identity. |
| Approvals | The brake on unattended action. |

## 3. Actors

- **Owner** on the host and on paired devices.
- **Thief or finder** of a paired, unlocked device.
- **Network attacker** between device, relay and host.
- **Relay operator** (Bitbots, or a self-hosted operator).
- **Other local user or process** on the host.
- **Malicious web page** the owner visits in the same browser as the PWA.
- **Compromised provider output** (prompt injection in a repository or web page the agent reads).

## 4. Trust boundaries

1. Device <-> relay: untrusted network, TLS plus end-to-end Noise.
2. Relay <-> host: same.
3. Gateway <-> daemon dispatch: in-process, trusted.
4. Daemon <-> coding agents: existing boundary, unchanged.
5. Host <-> other local processes: the loopback API stays capability-protected; remote adds
   no new local listener unless the direct address is on.

## 5. Abuse cases and mitigations

| # | Abuse | Mitigation | Residual risk |
|---|---|---|---|
| T1 | Stolen unlocked phone sends prompts | Device removable from the host at once; default tier Chat (no approvals); quiet hours; idle expiry; activity list shows every prompt source | Until removed, the thief can send prompts that run within the approval mode. Document it; recommend "Ask first" mode. |
| T2 | Attacker approves a command from a stolen phone | Approvals from remote are **off by default** and a per-device tier; operator tier only appears when the global switch is on | If the owner enables it and loses the phone, approvals are possible until removal. |
| T3 | Relay reads or alters traffic | Noise end-to-end; relay sees ids and sizes only; pairing prologue binds the one-time secret so keys cannot be swapped | Traffic analysis (timing, sizes). |
| T4 | Pairing code guessed or shoulder-surfed | 8 characters from a 32-symbol alphabet, single use, 5-minute life, rate-limited attempts per host, QR shown only on the host screen | A watcher who reads the code within five minutes and is on the relay can pair; the host shows "Pixel 8 connected" at once and the owner can remove it. |
| T5 | Remote client calls a dangerous method (settings, runtime profile, file revert) | Server-side tier table; never-remote methods denied regardless of tier; parity test fails the build when a daemon method has no rule | A bug in the table; mitigated by the parity test and review. |
| T6 | Snapshot leaks secrets (env values, instructions, absolute paths) | `redactSnapshotForRemote` strips env values and instruction text, shortens paths, drops keys named like secrets | New fields added later; the redaction test uses an allowlist-minded fixture and must be extended with each new snapshot field. |
| T7 | Attachment used to read arbitrary files | Remote prompts accept only `stagedId` from the gateway upload, never `path`; same size and magic-byte checks as today | Image parsing bugs. |
| T8 | Device key theft from a browser | Non-extractable WebCrypto key; PWA origin isolation | Malware on the device. |
| T9 | Malicious web page drives the PWA | PWA origin has its own storage; no cookies carry authority; every request is inside the Noise session; CSP with `connect-src` limited to the relay and `self` | Browser vulnerabilities. |
| T10 | Replay of recorded frames | Noise nonces; sessions are per connection | None expected. |
| T11 | Denial of service on the host through the relay | Gateway rate limits per device; max frame 256 KiB; max concurrent sessions; relay drops abusive ids | A determined flood still costs bandwidth. |
| T12 | Prompt injection makes a bot exfiltrate through Remote | Remote adds no new tool or egress; the bot's capabilities and approval mode are unchanged | Existing agent risk, unchanged. |
| T13 | Another local user connects to the direct address | Direct listener requires the same handshake and device keys; off by default; warning copy | Anyone on the network can attempt handshakes. |
| T14 | Audit log leaks content | Entries are one short templated sentence, never message text, paths or command lines | Template mistakes; covered by a unit test on every entry kind. |
| T15 | Host left running a remote session while the owner thinks it is off | One master switch; status chip in the sidebar and tray; off disconnects everything at once | None expected. |

## 6. Defaults that carry the model

1. Remote is off.
2. New devices are **Chat**, not **Chat and approve**.
3. Approvals from remote are off globally.
4. Idle devices expire in 30 days.
5. Direct address is off.
6. No message text in logs, push payloads or the activity list.

## 7. Not mitigated by design

- A compromised host computer. Remote adds nothing here.
- A user who turns approvals from remote on, sets bypass mode and loses a phone. The product
  warns, and bypass mode is already a typed-confirmation setting.
- Data the user chooses to paste into a chat.

## 8. Review checklist before P1 ships

- [ ] Every daemon method has a tier rule (parity test green).
- [ ] The gateway calls internal dispatch only; the capability token never appears in a
      frame, log or error.
- [ ] Snapshot and event redaction covered by tests with the real field set.
- [ ] Rate limits and size limits tested.
- [ ] Pairing code attempts limited per host and per relay id.
- [ ] Activity entries tested for content-free templates.
- [ ] Independent review of the Noise integration and key storage.
