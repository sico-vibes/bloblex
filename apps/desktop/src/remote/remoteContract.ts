// Remote mode: the shapes shared by the host Settings page, the simulator used
// by the web preview, and the browser/PWA client. This is a design contract:
// there is no network behind it yet. See docs/remote/ARCHITECTURE.md and the
// daemon-side shapes in docs/ipc-contract.md ("Remote mode methods").
//
// Amended for the Tailscale design (16 October 2026, FIX29 WP6d): there is no
// relay and no direct listener. `tailscale serve` publishes the host's loopback
// gateway over the tailnet; pairing is owner-confirmed. The daemon-side shapes
// are fixed by docs/ipc-contract.md:141-165 and docs/remote/PROTOCOL.md:167-207.
//
// Naming: "host" is a computer running Bitbots; "device" is a phone, tablet or
// browser that has been paired with a host.

/** What a device may do. Higher tiers include everything below them. */
export type RemoteTier = 'viewer' | 'chat' | 'operator'
export const REMOTE_TIERS: readonly RemoteTier[] = ['viewer', 'chat', 'operator']

export type DeviceKind = 'phone' | 'tablet' | 'browser' | 'computer' | 'machine'

/** The host's link to its serve address. */
export type RemoteLinkState = 'off' | 'starting' | 'online' | 'error'

/**
 * The two ways a device reaches a host (`remote.method`): over Tailscale, or
 * over the host's own network with a built-in TLS certificate and a password
 * (Native). One is active at a time.
 */
export type RemoteMethodId = 'tailscale' | 'native'

/**
 * What Tailscale must report before Remote can serve. Only `ready` starts;
 * every other state names the fix the Settings page has to show.
 * (`docs/ipc-contract.md:147`, `docs/remote/PROTOCOL.md:2.1`.)
 */
export type RemoteTailscaleState = 'not_installed' | 'starting' | 'not_running' | 'logged_out' | 'https_disabled' | 'port_in_use' | 'funnel_on' | 'ready'

export interface RemoteDevice {
  id: string
  name: string
  kind: DeviceKind
  tier: RemoteTier
  /** Free text such as "Android, Chrome" shown under the name. */
  platform: string
  pairedAt: string
  lastSeenAt: string | null
  /** True while the device has a live session with the host. */
  online: boolean
}

export interface RemoteStatus {
  enabled: boolean
  link: RemoteLinkState
  /** The HTTPS address `tailscale serve` publishes, for example "https://work-pc.tail1234.ts.net"; null while nothing is served. */
  url: string | null
  /** The loopback port the gateway listens on (`remote.port`, default 48620). */
  port: number
  /** The HTTPS port `tailscale serve` uses, 443 or 8443; null while nothing is served. */
  servePort: number | null
  tailscale: RemoteTailscaleState
  /** Host name devices see, for example "Work PC". */
  hostName: string
  deviceCount: number
  connectedCount: number
  /** Remote needs the computer awake; true when "keep awake" is covering that. */
  keepAwake: boolean
  error: string | null
  /**
   * The active Remote method (`remote.method`); Tailscale by default. The
   * daemon always sends it; optional here only so a partial fixture that
   * predates Native Remote still typechecks.
   */
  method?: RemoteMethodId
  /** Native Remote's own state (`remote.status.native`). The daemon always sends it. */
  native?: RemoteNativeStatus
}

/** UPnP port-mapping state (`remote.status.native.upnp.state`, FIX35 C2). */
export type RemoteNativeUpnpState = 'off' | 'mapped' | 'no_gateway' | 'failed'

export interface RemoteNativeUpnp {
  /** The owner consented to mapping the port on the router (`remote.native.upnp`). */
  consent: boolean
  state: RemoteNativeUpnpState
  /** Why the mapping failed, when it did; absent otherwise. */
  error?: string
}

/** The Windows firewall's view of Bitbots' inbound rule (FIX35 C2). */
export type RemoteNativeFirewallState = 'allowed' | 'missing' | 'unsupported' | 'unknown'

/** Where the external address came from (FIX35 C2). */
export type RemoteNativeExternalSource = 'upnp' | 'manual'

/**
 * The `native` block of `remote.status` (FIX35 C1; C2 adds `upnp`, `firewall`,
 * `externalIp` and `cgnat`). The daemon always sends the C2 fields; they are
 * optional here only so a fixture that predates them still typechecks.
 */
