import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAIRING_CODE_TTL_MS, PAIRING_MAX_ATTEMPTS, REMOTE_EVENTS, REMOTE_METHODS } from '../remote/remoteContract'
import type {
  PairingOffer,
  PairingRequest,
  RemoteActivityEntry,
  RemoteDevice,
  RemoteEventType,
  RemoteSecurityOptions,
  RemoteStatus,
  RemoteTailscaleState,
} from '../remote/remoteContract'
import { createRemoteSimulator } from './remoteFixture'
import type { RemoteSimulator } from './remoteFixture'

const BASE_TIME = Date.parse('2026-10-15T09:00:00.000Z')
const SERVE_URL = 'https://work-pc.tail1234.ts.net'

let simulator: RemoteSimulator
let events: Array<{ type: RemoteEventType; payload: unknown }>

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(BASE_TIME)
  simulator = createRemoteSimulator()
  events = []
  simulator.subscribe((event) => events.push(event))
})

afterEach(() => {
  simulator.dispose()
  vi.useRealTimers()
})

const status = async () => await simulator.call('remote.status', {}) as RemoteStatus
const devices = async () => (await simulator.call('remote.devices.list', {}) as { devices: RemoteDevice[] }).devices
const activity = async () => (await simulator.call('remote.activity.list', {}) as { entries: RemoteActivityEntry[] }).entries
const types = () => events.map((event) => event.type)

