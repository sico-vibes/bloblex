// Preview-only, in-memory stand-in for the daemon side of Remote mode. The web
// preview runs the same React UI against this module so the host Settings page
// and the paired-computer list can be inspected without Tailscale, a phone or
// any network. Everything here is a fixture: nothing is persisted and no timers
// run at import time. The method names, event names and shapes are fixed by
// src/remote/remoteContract.ts and docs/ipc-contract.md:141-165.
//
// FIX29 WP6d: the Tailscale design. There is no relay and no direct listener;
// `tailscale serve` publishes the loopback gateway, and pairing is
// owner-confirmed (`docs/remote/PROTOCOL.md:167-207`).
import {
  DEFAULT_REMOTE_SECURITY,
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_ATTEMPTS,
  isRemoteTier,
} from '../remote/remoteContract'
import type {
  PairingOffer,
  PairingRequest,
  RemoteActivityEntry,
  RemoteActivityKind,
  RemoteDevice,
  RemoteEventType,
  RemoteMethod,
  RemoteMethodId,
  RemoteNativeExternalSource,
  RemoteNativeFirewallState,
  RemoteNativeStatus,
  RemoteNativeUpnpState,
  RemoteSecurityOptions,
  RemoteStatus,
  RemoteTailscaleState,
  RemoteTier,
} from '../remote/remoteContract'

/** A minimal timer seam so tests can drive the simulator with fake timers. */
export interface TimerLike {
  setTimeout(handler: () => void, delay: number): unknown
  clearTimeout(handle: unknown): void
}

/** What the simulated phone sends with `POST /api/pair` (`docs/remote/PROTOCOL.md:173-179`). */
export interface PhoneSubmission {
  /** Omit to submit the live code; anything else counts one wrong attempt. */
  code?: string
  name?: string
  kind?: RemoteDevice['kind']
  platform?: string
  login?: string | null
}

export interface RemoteSimulator {
  call(method: RemoteMethod, params: Record<string, unknown>): Promise<unknown>
  subscribe(listener: (event: { type: RemoteEventType; payload: unknown }) => void): () => void
  reset(seed?: RemoteSeed): void
  /** Preview-only: the phone submitted a code and locked the live offer. */
  simulatePhoneRequest(submission?: PhoneSubmission): PairingRequest | null
  dispose(): void
}

export interface RemoteSeed {
  enabled?: boolean
  devices?: number
  /** The Tailscale state the host reports; only `ready` can serve. */
  tailscale?: RemoteTailscaleState
  /** The active Remote method (`remote.method`); Tailscale by default. */
  method?: RemoteMethodId
}

const HOST_NAME = 'Work PC'
const SERVE_URL = 'https://work-pc.tail1234.ts.net'
const GATEWAY_PORT = 48620
const SERVE_PORT = 443
/** How long `remote.enable` takes to publish the serve handler. */
const SERVE_START_MS = 700
const ACTIVITY_LIMIT = 50
const DEVICE_NAME_MAX = 40
/** `remote.native.port` default (FIX35 C1). */
const NATIVE_PORT = 48621

/** A stable-looking certificate fingerprint, so the simulator's changes are visible. */
function nativeFingerprintFor(serial: number): string {
  return Array.from({ length: 32 }, (_, index) => ((index * 7 + serial * 13 + 1) % 256).toString(16).padStart(2, '0').toUpperCase()).join(':')
}

/** The fix the Settings page shows, one line per state (`docs/remote/ARCHITECTURE.md:99-101`). */
const TAILSCALE_FIX: Record<Exclude<RemoteTailscaleState, 'ready'>, string> = {
  not_installed: 'Tailscale is not installed. Install Tailscale on this computer and sign in, then turn Remote on again.',
  logged_out: 'Tailscale is not signed in. Sign in to Tailscale on this computer, then turn Remote on again.',
  https_disabled: 'HTTPS certificates are off for your tailnet. Turn them on in the Tailscale admin settings, then turn Remote on again.',
  port_in_use: 'Tailscale cannot publish this computer: ports 443 and 8443 are both in use. Free one of them, then turn Remote on again.',
  funnel_on: 'Funnel is on for the port Bitbots needs. Turn Funnel off in Tailscale, then turn Remote on again.',
}

