// What the phone client needs from its host besides `rpc` and events: who it
// is (`/api/me`), pairing, sign-out and the live connection state. The real
// build backs it with the gateway transport (`remoteDevice` in remoteTauri.ts);
// the browser preview and tests use `createPreviewDeviceApi`.
import type { RemoteConnectionStatus, RemoteLoginInput, RemoteMe, RemotePairInput, RemotePairState } from './remoteTransport'
import type { DeviceKind, RemoteMethodId, RemoteTier } from './remoteContract'

export interface RemoteDeviceApi {
  me(): Promise<RemoteMe>
  pair(input: RemotePairInput): Promise<{ state: RemotePairState }>
  pairStatus(): Promise<RemotePairState>
  /** Native sign-in: a username and password that either approves a held cookie or starts a pending request. */
  login(input: RemoteLoginInput): Promise<{ state: RemotePairState }>
  logout(): Promise<void>
  /** Live connection state; returns an unsubscribe function. */
  onConnection(handler: (status: RemoteConnectionStatus) => void): () => void
}

/** The wire code of a refused call, when the error carries one. */
export function errorCode(reason: unknown): string | null {
  const code = reason && typeof reason === 'object' ? (reason as { code?: unknown }).code : null
  return typeof code === 'string' ? code : null
}

/** A best guess at what this device is, for the owner's approval card. */
export function describeThisDevice(userAgent: string): { kind: DeviceKind; platform: string } {
  const ua = userAgent
  const kind: DeviceKind = /iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|iPhone|Android/i.test(ua) ? 'phone' : 'browser'
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown'
  const browser = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  return { kind, platform: `${os}, ${browser}` }
}

/** The code a scanned QR carries in the address (`#pair=K7QM4XPD`). */
export function codeFromHash(hash: string): string {
  const match = /(?:^#|&)pair=([A-Za-z0-9-]{8,9})/.exec(hash)
  return match ? match[1].toUpperCase() : ''
}

const PREVIEW_KEY = 'bitbots.remote.preview.device'

/** The preview's password: any username works, this is the password that does not. */
export const PREVIEW_PASSPHRASE = 'preview-passphrase'

/**
 * The preview's stand-in host: any 8 characters pair, the computer "approves"
 * after a short wait, and the device is remembered in localStorage. Native
 * sign-in accepts any username with the preview passphrase, then behaves like a
 * pairing request.
 */
export function createPreviewDeviceApi(
  options: { hostName?: string; tier?: RemoteTier; approveAfterMs?: number; method?: RemoteMethodId } = {},
): RemoteDeviceApi {
  const hostName = options.hostName ?? 'Work PC'
  const tier = options.tier ?? 'chat'
  const approveAfter = options.approveAfterMs ?? 2500
  const method: RemoteMethodId = options.method ?? 'tailscale'
  let pendingSince: number | null = null
  let pendingName = 'This phone'
  const read = (): { name: string } | null => { try { return JSON.parse(localStorage.getItem(PREVIEW_KEY) ?? 'null') as { name: string } | null } catch { return null } }
  const write = (value: { name: string } | null) => { try { if (value) localStorage.setItem(PREVIEW_KEY, JSON.stringify(value)); else localStorage.removeItem(PREVIEW_KEY) } catch { /* private mode */ } }
  const refused = (code: string, message: string, method?: RemoteMethodId) =>
    Object.assign(new Error(message), method === undefined ? { code } : { code, method })
  return {
    async me() {
      const device = read()
      if (!device) throw refused('unauthorized', 'This device is not paired.', method)
      return { protocolVersion: 1, device: { id: 'preview-device', name: device.name, tier }, host: { name: hostName }, approvalsFromRemote: false, quietHoursActive: false, method }
    },
    async pair(input) {
      if (input.code.replace('-', '').length !== 8) throw refused('pairing_invalid', 'That code did not work. Check it, or show a new one on the computer.')
      pendingSince = Date.now()
      pendingName = input.name
      return { state: 'pending' }
    },
    async login(input) {
      if (input.password !== PREVIEW_PASSPHRASE) throw refused('login_invalid', 'That username or password is not right.')
      pendingSince = Date.now()
      pendingName = input.name
      return { state: 'pending' }
    },
    async pairStatus() {
      if (pendingSince === null) return 'expired'
      if (Date.now() - pendingSince < approveAfter) return 'pending'
      pendingSince = null
      write({ name: pendingName })
      return 'approved'
    },
    async logout() { write(null) },
    onConnection(handler) { handler('online'); return () => undefined },
  }
}