describe('remote preview simulator (host side)', () => {
  it('walks the enable timeline from starting to online on the serve address', async () => {
    const starting = await simulator.call('remote.enable', {}) as RemoteStatus
    expect(starting.enabled).toBe(true)
    expect(starting.link).toBe('starting')
    expect(starting.url).toBeNull()
    expect(starting.servePort).toBeNull()

    await vi.advanceTimersByTimeAsync(699)
    expect((await status()).link).toBe('starting')
    await vi.advanceTimersByTimeAsync(1)
    const online = await status()
    expect(online.link).toBe('online')
    expect(online.url).toBe(SERVE_URL)
    expect(online.servePort).toBe(443)
    expect(online.tailscale).toBe('ready')
    expect(types()).toContain('remote.changed')
  })

  it('refuses to enable, and says why, for every Tailscale state but ready', async () => {
    const states: Record<Exclude<RemoteTailscaleState, 'ready'>, RegExp> = {
      not_installed: /install tailscale/i,
      starting: /starting/i,
      not_running: /not running/i,
      logged_out: /sign in/i,
      https_disabled: /HTTPS certificates are off/i,
      port_in_use: /443 and 8443/i,
      funnel_on: /Funnel is on/i,
    }
    for (const [state, message] of Object.entries(states)) {
      simulator.reset({ tailscale: state as RemoteTailscaleState })
      const seeded = await status()
      expect(seeded.tailscale).toBe(state)
      expect(seeded.enabled).toBe(false)
      expect(seeded.link).toBe('off')
      expect(seeded.url).toBeNull()
      await expect(simulator.call('remote.enable', {})).rejects.toThrow('unsupported')
      await expect(simulator.call('remote.enable', {})).rejects.toThrow(message)
      // Nothing changed: enabling a non-ready host leaves it off.
      expect((await status()).enabled).toBe(false)
    }
  })

  it('reports host identity and keeps the device list after disable', async () => {
    simulator.reset({ enabled: true, devices: 3 })
    const reading = await status()
    expect(reading.hostName).toBe('Work PC')
    expect(reading.url).toBe(SERVE_URL)
    expect(reading.port).toBe(48620)
    expect(reading.servePort).toBe(443)
    expect(reading.deviceCount).toBe(3)
    expect(reading.connectedCount).toBe(3)
    expect(reading.link).toBe('online')
    expect(reading.keepAwake).toBe(true)

    const disabled = await simulator.call('remote.disable', {}) as RemoteStatus
    expect(disabled.link).toBe('off')
    expect(disabled.url).toBeNull()
    expect(disabled.servePort).toBeNull()
    expect(disabled.connectedCount).toBe(0)
    expect(disabled.deviceCount).toBe(3)
    const list = await devices()
    expect(list).toHaveLength(3)
    expect(list.every((device) => device.online === false)).toBe(true)
    expect(events.filter((event) => event.type === 'remote.device.changed')).toHaveLength(3)
  })

  it('mints an unambiguous grouped pairing code with attempts left that expires after the TTL', async () => {
    simulator.reset({ enabled: true })
    const offer = await simulator.call('remote.pair.begin', {}) as PairingOffer
    expect(offer.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    expect(offer.code).not.toMatch(/[0O1I]/)
    expect(offer.url).toBe(SERVE_URL)
    expect(offer.qrPayload).toBe(SERVE_URL)
    expect(offer.attemptsLeft).toBe(PAIRING_MAX_ATTEMPTS)
    expect(Date.parse(offer.expiresAt) - BASE_TIME).toBe(PAIRING_CODE_TTL_MS)

    await vi.advanceTimersByTimeAsync(PAIRING_CODE_TTL_MS)
    expect(simulator.simulatePhoneRequest()).toBeNull()
  })

  it('counts wrong codes and burns the offer after five of them', async () => {
    simulator.reset({ enabled: true })
    const offer = await simulator.call('remote.pair.begin', {}) as PairingOffer
    // Four wrong attempts leave the offer alive: the right code still locks it.
    for (let attempt = 1; attempt < PAIRING_MAX_ATTEMPTS; attempt += 1) {
      expect(() => simulator.simulatePhoneRequest({ code: 'WRNG-WRNG' })).toThrow('pairing_invalid')
    }
    expect(simulator.simulatePhoneRequest({ code: offer.code })).not.toBeNull()

    // The fifth wrong attempt burns it: even the right code is refused, and no
    // request is raised.
    simulator.reset({ enabled: true, devices: 0 })
    events.length = 0
    const second = await simulator.call('remote.pair.begin', {}) as PairingOffer
    for (let attempt = 1; attempt <= PAIRING_MAX_ATTEMPTS; attempt += 1) {
      expect(() => simulator.simulatePhoneRequest({ code: 'WRNG-WRNG' })).toThrow('pairing_invalid')
    }
    expect(simulator.simulatePhoneRequest({ code: second.code })).toBeNull()
    expect(events.filter((event) => event.type === 'remote.pairing.requested')).toHaveLength(0)
  })

  it('accepts the right code case-insensitively and without the group dash', async () => {
    simulator.reset({ enabled: true })
    const offer = await simulator.call('remote.pair.begin', {}) as PairingOffer
    const request = simulator.simulatePhoneRequest({ code: offer.code.toLowerCase().replace('-', '') })
    expect(request?.pairingId).toBeTruthy()
  })

  it('replaces a live offer with the newest one and refuses to pair while disabled', async () => {
    simulator.reset({})
    await expect(simulator.call('remote.pair.begin', {})).rejects.toMatchObject({ code: 'conflict' })

    simulator.reset({ enabled: true })
    const first = await simulator.call('remote.pair.begin', {}) as PairingOffer
    await vi.advanceTimersByTimeAsync(1_000)
    const second = await simulator.call('remote.pair.begin', {}) as PairingOffer
    expect(Date.parse(second.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt))
    // The newest offer is the live one; the old code now counts a wrong attempt.
    expect(() => simulator.simulatePhoneRequest({ code: first.code })).toThrow('pairing_invalid')
    expect(simulator.simulatePhoneRequest({ code: second.code })).not.toBeNull()

    simulator.reset({ enabled: true })
    await simulator.call('remote.pair.begin', {})
    await simulator.call('remote.pair.cancel', {})
    expect(simulator.simulatePhoneRequest()).toBeNull()
  })

  it('raises the request when the phone submits the right code, and only then', async () => {
    simulator.reset({ enabled: true, devices: 0 })
    await simulator.call('remote.pair.begin', {})
    events.length = 0
    const request = simulator.simulatePhoneRequest({ name: 'Kitchen iPad', kind: 'tablet', platform: 'iPadOS 18, Safari', login: null }) as PairingRequest
    expect(request).toMatchObject({ name: 'Kitchen iPad', kind: 'tablet', platform: 'iPadOS 18, Safari', login: null })
    expect(request.pairingId).toBeTruthy()
    expect(Date.parse(request.expiresAt) - BASE_TIME).toBe(PAIRING_CODE_TTL_MS)
    expect(types()).toContain('remote.pairing.requested')
    const raised = events.find((event) => event.type === 'remote.pairing.requested')?.payload as PairingRequest
    expect(raised).toEqual(request)
    // The offer is spent: the same phone cannot lock it twice.
    expect(simulator.simulatePhoneRequest()).toBeNull()
    // Nothing is paired until the owner decides.
    expect(await devices()).toHaveLength(0)
  })

  it('creates the device with the chosen tier only after the owner approves', async () => {
    simulator.reset({ enabled: true, devices: 0 })
    const offer = await simulator.call('remote.pair.begin', {}) as PairingOffer
    const request = simulator.simulatePhoneRequest({ code: offer.code }) as PairingRequest
    events.length = 0

    await expect(simulator.call('remote.pair.confirm', { pairingId: request.pairingId })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(simulator.call('remote.pair.confirm', { pairingId: request.pairingId, approve: true })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(simulator.call('remote.pair.confirm', { pairingId: request.pairingId, approve: true, tier: 'root' })).rejects.toMatchObject({ code: 'invalid_argument' })

    const approved = await simulator.call('remote.pair.confirm', { pairingId: request.pairingId, approve: true, tier: 'operator' }) as { approved: boolean; device: RemoteDevice }
    expect(approved.approved).toBe(true)
    expect(approved.device).toMatchObject({ name: 'Pixel 8', kind: 'phone', platform: 'Android 15, Chrome', tier: 'operator', online: true })
    const completed = events.find((event) => event.type === 'remote.pairing.completed')?.payload as { pairingId: string; outcome: string; deviceId?: string }
    expect(completed).toMatchObject({ pairingId: request.pairingId, outcome: 'approved' })
    expect(completed.deviceId).toBe(approved.device.id)
    expect(events.find((event) => event.type === 'remote.device.changed')?.payload).toMatchObject({ action: 'added' })
    const list = await devices()
    expect(list).toHaveLength(1)
    const entries = await activity()
    expect(entries[0]).toMatchObject({ kind: 'paired' })
    expect(entries[0]?.summary).toContain('Pixel 8')
    expect(entries[0]?.summary).not.toMatch(/\n/)
    // The request is spent.
    await expect(simulator.call('remote.pair.confirm', { pairingId: request.pairingId, approve: true, tier: 'chat' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('burns the request when the owner rejects it', async () => {
    simulator.reset({ enabled: true, devices: 0 })
    await simulator.call('remote.pair.begin', {})
    const request = simulator.simulatePhoneRequest() as PairingRequest
    events.length = 0
    const rejected = await simulator.call('remote.pair.confirm', { pairingId: request.pairingId, approve: false }) as { approved: boolean }
    expect(rejected.approved).toBe(false)
    expect(events.find((event) => event.type === 'remote.pairing.completed')?.payload).toMatchObject({ pairingId: request.pairingId, outcome: 'burned' })
    expect(await devices()).toHaveLength(0)
    expect((await activity())[0]).toMatchObject({ kind: 'denied' })
    await expect(simulator.call('remote.pair.confirm', { pairingId: request.pairingId, approve: true, tier: 'chat' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('expires a waiting request and reports it', async () => {
    simulator.reset({ enabled: true, devices: 0 })
    await simulator.call('remote.pair.begin', {})
    const request = simulator.simulatePhoneRequest() as PairingRequest
    events.length = 0
    await vi.advanceTimersByTimeAsync(PAIRING_CODE_TTL_MS)
    expect(events.find((event) => event.type === 'remote.pairing.completed')?.payload).toMatchObject({ pairingId: request.pairingId, outcome: 'expired' })
    await expect(simulator.call('remote.pair.confirm', { pairingId: request.pairingId, approve: true, tier: 'chat' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('cancels a waiting request as its own outcome', async () => {
    simulator.reset({ enabled: true, devices: 0 })
    await simulator.call('remote.pair.begin', {})
    const request = simulator.simulatePhoneRequest() as PairingRequest
    events.length = 0
    await simulator.call('remote.pair.cancel', {})
    expect(events.find((event) => event.type === 'remote.pairing.completed')?.payload).toMatchObject({ pairingId: request.pairingId, outcome: 'cancelled' })
    expect(await devices()).toHaveLength(0)
  })

  it('downgrades operator devices when approvals from remote is turned off', async () => {
    simulator.reset({ enabled: true, devices: 3 })
    const defaults = await simulator.call('remote.security.get', {}) as RemoteSecurityOptions
    expect(defaults).toEqual({ approvalsFromRemote: false, idleExpiryDays: 30, quietHours: { enabled: false, from: '22:00', to: '07:00' } })

    const before = await devices()
    expect(before.find((device) => device.id === 'device-3')?.tier).toBe('operator')

    const permissive = await simulator.call('remote.security.set', { approvalsFromRemote: true }) as RemoteSecurityOptions
    expect(permissive.approvalsFromRemote).toBe(true)
    events.length = 0

    const locked = await simulator.call('remote.security.set', { approvalsFromRemote: false }) as RemoteSecurityOptions
    expect(locked.approvalsFromRemote).toBe(false)
    const after = await devices()
    expect(after.find((device) => device.id === 'device-3')?.tier).toBe('chat')
    expect(events.filter((event) => event.type === 'remote.device.changed')).toHaveLength(1)
    expect((await activity())[0]?.summary).toBe('Approvals from remote turned off')
  })

  it('updates and revokes a device and rejects unknown ids and bad input', async () => {
    simulator.reset({ enabled: true, devices: 3 })
    const updated = await simulator.call('remote.devices.update', { deviceId: 'device-2', name: '  Kitchen iPad  ', tier: 'operator' }) as RemoteDevice
    expect(updated.name).toBe('Kitchen iPad')
    expect(updated.tier).toBe('operator')

    await expect(simulator.call('remote.devices.update', { deviceId: 'nope', tier: 'chat' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(simulator.call('remote.devices.update', { deviceId: 'device-2', tier: 'root' })).rejects.toThrow('invalid_argument')
    await expect(simulator.call('remote.devices.update', { deviceId: 'device-2', name: '' })).rejects.toThrow('invalid_argument')
    await expect(simulator.call('remote.devices.update', { deviceId: 'device-2', name: 'x'.repeat(41) })).rejects.toThrow('invalid_argument')

    events.length = 0
    const revoked = await simulator.call('remote.devices.revoke', { deviceId: 'device-2' }) as { revoked: boolean }
    expect(revoked.revoked).toBe(true)
    expect((await devices()).map((device) => device.id)).toEqual(['device-1', 'device-3'])
    expect(events.filter((event) => event.type === 'remote.device.changed')).toHaveLength(1)
    expect(events.find((event) => event.type === 'remote.device.changed')?.payload).toMatchObject({ action: 'removed' })
    expect((await activity())[0]?.kind).toBe('revoked')
    await expect(simulator.call('remote.devices.revoke', { deviceId: 'gone' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('keeps activity newest-first and caps it at fifty', async () => {
    simulator.reset({ enabled: true, devices: 0 })
    for (let index = 0; index < 60; index += 1) {
      await simulator.call('remote.pair.begin', {})
      const request = simulator.simulatePhoneRequest({ name: `Phone ${index}` }) as PairingRequest
      await simulator.call('remote.pair.confirm', { pairingId: request.pairingId, approve: true, tier: 'chat' })
    }
    const entries = await activity()
    expect(entries).toHaveLength(50)
    expect(entries[0]?.id).toBe('activity-60')
    expect(entries[0]?.summary).toBe('Phone 59 paired')
    expect(entries[0]?.deviceName).toBe('Phone 59')
    expect(entries.at(-1)?.summary).toBe('Phone 10 paired')
    expect(entries.every((entry, index) => index === 0 || entry.at <= entries[index - 1].at)).toBe(true)
  })

  it('answers every method the contract lists', async () => {
    const asked: string[] = []
    for (const method of REMOTE_METHODS) {
      simulator.reset({ enabled: true, devices: 1 })
      let params: Record<string, unknown> = {}
      if (method === 'remote.pair.confirm') {
        await simulator.call('remote.pair.begin', {})
        const locked = simulator.simulatePhoneRequest() as PairingRequest
        params = { pairingId: locked.pairingId, approve: true, tier: 'chat' }
      } else if (method === 'remote.devices.update' || method === 'remote.devices.revoke') {
        params = { deviceId: 'device-1', tier: 'viewer' }
      } else if (method === 'remote.method.set') {
        simulator.reset({ enabled: false, devices: 1 })
        params = { method: 'native' }
      } else if (method === 'remote.native.account.set') {
        params = { username: 'owner', password: 'correct horse battery' }
      } else if (method === 'remote.native.port.set') {
        simulator.reset({ enabled: false, devices: 1 })
        params = { port: 49000 }
      }
      await expect(simulator.call(method, params), method).resolves.toBeDefined()
      asked.push(method)
    }
    expect(asked).toEqual([...REMOTE_METHODS])
  })

  it('emits every event the contract lists', async () => {
    simulator.reset({ enabled: true, devices: 1 })
    await simulator.call('remote.pair.begin', {})
    const locked = simulator.simulatePhoneRequest() as PairingRequest
    await simulator.call('remote.pair.confirm', { pairingId: locked.pairingId, approve: true, tier: 'chat' })
    await simulator.call('remote.devices.revoke', { deviceId: 'device-1' })
    for (const type of REMOTE_EVENTS) expect(types(), type).toContain(type)
  })

  it('rejects an unknown method', async () => {
    await expect(simulator.call('remote.hosts.list' as never, {})).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('stops timers and listeners on dispose', async () => {
    simulator.reset({ enabled: true })
    let calls = 0
    const unsubscribe = simulator.subscribe(() => { calls += 1 })
    unsubscribe()
    simulator.dispose()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