/** Unambiguous pairing alphabet: no 0/O and no 1/I. */
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

interface DevicePreset {
  name: string
  kind: RemoteDevice['kind']
  platform: string
  tier: RemoteTier
}

const DEVICE_PRESETS: readonly DevicePreset[] = [
  { name: 'Pixel 8', kind: 'phone', platform: 'Android 15, Chrome', tier: 'chat' },
  { name: 'iPad Air', kind: 'tablet', platform: 'iPadOS 18, Safari', tier: 'viewer' },
  { name: 'Loft laptop', kind: 'browser', platform: 'Windows 11, Edge', tier: 'operator' },
]

/** What the preview phone sends when a test does not say otherwise. */
const PHONE_SUBMISSION: Required<Omit<PhoneSubmission, 'code'>> = {
  name: DEVICE_PRESETS[0].name,
  kind: DEVICE_PRESETS[0].kind,
  platform: DEVICE_PRESETS[0].platform,
  login: 'owner@example.com',
}

const defaultTimers: TimerLike = {
  setTimeout: (handler, delay) => globalThis.setTimeout(handler, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
}

type RemoteError = Error & { code: string }

function remoteError(code: string, message: string): RemoteError {
  const error = new Error(`${code}: ${message}`) as RemoteError
  error.code = code
  return error
}

function cloneSecurity(options: RemoteSecurityOptions): RemoteSecurityOptions {
  return {
    approvalsFromRemote: options.approvalsFromRemote,
    idleExpiryDays: options.idleExpiryDays,
    quietHours: { ...options.quietHours },
  }
}

/** Codes are compared case-insensitively and without the group dash. */
function normalizeCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function createRemoteSimulator(options: {
  now?: () => number
  random?: () => number
  timers?: TimerLike
} = {}): RemoteSimulator {
  const nowFn = options.now ?? (() => Date.now())
  const randomFn = options.random ?? (() => Math.random())
  const timers = options.timers ?? defaultTimers

  let enabled = false
  let link: RemoteStatus['link'] = 'off'
  let url: string | null = null
  let servePort: number | null = null
  let tailscale: RemoteTailscaleState = 'ready'
  let method: RemoteMethodId = 'tailscale'
  let nativePort = NATIVE_PORT
  let nativeAccount: string | null = null
  let nativeFingerprint: string | null = null
  let nativeCertSerial = 0
  let nativeLoginPaused = false
  let nativePausedUntil: string | null = null
  let nativeLastReachedAt: string | null = null
  let nativeLastReachedFrom: string | null = null
  let nativeUpnpConsent = false
  let nativeUpnpState: RemoteNativeUpnpState = 'off'
  let nativeUpnpError: string | undefined
  let nativeFirewall: RemoteNativeFirewallState = 'unknown'
  let nativeExternalIp: string | null = null
  let nativeExternalIpSource: RemoteNativeExternalSource | null = null
  let nativeCgnat = false
  let nativeCgnatReason: string | undefined
  /** The fixture never reaches a serving failure, so this stays null; a real host sets it when `tailscale serve` dies. */
  let error: string | null = null
  let devices: RemoteDevice[] = []
  let offer: PairingOffer | null = null
  let request: PairingRequest | null = null
  let security: RemoteSecurityOptions = cloneSecurity(DEFAULT_REMOTE_SECURITY)
  let activity: RemoteActivityEntry[] = []
  let deviceSerial = 0
  let pairingSerial = 0
  let activitySerial = 0

  let startTimer: unknown = null
  let expiryTimer: unknown = null

  const listeners = new Set<(event: { type: RemoteEventType; payload: unknown }) => void>()

  const iso = (ms: number) => new Date(ms).toISOString()
  const nowIso = () => iso(nowFn())
  const emit = (type: RemoteEventType, payload: unknown) => {
    const event = { type, payload }
    for (const listener of [...listeners]) listener(event)
  }
  const cancel = (handle: unknown) => { if (handle !== null) timers.clearTimeout(handle) }

  function nativeStatus(): RemoteNativeStatus {
    return {
      port: nativePort,
      urls: nativeFingerprint === null
        ? []
        : [`https://${HOST_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${nativePort}`, `https://localhost:${nativePort}`],
      fingerprint: nativeFingerprint,
      accountSet: nativeAccount !== null,
      username: nativeAccount,
      listening: enabled && method === 'native',
      loginPaused: nativeLoginPaused,
      pausedUntil: nativePausedUntil,
      lastReachedAt: nativeLastReachedAt,
      lastReachedFrom: nativeLastReachedFrom,
      upnp: {
        consent: nativeUpnpConsent,
        state: nativeUpnpState,
        ...(nativeUpnpError === undefined ? {} : { error: nativeUpnpError }),
      },
      firewall: nativeFirewall,
      externalIp: nativeExternalIp,
      externalIpSource: nativeExternalIpSource,
      cgnat: nativeCgnat,
      ...(nativeCgnatReason === undefined ? {} : { cgnatReason: nativeCgnatReason }),
    }
  }

  function status(): RemoteStatus {
    return {
      enabled,
      link,
      url,
      port: GATEWAY_PORT,
      servePort,
      tailscale,
      hostName: HOST_NAME,
      deviceCount: devices.length,
      connectedCount: devices.filter((device) => device.online).length,
      keepAwake: enabled,
      error,
      method,
      native: nativeStatus(),
    }
  }

  function pushActivity(entry: RemoteActivityEntry) {
    activity.unshift(entry)
    if (activity.length > ACTIVITY_LIMIT) activity.length = ACTIVITY_LIMIT
  }

  function activityEntry(kind: RemoteActivityKind, deviceId: string, deviceName: string, summary: string): RemoteActivityEntry {
    activitySerial += 1
    return { id: `activity-${activitySerial}`, at: nowIso(), deviceId, deviceName, kind, summary }
  }

  function generateCode() {
    let raw = ''
    for (let index = 0; index < 8; index += 1) {
      const offset = Math.min(PAIRING_ALPHABET.length - 1, Math.max(0, Math.floor(randomFn() * PAIRING_ALPHABET.length)))
      raw += PAIRING_ALPHABET[offset]
    }
    return `${raw.slice(0, 4)}-${raw.slice(4)}`
  }

  function createSeedDevice(index: number): RemoteDevice {
    const preset = DEVICE_PRESETS[index % DEVICE_PRESETS.length]
    return {
      id: `device-${index + 1}`,
      name: preset.name,
      kind: preset.kind,
      tier: preset.tier,
      platform: preset.platform,
      pairedAt: iso(nowFn() - (index + 1) * 3_600_000),
      lastSeenAt: nowIso(),
      online: true,
    }
  }

  /** A live offer that nobody locked. */
  function clearOffer() {
    if (expiryTimer !== null) { cancel(expiryTimer); expiryTimer = null }
    offer = null
  }

  /** The request that locked an offer ran out of time (`docs/remote/PROTOCOL.md:186`). */
  function expireRequest() {
    if (!request) return
    const pairingId = request.pairingId
    if (expiryTimer !== null) { cancel(expiryTimer); expiryTimer = null }
    request = null
    emit('remote.pairing.completed', { pairingId, outcome: 'expired' })
  }

  function armExpiry() {
    if (expiryTimer !== null) cancel(expiryTimer)
    const expiresAt = offer?.expiresAt ?? request?.expiresAt
    if (!expiresAt) { expiryTimer = null; return }
    const delay = Math.max(0, Date.parse(expiresAt) - nowFn())
    expiryTimer = timers.setTimeout(() => {
      expiryTimer = null
      const pending = request
      request = null
      offer = null
      if (pending) emit('remote.pairing.completed', { pairingId: pending.pairingId, outcome: 'expired' })
    }, delay)
  }

  function enable(): RemoteStatus {
    if (enabled && link === 'online') return status()
    if (method === 'native') {
      if (nativeAccount === null) throw remoteError('conflict', 'Set a username and password first.')
      enabled = true
      error = null
      cancel(startTimer)
      startTimer = null
      link = 'online'
      url = null
      servePort = null
      if (nativeFingerprint === null) nativeFingerprint = nativeFingerprintFor(nativeCertSerial)
      emit('remote.changed', { status: status() })
      return status()
    }
    if (tailscale !== 'ready') throw remoteError('unsupported', TAILSCALE_FIX[tailscale])
    enabled = true
    error = null
    cancel(startTimer)
    link = 'starting'
    url = null
    servePort = null
    emit('remote.changed', { status: status() })
    startTimer = timers.setTimeout(() => {
      startTimer = null
      if (!enabled) return
      link = 'online'
      servePort = SERVE_PORT
      url = SERVE_URL
      emit('remote.changed', { status: status() })
    }, SERVE_START_MS)
    return status()
  }

  function disable(): RemoteStatus {
    cancel(startTimer)
    startTimer = null
    clearOffer()
    if (request) { cancel(expiryTimer); expiryTimer = null; request = null }
    enabled = false
    link = 'off'
    url = null
    servePort = null
    error = null
    for (const device of devices) {
      if (!device.online) continue
      device.online = false
      device.lastSeenAt = nowIso()
      emit('remote.device.changed', { action: 'updated', device: { ...device } })
    }
    emit('remote.changed', { status: status() })
    return status()
  }

  function activeOffer(): PairingOffer | null {
    if (!offer) return null
    if (nowFn() >= Date.parse(offer.expiresAt)) { clearOffer(); return null }
    return offer
  }

  function pairBegin(): PairingOffer {
    if (!enabled) throw remoteError('conflict', 'Remote access is off. Turn it on before pairing a device.')
    clearOffer()
    const created: PairingOffer = {
      code: generateCode(),
      url: url ?? SERVE_URL,
      qrPayload: url ?? SERVE_URL,
      expiresAt: iso(nowFn() + PAIRING_CODE_TTL_MS),
      attemptsLeft: PAIRING_MAX_ATTEMPTS,
    }
    offer = created
    armExpiry()
    return { ...created }
  }

  function pairCancel() {
    if (request) {
      const pairingId = request.pairingId
      if (expiryTimer !== null) { cancel(expiryTimer); expiryTimer = null }
      request = null
      emit('remote.pairing.completed', { pairingId, outcome: 'cancelled' })
      return { cancelled: true }
    }
    clearOffer()
    return { cancelled: true }
  }

  function simulatePhoneRequest(submission: PhoneSubmission = {}): PairingRequest | null {
    const live = activeOffer()
    if (!live) return null
    if (submission.code !== undefined && normalizeCode(submission.code) !== normalizeCode(live.code)) {
      live.attemptsLeft -= 1
      if (live.attemptsLeft <= 0) clearOffer()
      throw remoteError('pairing_invalid', 'That code is not right.')
    }
    if (expiryTimer !== null) { cancel(expiryTimer); expiryTimer = null }
    pairingSerial += 1
    const locked: PairingRequest = {
      pairingId: `pairing-${pairingSerial}`,
      name: submission.name ?? PHONE_SUBMISSION.name,
      kind: submission.kind ?? PHONE_SUBMISSION.kind,
      platform: submission.platform ?? PHONE_SUBMISSION.platform,
      login: submission.login === undefined ? PHONE_SUBMISSION.login : submission.login,
      method: 'tailscale',
      expiresAt: live.expiresAt,
    }
    // The first correct code locks the offer to this request; the code is spent.
    offer = null
    request = locked
    armExpiry()
    emit('remote.pairing.requested', { ...locked })
    return { ...locked }
  }

  function pairConfirm(params: Record<string, unknown>): { approved: boolean; device?: RemoteDevice } {
    const pairingId = String(params.pairingId ?? '')
    const approve = params.approve
    if (typeof approve !== 'boolean') throw remoteError('invalid_argument', 'approve must be a boolean.')
    if (!request || request.pairingId !== pairingId) throw remoteError('not_found', 'That pairing request is no longer waiting.')
    if (nowFn() >= Date.parse(request.expiresAt)) { expireRequest(); throw remoteError('not_found', 'That pairing request is no longer waiting.') }
    const decided = request
    if (!approve) {
      // Rejecting burns the offer (`docs/ipc-contract.md:152`).
      if (expiryTimer !== null) { cancel(expiryTimer); expiryTimer = null }
      request = null
      const entry = activityEntry('denied', '', decided.name, `Pairing request from ${decided.name} was rejected`)
      pushActivity(entry)
      emit('remote.pairing.completed', { pairingId, outcome: 'burned' })
      emit('remote.activity', { entry })
      emit('remote.changed', { status: status() })
      return { approved: false }
    }
    // Validate before consuming the request, so a refused call leaves it waiting.
    const tier = params.tier
    if (!isRemoteTier(tier)) throw remoteError('invalid_argument', 'tier must be viewer, chat or operator.')
    if (expiryTimer !== null) { cancel(expiryTimer); expiryTimer = null }
    request = null
    deviceSerial += 1
    const device: RemoteDevice = {
      id: `device-${deviceSerial}`,
      name: decided.name,
      kind: decided.kind,
      tier,
      platform: decided.platform,
      pairedAt: nowIso(),
      lastSeenAt: nowIso(),
      online: true,
    }
    devices.push(device)
    const entry = activityEntry('paired', device.id, device.name, `${device.name} paired`)
    pushActivity(entry)
    emit('remote.pairing.completed', { pairingId, outcome: 'approved', deviceId: device.id })
    emit('remote.device.changed', { action: 'added', device: { ...device } })
    emit('remote.activity', { entry })
    emit('remote.changed', { status: status() })
    return { approved: true, device: { ...device } }
  }

  function updateDevice(params: Record<string, unknown>): RemoteDevice {
    const id = String(params.deviceId ?? '')
    const device = devices.find((item) => item.id === id)
    if (!device) throw remoteError('not_found', 'That device is no longer paired.')
    let changed = false
    if ('tier' in params && params.tier !== undefined) {
      if (!isRemoteTier(params.tier)) throw remoteError('invalid_argument', 'tier must be viewer, chat or operator.')
      if (device.tier !== params.tier) { device.tier = params.tier; changed = true }
    }
    if ('name' in params && params.name !== undefined) {
      if (typeof params.name !== 'string') throw remoteError('invalid_argument', 'name must be text.')
      const name = params.name.trim()
      if (name.length < 1 || name.length > DEVICE_NAME_MAX) throw remoteError('invalid_argument', `name must be 1 to ${DEVICE_NAME_MAX} characters.`)
      if (device.name !== name) { device.name = name; changed = true }
    }
    if (changed) emit('remote.device.changed', { action: 'updated', device: { ...device } })
    return { ...device }
  }

  function revokeDevice(params: Record<string, unknown>) {
    const id = String(params.deviceId ?? '')
    const index = devices.findIndex((item) => item.id === id)
    if (index < 0) throw remoteError('not_found', 'That device is no longer paired.')
    const [removed] = devices.splice(index, 1)
    const entry = activityEntry('revoked', removed.id, removed.name, `${removed.name} was removed`)
    pushActivity(entry)
    emit('remote.device.changed', { action: 'removed', device: { ...removed } })
    emit('remote.activity', { entry })
    emit('remote.changed', { status: status() })
    return { revoked: true, deviceId: removed.id }
  }

  function setSecurity(params: Record<string, unknown>): RemoteSecurityOptions {
    const next = cloneSecurity(security)
    if ('approvalsFromRemote' in params && params.approvalsFromRemote !== undefined) {
      if (typeof params.approvalsFromRemote !== 'boolean') throw remoteError('invalid_argument', 'approvalsFromRemote must be a boolean.')
      next.approvalsFromRemote = params.approvalsFromRemote
    }
    if ('idleExpiryDays' in params && params.idleExpiryDays !== undefined) {
      const days = params.idleExpiryDays
      if (days !== 0 && days !== 7 && days !== 30 && days !== 90) throw remoteError('invalid_argument', 'idleExpiryDays must be 0, 7, 30 or 90.')
      next.idleExpiryDays = days
    }
    if ('quietHours' in params && params.quietHours && typeof params.quietHours === 'object') {
      const quiet = params.quietHours as Record<string, unknown>
      next.quietHours = {
        enabled: typeof quiet.enabled === 'boolean' ? quiet.enabled : next.quietHours.enabled,
        from: typeof quiet.from === 'string' ? quiet.from : next.quietHours.from,
        to: typeof quiet.to === 'string' ? quiet.to : next.quietHours.to,
      }
    }
    security = next
    if (security.approvalsFromRemote === false) {
      for (const device of devices) {
        if (device.tier !== 'operator') continue
        device.tier = 'chat'
        emit('remote.device.changed', { action: 'updated', device: { ...device } })
      }
      const entry = activityEntry('approval', '', HOST_NAME, 'Approvals from remote turned off')
      pushActivity(entry)
      emit('remote.activity', { entry })
    }
    return cloneSecurity(security)
  }

  function methodSet(params: Record<string, unknown>): RemoteStatus {
    const next = params.method
    if (next !== 'tailscale' && next !== 'native') throw remoteError('invalid_argument', 'method must be tailscale or native.')
    if (enabled && method !== next) throw remoteError('conflict', 'Turn Remote off before switching method.')
    method = next
    emit('remote.changed', { status: status() })
    return status()
  }

  function accountSet(params: Record<string, unknown>): { accountSet: true; username: string } {
    const username = typeof params.username === 'string' ? params.username.trim() : ''
    const password = typeof params.password === 'string' ? params.password : ''
    if (username.length < 1 || username.length > 64) throw remoteError('invalid_argument', 'The username must be 1 to 64 characters.')
    if (password.length < 12) throw remoteError('invalid_argument', 'The password must be at least 12 characters.')
    if (password === username) throw remoteError('invalid_argument', 'The password must not be the username.')
    nativeAccount = username
    return { accountSet: true, username }
  }

  function certRegenerate(): RemoteNativeStatus {
    nativeCertSerial += 1
    nativeFingerprint = nativeFingerprintFor(nativeCertSerial)
    return nativeStatus()
  }

  function portSet(params: Record<string, unknown>): RemoteNativeStatus {
    if (enabled) throw remoteError('conflict', 'Turn Remote off before changing the port.')
    const port = params.port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
      throw remoteError('invalid_argument', 'port must be a number from 1024 to 65535')
    }
    nativePort = port
    emit('remote.changed', { status: status() })
    return nativeStatus()
  }

  /** IPv4 dotted quad or anything with a colon (IPv6), enough for the preview. */
  function looksLikeIp(value: string): boolean {
    const text = value.trim()
    if (text.includes(':')) return /^[0-9a-fA-F:]+$/.test(text)
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(text)
  }

  /** The words the daemon's status uses, enough for the preview to be truthful. */
  function cgnatReasonFor(ip: string): string | undefined {
    const parts = ip.split('.').map((part) => Number(part))
    if (parts.length === 4 && parts.every((part) => Number.isInteger(part))) {
      const [a, b] = parts
      if (a === 100 && b >= 64 && b <= 127) return 'carrier_nat'
      if (a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) return 'private'
      return undefined
    }
    const first = ip.slice(0, 2).toLowerCase()
    return first === 'fc' || first === 'fd' || first === 'fe' ? 'private' : undefined
  }

  function upnpSet(params: Record<string, unknown>): RemoteNativeStatus {
    const enabled = params.enabled === true
    nativeUpnpConsent = enabled
    nativeUpnpState = enabled ? 'mapped' : 'off'
    nativeUpnpError = undefined
    if (enabled) {
      // The simulator always finds a gateway that hands out one public address.
      nativeExternalIp = '203.0.113.7'
      nativeExternalIpSource = 'upnp'
      nativeCgnat = false
      nativeCgnatReason = undefined
    }
    emit('remote.changed', { status: status() })
    return nativeStatus()
  }

  function externalIpSet(params: Record<string, unknown>): RemoteNativeStatus {
    const raw = params.ip
    if (raw !== null && raw !== undefined && typeof raw !== 'string') {
      throw remoteError('invalid_argument', 'ip must be an address, or null to clear it')
    }
    const ip = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
    if (ip !== null && !looksLikeIp(ip)) {
      throw remoteError('invalid_argument', 'ip must be an address, or null to clear it')
    }
    nativeExternalIp = ip
    nativeExternalIpSource = ip === null ? null : 'manual'
    nativeCgnatReason = ip === null ? undefined : cgnatReasonFor(ip)
    nativeCgnat = nativeCgnatReason !== undefined
    emit('remote.changed', { status: status() })
    return nativeStatus()
  }

  function firewallAdd(): { result: string } {
    nativeFirewall = 'allowed'
    emit('remote.changed', { status: status() })
    return { result: 'added' }
  }

  function firewallRemove(): { result: string } {
    nativeFirewall = 'missing'
    emit('remote.changed', { status: status() })
    return { result: 'removed' }
  }

  function reset(seed: RemoteSeed = {}) {
    cancel(startTimer)
    startTimer = null
    cancel(expiryTimer)
    expiryTimer = null
    tailscale = seed.tailscale ?? 'ready'
    method = seed.method ?? 'tailscale'
    enabled = (seed.enabled ?? false) && (method === 'native' || tailscale === 'ready')
    link = enabled ? 'online' : 'off'
    url = enabled && method === 'tailscale' ? SERVE_URL : null
    servePort = enabled && method === 'tailscale' ? SERVE_PORT : null
    nativePort = NATIVE_PORT
    nativeAccount = null
    nativeFingerprint = null
    nativeCertSerial = 0
    nativeLoginPaused = false
    nativePausedUntil = null
    nativeLastReachedAt = null
    nativeLastReachedFrom = null
    nativeUpnpConsent = false
    nativeUpnpState = 'off'
    nativeUpnpError = undefined
    nativeFirewall = 'unknown'
    nativeExternalIp = null
    nativeExternalIpSource = null
    nativeCgnat = false
    nativeCgnatReason = undefined
    error = null
    offer = null
    request = null
    security = cloneSecurity(DEFAULT_REMOTE_SECURITY)
    activity = []
    activitySerial = 0
    pairingSerial = 0
    const count = Math.max(0, Math.floor(seed.devices ?? 0))
    devices = Array.from({ length: count }, (_, index) => createSeedDevice(index))
    deviceSerial = count
  }

  async function call(method: RemoteMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    switch (method) {
      case 'remote.status': return status()
      case 'remote.enable': return enable()
      case 'remote.disable': return disable()
      case 'remote.method.set': return methodSet(params)
      case 'remote.native.account.set': return accountSet(params)
      case 'remote.native.cert.regenerate': return certRegenerate()
      case 'remote.native.port.set': return portSet(params)
      case 'remote.native.upnp.set': return upnpSet(params)
      case 'remote.native.externalIp.set': return externalIpSet(params)
      case 'remote.native.firewall.add': return firewallAdd()
      case 'remote.native.firewall.remove': return firewallRemove()
      case 'remote.pair.begin': return pairBegin()
      case 'remote.pair.cancel': return pairCancel()
      case 'remote.pair.confirm': return pairConfirm(params)
      case 'remote.devices.list': return { devices: devices.map((device) => ({ ...device })) }
      case 'remote.devices.update': return updateDevice(params)
      case 'remote.devices.revoke': return revokeDevice(params)
      case 'remote.security.get': return cloneSecurity(security)
      case 'remote.security.set': return setSecurity(params)
      case 'remote.activity.list': return { entries: activity.map((entry) => ({ ...entry })) }
      default: throw remoteError('unsupported', `Unknown remote method ${String(method)}.`)
    }
  }

  function dispose() {
    cancel(startTimer)
    startTimer = null
    cancel(expiryTimer)
    expiryTimer = null
    listeners.clear()
  }

  // Start from an explicit clean slate so a caller that never resets still gets
  // a predictable shape.
  reset()

  return {
    call,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    reset,
    simulatePhoneRequest,
    dispose,
  }
}
