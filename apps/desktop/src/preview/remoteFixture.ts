// Preview-only, in-memory stand-in for the daemon side of Remote mode. The web
// preview runs the same React UI against this module so the host Settings page
// and the paired-computer list can be inspected without a relay, a phone or any
// network. Everything here is a fixture: nothing is persisted and no timers run
// at import time. The method names, event names and shapes are fixed by
// src/remote/remoteContract.ts; see docs/FIX17_REPORT.md.
import {
  DEFAULT_REMOTE_SECURITY,
  PAIRING_CODE_TTL_MS,
  isRemoteTier,
} from '../remote/remoteContract'
import type {
  PairingOffer,
  RemoteActivityEntry,
  RemoteActivityKind,
  RemoteDevice,
  RemoteEventType,
  RemoteHost,
  RemoteLinkState,
  RemoteMethod,
  RemoteSecurityOptions,
  RemoteStatus,
  RemoteTier,
} from '../remote/remoteContract'

/** A minimal timer seam so tests can drive the simulator with fake timers. */
export interface TimerLike {
  setTimeout(handler: () => void, delay: number): unknown
  clearTimeout(handle: unknown): void
}

export interface RemoteSimulator {
  call(method: RemoteMethod, params: Record<string, unknown>): Promise<unknown>
  subscribe(listener: (event: { type: RemoteEventType; payload: unknown }) => void): () => void
  reset(seed?: RemoteSeed): void
  /** Preview-only: act as the phone finishing pairing with the current offer. */
  simulatePairingCompleted(device?: Partial<RemoteDevice>): RemoteDevice | null
  dispose(): void
}

export interface RemoteSeed {
  enabled?: boolean
  devices?: number
  host?: 'online' | 'offline'
  hosts?: number
}

const HOST_NAME = 'Work PC'
const RELAY = 'relay.bitbots.app'
const HOST_ID = 'work-pc'
const DIRECT_ADDRESS = '192.168.1.24:7843'
const CONNECT_DELAY_MS = 700
const JITTER_INTERVAL_MS = 5_000
const LATENCY_MIN_MS = 24
const LATENCY_MAX_MS = 60
const ACTIVITY_LIMIT = 50
const DEVICE_NAME_MAX = 40

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

/** A screen the user can see in the client even though it is a host fixture. */
const HOST_PRESETS: readonly Omit<RemoteHost, 'state' | 'lastSeenAt'>[] = [
  { id: 'host-work', name: 'Work PC', os: 'windows', botCount: 5, waitingCount: 1, tier: 'chat' },
  { id: 'host-home', name: 'Home laptop', os: 'windows', botCount: 3, waitingCount: 0, tier: 'chat' },
  { id: 'host-studio', name: 'Studio Mac', os: 'macos', botCount: 2, waitingCount: 0, tier: 'viewer' },
]

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

