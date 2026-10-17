# FIX35 C2 — Native Remote connectivity: UPnP mapping, firewall, external IP, CGNAT, self-test

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, worktree `C:\fx56`.
Builds on C1 (`crates/bloblex-daemon/src/remote/native.rs`, `docs/FIX35_C1_REPORT.md`).
Spec: `docs/FIX35_C2_CONNECTIVITY_SPEC.md`. **No `git commit` was run.**

## What was built

Native Remote binds the host's own interfaces, so a device outside the network
reaches it only when three things line up: the router forwards the port, the
Windows firewall allows it, and the shared address is not behind carrier NAT.
This change learns and reports each of them, without any third-party service.

- **UPnP / IGD port mapping** (`remote/connectivity.rs`, new). Behind the owner's
  consent (`remote.native.upnp`, default false) it searches the gateway (5 s
  timeout), adds a TCP mapping external `<port>` → this host's LAN IPv4 `<port>`
  with description `Bitbots Remote` and a 3600 s lease, renews the lease every
  30 minutes, and removes **only its own** mapping on disable or daemon
  shutdown. A missing gateway or a refused mapping becomes a status, never fatal.
- **External IP and CGNAT.** The external IP comes only from UPnP
  (`get_external_ip`) or a value the owner types (`remote.native.externalIp.set`).
  No IP-echo website is contacted. The address is classified for carrier NAT /
  private / link-local / IPv6 ULA and the status explains it. Re-read every 10
  minutes while Native is on; a change updates `native.urls`, regenerates the
  certificate when the new IP is not in the SANs, and emits `remote.changed`.
- **Windows Firewall.** Inbound-rule detection via
  `netsh advfirewall firewall show rule name="Bitbots Remote"` (5 s timeout, no
  shell, parsed). `remote.native.firewall.add` / `.remove` raise an **elevated**
  `netsh` through `powershell Start-Process -Verb RunAs -Wait` (the owner sees
  UAC) and report `added | removed | declined | failed`, or `unsupported` off
  Windows.
- **Self-test `GET /api/ping`.** Unauthenticated, shares C1's per-source abuse
  bucket, returns `{"ok": true}` and records `lastReachedAt` / `lastReachedFrom`
  (a public peer address, else the phrase `this network`) and emits
  `remote.changed`. This is what the desktop shows as "Reached from …".
- **Status.** `remote.status.native` gains `upnp`, `firewall`, `externalIp`,
  `externalIpSource`, `cgnat` and `cgnatReason` (see shapes below).

### Director's review additions (both confirmed present)

- **(a)** The external IP is stored under the setting key
  `remote.native.externalIp`, whether it comes from UPnP or is set by hand.
  `connectivity::apply_external_ip` writes `native::EXTERNAL_IP_SETTING`
  (`connectivity.rs:404-406`); `native::EXTERNAL_IP_SETTING ==
  "remote.native.externalIp"` (`native.rs:53`), which is the key C1's certificate
  regeneration reads. Test: `native_manual_external_ip_uses_the_key_the_certificate_reads`.
- **(b)** Failed sign-ins write an activity line only when a lockout or the global
  pause **starts** (one line each) (`web.rs:483-496`). Tests:
  `native_failed_sign_ins_write_a_denied_line_only_when_a_limit_starts` and
  `native_global_pause_writes_one_denied_line`.

## Files

- `crates/bloblex-daemon/src/remote/connectivity.rs` (new) — mapping lifecycle,
  external IP, CGNAT classification, firewall detection/argv, test seams.
- `crates/bloblex-daemon/src/remote/native.rs` — `EXTERNAL_IP_SETTING`, the
  `ConnectivityState` inside `NativeState`, the C2 fields in `status_block`,
  `enable`/`disable` call into connectivity.
- `crates/bloblex-daemon/src/remote/web.rs` — the open `/api/ping` route, the
  ping handler, `reached_from`, the shared abuse bucket including `/api/ping`,
  and the start-only denied activity lines.
- `crates/bloblex-daemon/src/remote/mod.rs` — `remote.*` dispatch for the four
  new RPCs, `discover_gateway` (seam), `TestSeams`, disable calls
  `connectivity::disable`.