export interface RemoteNativeStatus {
  /** The port the Native listener binds (`remote.nativePort`, default 48621). */
  port: number
  /** The `https://<authority>` addresses the certificate covers. */
  urls: string[]
  /** SHA-256 of the certificate DER, uppercase hex in colon pairs; null before the certificate exists. */
  fingerprint: string | null
  accountSet: boolean
  username: string | null
  listening: boolean
  loginPaused: boolean
  pausedUntil: string | null
  lastReachedAt: string | null
  /** The last device that reached the host: a public address, or "this network". */
  lastReachedFrom: string | null
  /** UPnP port mapping (FIX35 C2). */
  upnp?: RemoteNativeUpnp
  /** The inbound Windows firewall rule for the port. */
  firewall?: RemoteNativeFirewallState
  /** The address the owner would share; null until UPnP or the owner supplies one. */
  externalIp?: string | null
  /** Where `externalIp` came from; null when there is none. */
  externalIpSource?: RemoteNativeExternalSource | null
  /** True when the address is carrier NAT, RFC 1918, link-local or IPv6 ULA. */
  cgnat?: boolean
  /** "carrier_nat" or "private"; absent when `cgnat` is false. */
  cgnatReason?: string
}

export interface PairingOffer {
  /** Eight characters in two groups, for example "K7QM-4XPD". */
  code: string
  /** The serve URL the phone opens; null is never sent, the address always exists while an offer is live. */
  url: string
  /** The string a QR code encodes; the serve URL. Opaque to the UI. */
  qrPayload: string
  /** ISO time; a code lives five minutes. */
  expiresAt: string
  /** Wrong submissions left before the code is burned (five). */
  attemptsLeft: number
}

/** Payload of `remote.pairing.requested`: the phone submitted the right code and locked the offer. */
export interface PairingRequest {
  pairingId: string
  name: string
  kind: DeviceKind
  platform: string
  /** The Tailscale login that made the request; null when no login header was sent. */
  login: string | null
  /** How the request arrived: a Tailscale pairing code, or a Native password sign-in. */
  method: RemoteMethodId
  /** ISO time; the request expires with the code. */
  expiresAt: string
}

/** Outcome of `remote.pairing.completed`. */
export type PairingOutcome = 'approved' | 'rejected' | 'expired' | 'cancelled' | 'burned'

export interface RemoteSecurityOptions {
  /** Operator devices may approve permission requests. Off by default. */
  approvalsFromRemote: boolean
  /** Days of silence after which a device is removed. 0 means never. */
  idleExpiryDays: 0 | 7 | 30 | 90
  quietHours: { enabled: boolean; from: string; to: string }
}

export type RemoteActivityKind = 'paired' | 'revoked' | 'connected' | 'disconnected' | 'prompt' | 'approval' | 'denied' | 'mcp'

export interface RemoteActivityEntry {
  id: string
  at: string
  deviceId: string
  deviceName: string
  kind: RemoteActivityKind
  /** One short sentence, never message content. */
  summary: string
}

/**
 * What the browser/PWA client knows about each paired computer. This list lives
 * only on the device: there is no host-side `remote.hosts.*` method
 * (`docs/ipc-contract.md:164`, `docs/remote/ARCHITECTURE.md:152-157`).
 */
export type RemoteHostState = 'online' | 'asleep' | 'offline' | 'reconnecting'

export interface RemoteHost {
  id: string
  name: string
  os: 'windows' | 'macos' | 'linux'
  state: RemoteHostState
  lastSeenAt: string | null
  botCount: number
  /** Bots on that computer waiting for the person. */
  waitingCount: number
  /** What this device may do on that host. */
  tier: RemoteTier
}

/** Method names of the daemon's `remote.*` family (`docs/ipc-contract.md:145-158`). */
export const REMOTE_METHODS = [
  'remote.status',
  'remote.enable',
  'remote.disable',
  'remote.method.set',
  'remote.native.account.set',
  'remote.native.cert.regenerate',
  'remote.native.port.set',
  'remote.native.upnp.set',
  'remote.native.externalIp.set',
  'remote.native.firewall.add',
  'remote.native.firewall.remove',
  'remote.pair.begin',
  'remote.pair.cancel',
  'remote.pair.confirm',
  'remote.devices.list',
  'remote.devices.update',
  'remote.devices.revoke',
  'remote.security.get',
  'remote.security.set',
  'remote.activity.list',
] as const
export type RemoteMethod = typeof REMOTE_METHODS[number]

/** Event types the simulator emits; payload shapes are in `docs/ipc-contract.md:160`. */
export const REMOTE_EVENTS = ['remote.changed', 'remote.pairing.requested', 'remote.pairing.completed', 'remote.device.changed', 'remote.activity'] as const
export type RemoteEventType = typeof REMOTE_EVENTS[number]

export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000

/** Wrong submissions a live code survives before it is burned (`docs/ipc-contract.md:150`). */
export const PAIRING_MAX_ATTEMPTS = 5

export function isRemoteTier(value: unknown): value is RemoteTier {
  return value === 'viewer' || value === 'chat' || value === 'operator'
}

/** Higher or equal: operator >= chat >= viewer. */
export function tierAtLeast(have: RemoteTier, need: RemoteTier): boolean {
  return REMOTE_TIERS.indexOf(have) >= REMOTE_TIERS.indexOf(need)
}

export const DEFAULT_REMOTE_SECURITY: RemoteSecurityOptions = {
  approvalsFromRemote: false,
  idleExpiryDays: 30,
  quietHours: { enabled: false, from: '22:00', to: '07:00' },
}