export function createRemoteSimulator(options: {
  now?: () => number
  random?: () => number
  timers?: TimerLike
} = {}): RemoteSimulator {
  const nowFn = options.now ?? (() => Date.now())
  const randomFn = options.random ?? (() => Math.random())
  const timers = options.timers ?? defaultTimers

  let enabled = false
  let link: RemoteLinkState = 'off'
  let latencyMs: number | null = null
  let since: string | null = null
  let direct = false
  let error: string | null = null
  let devices: RemoteDevice[] = []
  let offer: PairingOffer | null = null
  let security: RemoteSecurityOptions = cloneSecurity(DEFAULT_REMOTE_SECURITY)
  let activity: RemoteActivityEntry[] = []
  let hosts: RemoteHost[] = []
  let activeHostId: string | null = null
  let deviceSerial = 0
  let activitySerial = 0

  let connectTimer: unknown = null
  let jitterTimer: unknown = null
  let offerTimer: unknown = null

  const listeners = new Set<(event: { type: RemoteEventType; payload: unknown }) => void>()

  const iso = (ms: number) => new Date(ms).toISOString()
  const nowIso = () => iso(nowFn())
  const randInt = (min: number, max: number) => {
    const span = max - min + 1
    const offset = Math.min(span - 1, Math.max(0, Math.floor(randomFn() * span)))
    return min + offset
  }
  const emit = (type: RemoteEventType, payload: unknown) => {
    const event = { type, payload }
    for (const listener of [...listeners]) listener(event)
  }
  const cancel = (handle: unknown) => { if (handle !== null) timers.clearTimeout(handle) }

  function status(): RemoteStatus {
    return {
      enabled,
      link,
      hostName: HOST_NAME,
      relay: RELAY,
      latencyMs,
      since,
      direct,
      directAddress: direct ? DIRECT_ADDRESS : null,
      deviceCount: devices.length,
      connectedCount: devices.filter((device) => device.online).length,
      keepAwake: enabled,
      error,
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

  function buildHosts(hostState: 'online' | 'offline', count: number) {
    const wanted = Math.max(0, Math.floor(count))
    hosts = []
    for (let index = 0; index < wanted; index += 1) {
      const base = HOST_PRESETS[index]
      if (base) {
        const state = index === 0 && hostState === 'offline' ? 'offline' : index === 1 ? 'asleep' : index === 2 ? 'offline' : 'online'
        const lastSeenAt = state === 'online'
          ? nowIso()
          : state === 'asleep'
            ? iso(nowFn() - 2 * 3_600_000)
            : index === 0 ? iso(nowFn() - 25 * 60_000) : iso(nowFn() - 26 * 3_600_000)
        hosts.push({ ...base, state, lastSeenAt })
      } else {
        hosts.push({ id: `host-extra-${index}`, name: `Desk ${index}`, os: 'linux', state: 'offline', lastSeenAt: iso(nowFn() - 48 * 3_600_000), botCount: 0, waitingCount: 0, tier: 'viewer' })
      }
    }
    activeHostId = hosts[0]?.id ?? null
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

  function startJitter() {
    cancel(jitterTimer)
    const tick = () => {
      jitterTimer = null
      if (!enabled || link !== 'online') return
      latencyMs = randInt(LATENCY_MIN_MS, LATENCY_MAX_MS)
      emit('remote.changed', status())
      jitterTimer = timers.setTimeout(tick, JITTER_INTERVAL_MS)
    }
    jitterTimer = timers.setTimeout(tick, JITTER_INTERVAL_MS)
  }

  function enable(): RemoteStatus {
    if (enabled && link === 'online') return status()
    enabled = true
    error = null
    cancel(connectTimer)
    link = 'connecting'
    latencyMs = null
    since = null
    emit('remote.changed', status())
    connectTimer = timers.setTimeout(() => {
      connectTimer = null
      if (!enabled) return
      link = 'online'
      latencyMs = randInt(LATENCY_MIN_MS, LATENCY_MAX_MS)
      since = nowIso()
      emit('remote.changed', status())
      startJitter()
    }, CONNECT_DELAY_MS)
    return status()
  }

  function disable(): RemoteStatus {
    cancel(connectTimer)
    connectTimer = null
    cancel(jitterTimer)
    jitterTimer = null
    enabled = false
    link = 'off'
    latencyMs = null
    since = null
    error = null
    for (const device of devices) {
      if (!device.online) continue
      device.online = false
      device.lastSeenAt = nowIso()
      emit('remote.device.changed', { device: { ...device }, change: 'updated' })
    }
    emit('remote.changed', status())
    return status()
  }

  function pairBegin(): PairingOffer {
    if (!enabled) throw remoteError('remote_disabled', 'Remote access is off.')
    cancel(offerTimer)
    const code = generateCode()
    const created: PairingOffer = {
      code,
      qrPayload: `bitbots://pair?r=${RELAY}&c=${code}&h=${HOST_ID}`,
      expiresAt: iso(nowFn() + PAIRING_CODE_TTL_MS),
      relay: RELAY,
    }
    offer = created
    offerTimer = timers.setTimeout(() => {
      offerTimer = null
      if (offer && offer.code === code) offer = null
    }, PAIRING_CODE_TTL_MS)
    return { ...created }
  }

  function pairCancel() {
    cancel(offerTimer)
    offerTimer = null
    offer = null
    return { cancelled: true }
  }

  function simulatePairingCompleted(partial: Partial<RemoteDevice> = {}): RemoteDevice | null {
    if (!offer || nowFn() >= Date.parse(offer.expiresAt)) {
      cancel(offerTimer)
      offerTimer = null
      offer = null
      return null
    }
    cancel(offerTimer)
    offerTimer = null
    offer = null
    deviceSerial += 1
    const preset = DEVICE_PRESETS[0]
    const device: RemoteDevice = {
      id: `device-${deviceSerial}`,
      name: preset.name,
      kind: preset.kind,
      platform: preset.platform,
      tier: preset.tier,
      pairedAt: nowIso(),
      lastSeenAt: nowIso(),
      online: true,
      ...partial,
    }
    devices.push(device)
    const entry = activityEntry('paired', device.id, device.name, `${device.name} paired`)
    pushActivity(entry)
    emit('remote.pairing.completed', { device: { ...device } })
    emit('remote.device.changed', { device: { ...device }, change: 'added' })
    emit('remote.activity', { entry })
    emit('remote.changed', status())
    return { ...device }
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
    if (changed) emit('remote.device.changed', { device: { ...device }, change: 'updated' })
    return { ...device }
  }

  function revokeDevice(params: Record<string, unknown>) {
    const id = String(params.deviceId ?? '')
    const index = devices.findIndex((item) => item.id === id)
    if (index < 0) throw remoteError('not_found', 'That device is no longer paired.')
    const [removed] = devices.splice(index, 1)
    const entry = activityEntry('revoked', removed.id, removed.name, `${removed.name} was removed`)
    pushActivity(entry)
    emit('remote.device.changed', { device: { ...removed }, change: 'removed' })
    emit('remote.activity', { entry })
    emit('remote.changed', status())
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
        emit('remote.device.changed', { device: { ...device }, change: 'updated' })
      }
      const entry = activityEntry('approval', '', HOST_NAME, 'Approvals from remote turned off')
      pushActivity(entry)
      emit('remote.activity', { entry })
    }
    return cloneSecurity(security)
  }

  function setDirect(params: Record<string, unknown>): RemoteStatus {
    if (typeof params.enabled !== 'boolean') throw remoteError('invalid_argument', 'enabled must be a boolean.')
    direct = params.enabled
    emit('remote.changed', status())
    return status()
  }

  function selectHost(params: Record<string, unknown>): RemoteHost {
    const id = String(params.hostId ?? '')
    const host = hosts.find((item) => item.id === id)
    if (!host) throw remoteError('not_found', 'That computer is not paired.')
    activeHostId = host.id
    emit('remote.host.changed', { hostId: host.id, host: { ...host }, activeHostId })
    return { ...host }
  }

  function reset(seed: RemoteSeed = {}) {
    cancel(connectTimer)
    connectTimer = null
    cancel(jitterTimer)
    jitterTimer = null
    cancel(offerTimer)
    offerTimer = null
    enabled = seed.enabled ?? false
    link = enabled ? 'online' : 'off'
    latencyMs = enabled ? randInt(LATENCY_MIN_MS, LATENCY_MAX_MS) : null
    since = enabled ? nowIso() : null
    direct = false
    error = null
    offer = null
    security = cloneSecurity(DEFAULT_REMOTE_SECURITY)
    activity = []
    activitySerial = 0
    const count = Math.max(0, Math.floor(seed.devices ?? 0))
    devices = Array.from({ length: count }, (_, index) => createSeedDevice(index))
    deviceSerial = count
    buildHosts(seed.host ?? 'online', seed.hosts ?? 3)
    if (enabled) startJitter()
  }

  async function call(method: RemoteMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    switch (method) {
      case 'remote.status': return status()
      case 'remote.enable': return enable()
      case 'remote.disable': return disable()
      case 'remote.pair.begin': return pairBegin()
      case 'remote.pair.cancel': return pairCancel()
      case 'remote.devices.list': return devices.map((device) => ({ ...device }))
      case 'remote.devices.update': return updateDevice(params)
      case 'remote.devices.revoke': return revokeDevice(params)
      case 'remote.security.get': return cloneSecurity(security)
      case 'remote.security.set': return setSecurity(params)
      case 'remote.activity.list': return activity.map((entry) => ({ ...entry }))
      case 'remote.direct.set': return setDirect(params)
      case 'remote.hosts.list': return hosts.map((host) => ({ ...host }))
      case 'remote.hosts.select': return selectHost(params)
      default: throw remoteError('unsupported', `Unknown remote method ${String(method)}.`)
    }
  }

  function dispose() {
    cancel(connectTimer)
    connectTimer = null
    cancel(jitterTimer)
    jitterTimer = null
    cancel(offerTimer)
    offerTimer = null
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
    simulatePairingCompleted,
    dispose,
  }
}
