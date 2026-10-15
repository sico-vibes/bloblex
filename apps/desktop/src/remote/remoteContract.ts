// Remote mode: the shapes shared by the host Settings page, the simulator used
// by the web preview, and the browser/PWA client. This is a design contract:
// there is no network behind it yet. See docs/remote/ARCHITECTURE.md.
//
// Naming: "host" is a computer running Bitbots; "device" is a phone, tablet or
// browser that has been paired with a host.

/** What a device may do. Higher tiers include everything below them. */
export type RemoteTier = 'viewer' | 'chat' | 'operator'
export const REMOTE_TIERS: readonly RemoteTier[] = ['viewer', 'chat', 'operator']

export type DeviceKind = 'phone' | 'tablet' | 'browser' | 'computer'

/** The host's link to the relay (or direct listener). */
export type RemoteLinkState = 'off' | 'connecting' | 'online' | 'reconnecting' | 'error'

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
  /** Host name devices see, for example "Work PC". */
  hostName: string
  /** Relay host shown to the user, for example "relay.bitbots.app". */
  relay: string
  latencyMs: number | null
  /** When the link last became online. */
  since: string | null
  /** Whether the optional direct address is switched on. */
  direct: boolean
  directAddress: string | null
  deviceCount: number
  connectedCount: number
  /** Remote needs the computer awake; true when "keep awake" is covering that. */
  keepAwake: boolean
  error: string | null
}

export interface PairingOffer {
  /** Eight characters in two groups, for example "K7QM-4XPD". */
  code: string
  /** The string a QR code encodes. Opaque to the UI. */
  qrPayload: string
  /** ISO time; a code lives five minutes. */
  expiresAt: string
  relay: string
}

export interface RemoteSecurityOptions {
  /** Operator devices may approve permission requests. Off by default. */
  approvalsFromRemote: boolean
  /** Days of silence after which a device is removed. 0 means never. */
  idleExpiryDays: 0 | 7 | 30 | 90
  quietHours: { enabled: boolean; from: string; to: string }
}

export type RemoteActivityKind = 'paired' | 'revoked' | 'connected' | 'disconnected' | 'prompt' | 'approval' | 'denied'

export interface RemoteActivityEntry {
  id: string
  at: string
  deviceId: string
  deviceName: string
  kind: RemoteActivityKind
  /** One short sentence, never message content. */
  summary: string
}

/** What the browser/PWA client knows about each paired computer. */
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

/** Method names of the simulated `remote.*` family (the daemon will own these later). */
export const REMOTE_METHODS = [
  'remote.status',
  'remote.enable',
  'remote.disable',
  'remote.pair.begin',
  'remote.pair.cancel',
  'remote.devices.list',
  'remote.devices.update',
  'remote.devices.revoke',
  'remote.security.get',
  'remote.security.set',
  'remote.activity.list',
  'remote.direct.set',
  'remote.hosts.list',
  'remote.hosts.select',
] as const
export type RemoteMethod = typeof REMOTE_METHODS[number]

/** Event types the simulator emits (payloads are the shapes above). */
export const REMOTE_EVENTS = ['remote.changed', 'remote.device.changed', 'remote.pairing.completed', 'remote.activity', 'remote.host.changed'] as const
export type RemoteEventType = typeof REMOTE_EVENTS[number]

export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000

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