- `crates/bloblex-daemon/src/main.rs` — the four new methods listed in main's
  `remote.*` arm.
- `crates/bloblex-daemon/src/remote/tests.rs` — the Rust tests below.
- `apps/desktop/src/remote/tiers.json` — the four new RPCs, each `never`.
- `apps/desktop/src/remote/remoteContract.ts` — the four methods and the C2
  status fields/types (`RemoteNativeUpnp`, `RemoteNativeFirewallState`,
  `RemoteNativeExternalSource`).
- `apps/desktop/src/preview/remoteFixture.ts` — the four new methods and the C2
  status fields in the preview simulator.

## Dependencies added

- `igd-next = { version = "0.18", default-features = false, features = ["aio_tokio"] }`
  (workspace), used by `bloblex-daemon` for UPnP/IGD. `if-addrs` (already a C1
  dependency) enumerates the host's LAN IPv4. `async-trait` (already present) is
  used for the `UpnpGateway` trait.

## RPCs and status shapes as implemented

All four RPCs are host-only (`never` remote), reached only through the desktop's
loopback API.

| Method | Params | Result |
| --- | --- | --- |
| `remote.native.upnp.set` | `{ "enabled": true \| false }` | the `native` status block |
| `remote.native.externalIp.set` | `{ "ip": "203.0.113.55" \| null }` | the `native` status block |
| `remote.native.firewall.add` | `{}` | `{ "result": "added" \| "declined" \| "failed" \| "unsupported" }` |
| `remote.native.firewall.remove` | `{}` | `{ "result": "removed" \| "declined" \| "failed" \| "unsupported" }` |

Invalid input (a non-boolean `enabled`, an unparseable `ip`) is rejected with
`invalid_argument` and writes nothing.

`remote.status.native` (C1 fields plus C2):

```jsonc
{
  "port": 48621,
  "urls": ["https://host-name:48621", "https://localhost:48621", "https://203.0.113.55:48621"],
  "fingerprint": "AB:CD:…",          // null before the certificate exists
  "accountSet": true,
  "username": "owner",
  "listening": true,
  "loginPaused": false,
  "pausedUntil": null,
  "lastReachedAt": "2026-10-17T21:00:00Z",  // set by /api/ping or a sign-in
  "lastReachedFrom": "203.0.113.9",          // a public peer, else "this network"
  "upnp": { "consent": true, "state": "mapped" },   // "off" | "mapped" | "no_gateway" | "failed"; "error" when failed
  "firewall": "allowed",             // "allowed" | "missing" | "unsupported" | "unknown"
  "externalIp": "203.0.113.55",      // null until UPnP or the owner supplies one
  "externalIpSource": "upnp",        // "upnp" | "manual" | null
  "cgnat": false,
  "cgnatReason": null                // "carrier_nat" | "private" when cgnat is true
}
```

`GET /api/ping` returns `{ "ok": true }` and nothing else. It is merged after the
origin layer so a phone's address bar (no `Origin`) can reach it, and it is
counted by C1's unauthenticated bucket.

## The exact argv used

Detection (no shell, parsed; 5 s timeout), from the recorded-output test:

```
netsh advfirewall firewall show rule name=Bitbots Remote
```

Add (elevated, the owner sees UAC), argv[0..5] as launched:

```
powershell -NoProfile -NonInteractive -Command "Start-Process -FilePath netsh -Verb RunAs -Wait -ArgumentList @('advfirewall','firewall','add','rule','name=Bitbots Remote','dir=in','action=allow','protocol=TCP','localport=48621')"
```

Remove (elevated):

```
powershell -NoProfile -NonInteractive -Command "Start-Process -FilePath netsh -Verb RunAs -Wait -ArgumentList @('advfirewall','firewall','delete','rule','name=Bitbots Remote')"
```

The inner `netsh` argument vector is built by `add_rule_args(port)` /
`remove_rule_args()`; `elevated_command` quotes each argument (doubling `'`), so
the firewall rule name and port cannot break out of the PowerShell list.

## Tests

