# FIX35 C2: Native Remote connectivity — UPnP, firewall, CGNAT, external IP, self-test

Lane: OpenCode `opencode-go/deepseek-v4.1-flash`, high effort, own worktree, private `CARGO_TARGET_DIR`. **Do not run `git commit`.** Builds on C1 (`crates/bloblex-daemon/src/remote/native.rs`; read `docs/FIX35_C1_REPORT.md`). Keep your context small: grep and read only the ranges you need; pipe long output through `tail`/`grep`. Do not edit `apps/desktop/src/ui/**`.

## Goal
Help a Native Remote host become reachable from outside its network **without any third-party service**, and tell the owner exactly what is and is not working.

## 1. UPnP / IGD port mapping (`remote/connectivity.rs`, new)
- Crate `igd-next` (new dependency, tokio feature). Behind a trait `PortMapper` so tests use a fake.
- `remote.native.upnp.set { enabled }` stores consent (`remote.native.upnp` setting, default false). Only with consent: on Native enable, search the gateway (5 s timeout), add a TCP mapping external `<port>` → this host's LAN IP `<port>`, description "Bitbots Remote", lease 3600 s renewed every 30 minutes; on disable or daemon shutdown remove **only that mapping**. Failure is reported, never fatal.
- From the gateway read the **external IP**.

## 2. External IP and CGNAT
- External IP comes only from UPnP (`get_external_ip`) or a value the owner types (`remote.native.externalIp.set { ip | null }`). **No IP-echo website.**
- CGNAT / not public: the address is in 100.64.0.0/10, RFC 1918, link-local, or the IPv6 ULA/link-local ranges → `cgnat: true` with a plain explanation key (`"carrier_nat"` or `"private"`).
- Re-check every 10 minutes while Native is on; on change, update `native.urls`, trigger C1's certificate regeneration if the new IP is not in the SANs, and emit `remote.changed`.

## 3. Windows Firewall
- Detect an inbound allow rule for the port: `netsh advfirewall firewall show rule name="Bitbots Remote"` (no shell; parse output; 5 s timeout).
- `remote.native.firewall.add` launches an **elevated** `netsh advfirewall firewall add rule name="Bitbots Remote" dir=in action=allow protocol=TCP localport=<port>` through `powershell Start-Process -Verb RunAs -Wait` (the owner sees UAC); report `added | declined | failed`. `remote.native.firewall.remove` likewise for disable. Non-Windows: report `unsupported`.

## 4. Self-test
- `GET /api/ping` (unauthenticated, rate-limited by C1's bucket) returns `{ ok: true }` and records `lastReachedAt` and `lastReachedFrom` (the peer IP **only if it is not a private/loopback address**, else `"this network"`), emitting `remote.changed`. The desktop shows "Reached from …" when the owner opens the address on a phone on mobile data. Never log the IP outside this status field.

## 5. Status
`remote.status.native` gains `upnp: { consent, state: "off" | "mapped" | "no_gateway" | "failed", error? }`, `firewall: "allowed" | "missing" | "unsupported" | "unknown"`, `externalIp: string | null`, `externalIpSource: "upnp" | "manual" | null`, `cgnat: boolean`, `cgnatReason?`. Add the new RPCs to `tiers.json` as `never`; extend `remoteContract.ts` and `remoteFixture.ts` (non-visual).

## Tests (fakes only; no real router, firewall or network)
- Fake IGD: mapping added on enable with consent, not without; renewed; removed on disable; external IP read; gateway missing → `no_gateway`.
- CGNAT classification for 100.64.0.1, 10.x, 192.168.x, 172.16.x, 169.254.x, fd00::/8, a public IPv4 and IPv6.
- IP change → urls updated, cert regeneration requested, event emitted.
- Firewall: parse "rule exists" / "No rules match" outputs from recorded text; add/remove build the exact argv; non-Windows → unsupported.
- `/api/ping` records public vs private source correctly and is rate-limited.

## Gates
- `RUST_MIN_STACK=33554432 cargo test --workspace --exclude bloblex-desktop --no-fail-fast 2>&1 | grep -E "test result|FAILED|panicked"`
- `cargo clippy --workspace --exclude bloblex-desktop -- -D warnings`
- `cd apps/desktop && npx tsc -b && npx vitest run src/remote src/preview`

## Report
`docs/FIX35_C2_REPORT.md`: shapes as implemented, argv used, tests, gates, unverified (real routers, real UAC, real mobile networks).