Rust (`crates/bloblex-daemon/src/remote/tests.rs`), fakes only — no real router,
firewall or network:

- `native_cgnat_classification_matches_the_spec` — 100.64.0.1 and
  100.127.255.255 → `carrier_nat`; 10.x, 192.168.x, 172.16.x, 172.31.x,
  169.254.x, `fd00::1`, `fc00::1`, `fe80::1` → `private`; public IPv4 and
  `2606:4700:4700::1111` → not CGNAT; `None` → not CGNAT.
- `native_firewall_parses_recorded_output_and_builds_the_exact_argv` — recorded
  "No rules match" and "LocalPort: 48621" texts; a rule for a different port is
  `missing`; non-Windows → `unsupported`; no output → `unknown`; the add/remove
  elevated argv strings above.
- `native_ping_reports_a_public_peer_but_not_a_private_one` — `8.8.8.8:51234` →
  the address; loopback / 192.168 / 10.x / link-local → `this network`.
- `native_upnp_maps_only_with_consent_and_removes_its_own_mapping` — no mapping
  without consent and `upnp.state == "off"`; consent stores and maps at once
  (one mapping, correct external port, LAN port, lease and description); status
  reads `mapped`, `externalIpSource == "upnp"`; renewal re-adds the same mapping;
  withdrawing consent removes exactly that mapping.
- `native_upnp_reports_no_gateway_and_a_failed_mapping` — no gateway →
  `no_gateway`; a gateway that refuses the mapping → `failed` with an `error`.
- `native_external_ip_change_updates_the_urls_and_the_certificate` — a new
  router address updates `externalIp`, regenerates the certificate (the
  fingerprint changes), updates `urls`, and emits `remote.changed` carrying the
  new address.
- `native_manual_external_ip_uses_the_key_the_certificate_reads` — a typed
  address is saved under `remote.native.externalIp`, marks the source `manual`,
  regenerates the SANs; a private value is flagged (`cgnat`, reason `private`)
  not rejected; `null` clears it; bad input → `invalid_argument`.
- `native_ping_is_open_and_records_where_it_came_from` — `GET /api/ping` with no
  `Origin` returns `{"ok":true}`, records `lastReachedFrom == "this network"`,
  sets `lastReachedAt`, and emits `remote.changed`.
- `native_ping_shares_the_unauthenticated_rate_limit` — repeated pings are
  eventually `429` from C1's bucket.
- `native_failed_sign_ins_write_a_denied_line_only_when_a_limit_starts` (review
  addition b) — four failures write nothing; the fifth (lockout) writes exactly
  one `denied` line; a request refused by a running lockout writes nothing.
- `native_global_pause_writes_one_denied_line` (review addition b) — 29 seeded
  failures write nothing; the thirtieth (global pause) writes exactly one line.

TypeScript: the four methods join `REMOTE_METHODS` in `remoteContract.ts` and are
exercised by `remoteFixture.test.ts`'s "answers every method the contract lists";
the tier-parity test covers the four new `never` rows in `tiers.json`.

## Gates

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast`
  — every `test result: ok`, 0 failed; `bloblex-daemon` 326 passed.
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — clean.
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote src/preview` —
  `tsc` clean; vitest 207 passed (13 files).

## Deviations and honest gaps

- **The desktop side is non-visual only.** `remoteContract.ts` and
  `remoteFixture.ts` were extended; no UI was touched (`apps/desktop/src/ui/**`
  is the Director's lane). The desktop tests cover the new methods generically
  through the contract loop, not with dedicated C2 assertions.
- **`remote.native.upnp.set` returns the `native` status block**, not a bare
  `{ok:true}`, matching how the other `native.*` RPCs report.
- **The firewall removal deletes the rule by name** (`delete rule name=Bitbots
  Remote`), which is the spec's "likewise for disable".
- **The firewall `add`/`remove` outcome** is decided by re-reading the rule after
  the elevated command and by the process exit code: an accepted prompt that then
  fails is `failed`; a refused UAC prompt is `declined`.

## Unverified

- **No real router.** Every UPnP test uses the fake `UpnpGateway`. `igd-next`
  discovery, `add_port` / `remove_port` / `get_external_ip` against a real IGD,
  a real lease renewal, and a router that ignores UPnP were not exercised.
- **No real UAC.** The elevated `netsh` path is asserted by argv only. A real
  UAC prompt, an accepted prompt, a declined prompt, and a machine whose firewall
  policy blocks the change were not run; the `declined`/`failed`/`added`
  reporting is unverified end to end.
- **No real mobile network.** `/api/ping` records a public peer address from the
  connection only; no phone on mobile data was used, so `lastReachedFrom`
  showing a real public address, and the reachability of the address behind a
  real carrier NAT, are unverified. CGNAT detection is verified against recorded
  addresses, not a live carrier.
- **Real certificates and real browsers** (the one-time self-signed warning, the
  fingerprint check) remain unverified, as recorded in the C1 report.
- The threat-model review of the public-internet surface (mandatory before a
  non-beta release) is still owed.

## Follow-up (FIX35 C3 follow-up)

Two review findings, both addressed. Lane `opencode-go/deepseek-v4.1-flash`,
worktree `C:\fx56`. **No `git commit` was run.**

### 1. The firewall rule name (the review finding)

`Start-Process -ArgumentList @(...)` joins its elements with spaces **without
quoting**, so the old rule name `Bitbots Remote` reached `netsh` as two words and
the add/delete failed or targeted the wrong rule. The rule is now named
`Bitbots-Remote` (no space) in `FIREWALL_RULE_NAME`
(`connectivity.rs:46`), which is what the show, add and delete commands all use.

The corrected argv (only the rule name changed):

```
netsh advfirewall firewall show rule name=Bitbots-Remote

powershell -NoProfile -NonInteractive -Command "Start-Process -FilePath netsh -Verb RunAs -Wait -ArgumentList @('advfirewall','firewall','add','rule','name=Bitbots-Remote','dir=in','action=allow','protocol=TCP','localport=48621')"

powershell -NoProfile -NonInteractive -Command "Start-Process -FilePath netsh -Verb RunAs -Wait -ArgumentList @('advfirewall','firewall','delete','rule','name=Bitbots-Remote')"
```

- The old name is still **read** as a rule for the port (detection parses by
  `LocalPort`, not the name), and `remote.native.firewall.remove` now deletes the
  current rule and then the old name, so an upgraded install cleans up:
  `FIREWALL_RULE_NAMES_TO_DELETE = ["Bitbots-Remote", "Bitbots Remote"]`
  (`connectivity.rs:631`). A name with no rule is not an error — the outcome is
  read from the status afterwards, so a missing legacy rule still reports
  `removed`.
- Because the argument list is joined without quoting, the delete argument for the
  old name keeps its space by being wrapped in double quotes:
  `... delete rule name="Bitbots Remote"`. `remove_rule_args(name)`
  (`connectivity.rs:617`) quotes a name only when it contains a space; the current
  name is passed unquoted. `show_rule_args(name)` / `add_rule_args(port)` build
  the other two commands.
- The delete raises the elevated prompt once per name. On a fresh install the
  second (legacy) prompt only runs to discover the rule is absent; that extra
  prompt is a deliberate, documented cost, not hidden.

Tests (`native_firewall_parses_recorded_output_and_builds_the_exact_argv`): the
recorded `Rule Name` is now `Bitbots-Remote`; the old name is also parsed as
`allowed`; the show/add/delete argv strings above and the legacy delete string are
asserted, plus the delete-names list.

### 2. The phone client's Native sign-in (non-visual TypeScript)

`POST /api/login` (`web.rs:452`) is a route of the phone client, so its call was
added to the client, matching the daemon's shape.

- `remoteTransport.ts`: `RemoteErrorCode` gains `login_invalid` (with a default
  message); `RemoteLoginInput` is `{ username, password, name, kind, platform }`;
  `RemoteTransport.login(input)` posts `/api/login` with `credentials:
  'same-origin'` and the same envelope handling as `pair`, returning
  `{ state }` (`RemotePairState`). A `401` carrying `login_invalid` stays
  `login_invalid` (the envelope code passes through); a bare `429` becomes
  `rate_limited` via `codeForStatus`.
- **No sign-out on a sign-in failure.** `/api/login` is added to `pair` as a
  cookie-free route (`isCookieFreeRoute`), so a `401` there never flips the
  transport to `signed_out` (and signing in after a sign-out is still allowed).
- `deviceApi.ts`: `RemoteDeviceApi.login(input)`. `createPreviewDeviceApi`
  accepts any username with the passphrase `preview-passphrase`
  (`PREVIEW_PASSPHRASE`), otherwise throws `login_invalid`; on success it behaves
  like `pair` (pending, then approved after the wait). It gains a
  `method?: 'tailscale' | 'native'` option (default `tailscale`) that `me()`
  returns.
- `remoteTauri.ts`: `remoteDevice.login` → `transport().login(input)`.

Tests: `remoteTransport` Native sign-in — 200 `approved` (posts the exact body to
`/api/login`, same-origin), 202 `pending`, 401 `login_invalid` with no sign-out,
429 `rate_limited`; `deviceApi` preview — any username with the passphrase is
approved, another password is `login_invalid`, and the `method` option is
reported by `me()`.

### Gates

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop
  --no-fail-fast` — every `test result: ok`, 0 failed; `bloblex-daemon` 326
  passed.
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — clean.
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote src/preview` —
  `tsc` clean; vitest 214 passed (13 files), up from 207.

### Unverified

- **The legacy-name delete is asserted by argv only.** No real `netsh`/UAC run
  proves the quoted `name="Bitbots Remote"` reaches `netsh` as one word, and no
  upgraded machine was checked to confirm the old rule is gone. As in C2, the
  elevated path is otherwise unverified end to end.
- **The sign-in path is not exercised against the daemon.** Only the transport
  and the preview fake are tested; a real phone signing in to a real host, the
  lockout/`rate_limited` transition and the pending→approved flow over the wire
  remain unverified, as recorded for pairing in the Remote amendment.

## Follow-up (FIX35 C4): tests must not bind all interfaces

The owner kept seeing the Windows Firewall "Allow access?" prompt while the lane
ran tests: the Native Remote tests turned Native on and
`crates/bloblex-daemon/src/remote/native.rs` bound `0.0.0.0` (and `[::]`), once
per newly built test executable. **No `git commit` was run.**

- **The bind host is now state, not a literal.** `native::BindHosts { v4, v6 }`
  lives in `native::NativeState.bind`; `bind_listeners` reads it instead of
  hard-coding `("0.0.0.0", port)` and `("::", port)`.
- **Production is unchanged.** `BindHosts::production()` (and the non-test
  `Default`) yields `v4 = PRODUCTION_BIND_V4 = "0.0.0.0"` and
  `v6 = Some(PRODUCTION_BIND_V6) = Some("::")`, so a real daemon still binds
  every interface exactly as before.
- **Tests bind loopback only.** Under `#[cfg(test)]`, `BindHosts::default()`
  yields `v4 = "127.0.0.1"` and `v6 = None` (the IPv6 wildcard is skipped), which
  is what `RemoteState::with_cli` puts in every test state. No test binary opens
  a socket on the host's interfaces.
- **One test reads the production default without binding.**
  `the_native_bind_host_is_every_interface_in_production_and_loopback_under_test`
  asserts the constants and `BindHosts::production()` are `0.0.0.0` / `::`, and
  that the test `Default` is `127.0.0.1` / `None`; it opens no socket.
- **The Host-vs-certificate test now dials loopback.** `NativeGateway::post`
  connects to `127.0.0.1` and sends the chosen name as the `Host` header (which
  is what the authority check reads), so the out-of-certificate case no longer
  depends on connecting to `127.0.0.2`.
- **Grep of every test.** No test in the workspace binds `0.0.0.0`, `[::]`,
  `::` or the like; only `native.rs` production code names the wildcard.
- **No test runs real `netsh`, `powershell` or UPnP discovery.** The C2 seams
  (`RemoteState::seams`, `key_commands`) still stand: the firewall argv and the
  UPnP lifecycle are asserted against fakes only.

### Gates

- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop
  --no-fail-fast` — every `test result: ok`, 0 failed; `bloblex-daemon` 326
  passed (327 with the new test).
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — clean.

### Unverified

- **The Firewall prompt is only expected, not observed gone.** Suppressing it
  rests on tests now binding loopback; no run on the owner's machine confirmed
  the per-binary prompt stopped.
- **The production bind is read from the default, not exercised.** No production
  daemon was started to watch it bind `0.0.0.0`/`[::]`; a test only proves the
  non-test `Default` value.


## C5 — no console flashes, one UAC prompt

- **Console windows.** `run_with_timeout` (the `netsh ... show rule` reading) and
  `run_process` (the `powershell` that raises UAC) now set `creation_flags(0x0800_0000)`
  (`CREATE_NO_WINDOW`) on Windows, as `remote/tailscale.rs` does, so the windowless
  daemon no longer pops a console. `elevated_command` adds `-WindowStyle Hidden` to
  its `Start-Process` line so the elevated `netsh` does not flash a console; the UAC
  prompt itself still shows.
- **One UAC prompt on remove.** `LEGACY_FIREWALL_RULE_NAME` ("Bitbots Remote", with a
  space) never shipped — it existed only in this unmerged worktree — so
  `FIREWALL_RULE_NAMES_TO_DELETE` and the quoting branch in `remove_rule_args` are
  gone. `remove_rule` now runs one elevated delete of `Bitbots-Remote`. Detection is
  unchanged: it reads `LocalPort`, so an old rule name would still be seen.
- **Gates.** `cargo test -p bloblex-daemon` (327 + 1 passed, 0 failed) and
  `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` both pass.

## C6 — a signed-out phone learns the method

The phone must show the Native sign-in screen or the Tailscale pairing-code
screen **before** it is signed in, but `GET /api/me` answered a signed-out device
with an error that carried no method. The refusal now names it. Lane
`opencode-go/deepseek-v4.1-flash`, worktree `C:\fx56`. **No `git commit` was run.**

- **`web.rs`.** `authenticate` takes `include_method`; only `me_get` passes
  `true`. A `refuse` helper builds the same `unauthorized` / `device_revoked`
  envelope as before and, for `/api/me`, adds a top-level `"method"` field
  (the active method, `native` or `tailscale`) beside `error`. Nothing else is
  added — no host name and no device data — and the other authenticated routes
  (`/api/rpc`, `/api/events`, `/api/logout`, the held-cookie check in
  `/api/login`) are unchanged.
- **`remoteTransport.ts`.** `RemoteCallError` gains an optional
  `readonly method?: RemoteMethodId`; `readEnvelope` fills it from the envelope
  when the body carries a known method, so a refused `me()` reports the host's
  method.
- **`deviceApi.ts`.** The preview's `me()` refusal carries the preview's
  `method` option, matching the daemon's shape.

### Tests

- Rust `a_refused_me_names_the_active_method_and_nothing_else` — a cookie-less
  `GET /api/me` is 401 with `method == "tailscale"` on the default gateway and
  `method == "native"` on the Native gateway, and carries no `host` or `device`.
- `remoteTransport.test.ts` — a refused `/api/me` whose body has
  `method: "native"` throws a `RemoteCallError` with `code`, `status` and
  `method`; a refusal without one leaves `method` undefined.
- `deviceApi.test.ts` — the preview `me()` refusal carries `method: "native"`
  when that option is set.

### Gates

- `RUST_MIN_STACK=33554432 cargo test -p bloblex-daemon --no-fail-fast` —
  every `test result: ok`, 0 failed; `bloblex-daemon` 328 passed (327 + 1).
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings` — clean.
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote` — `tsc` clean;
  vitest 194 passed (11 files).

### Unverified

- **Against a real host and phone:** the daemon's `method` field is asserted in
  Rust and the client's reading of it in TypeScript, but no real phone on a real
  Native or Tailscale host was used to confirm the correct sign-in screen is
  chosen, as recorded for the whole sign-in path in C2/C3.
