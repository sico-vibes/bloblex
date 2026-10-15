import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAIRING_CODE_TTL_MS } from '../remote/remoteContract'
import type {
  PairingOffer,
  RemoteActivityEntry,
  RemoteDevice,
  RemoteEventType,
  RemoteHost,
  RemoteSecurityOptions,
  RemoteStatus,
} from '../remote/remoteContract'
import { createRemoteSimulator } from './remoteFixture'
import type { RemoteSimulator } from './remoteFixture'

const BASE_TIME = Date.parse('2026-10-15T09:00:00.000Z')

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

describe('remote preview simulator (host side)', () => {
  it('walks the enable timeline and jitters latency while online', async () => {
    const connecting = await simulator.call('remote.enable', {}) as RemoteStatus
    expect(connecting.enabled).toBe(true)
    expect(connecting.link).toBe('connecting')
    expect(connecting.latencyMs).toBeNull()

    await vi.advanceTimersByTimeAsync(699)
    expect(((await simulator.call('remote.status', {})) as RemoteStatus).link).toBe('connecting')
    await vi.advanceTimersByTimeAsync(1)
    const online = await simulator.call('remote.status', {}) as RemoteStatus
    expect(online.link).toBe('online')
    expect(online.latencyMs).toBeGreaterThanOrEqual(24)
    expect(online.latencyMs).toBeLessThanOrEqual(60)
    expect(online.since).not.toBeNull()

    const changedBefore = events.filter((event) => event.type === 'remote.changed').length
    await vi.advanceTimersByTimeAsync(5_000)
    const jittered = await simulator.call('remote.status', {}) as RemoteStatus
    expect(jittered.latencyMs).toBeGreaterThanOrEqual(24)
    expect(jittered.latencyMs).toBeLessThanOrEqual(60)
    expect(events.filter((event) => event.type === 'remote.changed').length).toBeGreaterThan(changedBefore)
  })

  it('reports host identity and keeps the device list after disable', async () => {
    simulator.reset({ enabled: true, devices: 3 })
    const status = await simulator.call('remote.status', {}) as RemoteStatus
    expect(status.hostName).toBe('Work PC')
    expect(status.relay).toBe('relay.bitbots.app')
    expect(status.deviceCount).toBe(3)
    expect(status.connectedCount).toBe(3)
    expect(status.link).toBe('online')
    expect(status.keepAwake).toBe(true)

    const disabled = await simulator.call('remote.disable', {}) as RemoteStatus
    expect(disabled.link).toBe('off')
    expect(disabled.connectedCount).toBe(0)
    expect(disabled.deviceCount).toBe(3)
    const list = await simulator.call('remote.devices.list', {}) as RemoteDevice[]
    expect(list).toHaveLength(3)
    expect(list.every((device) => device.online === false)).toBe(true)
    expect(events.filter((event) => event.type === 'remote.device.changed')).toHaveLength(3)
  })

  it('mints an unambiguous grouped pairing code that expires after the TTL', async () => {
    simulator.reset({ enabled: true })
    const offer = await simulator.call('remote.pair.begin', {}) as PairingOffer
    expect(offer.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    expect(offer.code).not.toMatch(/[0O1I]/)
    expect(offer.relay).toBe('relay.bitbots.app')
    expect(offer.qrPayload).toBe(`bitbots://pair?r=relay.bitbots.app&c=${offer.code}&h=work-pc`)
    expect(Date.parse(offer.expiresAt) - BASE_TIME).toBe(PAIRING_CODE_TTL_MS)

    await vi.advanceTimersByTimeAsync(PAIRING_CODE_TTL_MS)
    expect(simulator.simulatePairingCompleted()).toBeNull()
  })

  it('replaces a live offer with the newest one and cancels on request', async () => {
    simulator.reset({ enabled: true })
    const first = await simulator.call('remote.pair.begin', {}) as PairingOffer
    await vi.advanceTimersByTimeAsync(1_000)
    const second = await simulator.call('remote.pair.begin', {}) as PairingOffer
    expect(Date.parse(second.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt))
    expect(simulator.simulatePairingCompleted()).not.toBeNull()

    await simulator.call('remote.pair.begin', {})
    await simulator.call('remote.pair.cancel', {})
    expect(simulator.simulatePairingCompleted()).toBeNull()
  })

  it('completes pairing with a default phone, logs activity and emits events', async () => {
    simulator.reset({ enabled: true, devices: 0 })
    await simulator.call('remote.pair.begin', {})
    events.length = 0
    const device = simulator.simulatePairingCompleted()
    expect(device).toMatchObject({ name: 'Pixel 8', kind: 'phone', tier: 'chat', online: true })
    expect(device?.id).toBeTruthy()
    const types = events.map((event) => event.type)
    expect(types).toContain('remote.pairing.completed')
    expect(types).toContain('remote.device.changed')
    const list = await simulator.call('remote.devices.list', {}) as RemoteDevice[]
    expect(list).toHaveLength(1)
    const activity = await simulator.call('remote.activity.list', {}) as RemoteActivityEntry[]
    expect(activity[0]).toMatchObject({ kind: 'paired' })
    expect(activity[0]?.summary).toContain('Pixel 8')
    expect(activity[0]?.summary).not.toMatch(/\n/)

    expect(simulator.simulatePairingCompleted()).toBeNull()
  })

  it('downgrades operator devices when approvals from remote is turned off', async () => {
    simulator.reset({ enabled: true, devices: 3 })
    const defaults = await simulator.call('remote.security.get', {}) as RemoteSecurityOptions
    expect(defaults).toEqual({ approvalsFromRemote: false, idleExpiryDays: 30, quietHours: { enabled: false, from: '22:00', to: '07:00' } })

    const before = await simulator.call('remote.devices.list', {}) as RemoteDevice[]
    expect(before.find((device) => device.id === 'device-3')?.tier).toBe('operator')

    const permissive = await simulator.call('remote.security.set', { approvalsFromRemote: true }) as RemoteSecurityOptions
    expect(permissive.approvalsFromRemote).toBe(true)
    events.length = 0

    const locked = await simulator.call('remote.security.set', { approvalsFromRemote: false }) as RemoteSecurityOptions
    expect(locked.approvalsFromRemote).toBe(false)
    const after = await simulator.call('remote.devices.list', {}) as RemoteDevice[]
    expect(after.find((device) => device.id === 'device-3')?.tier).toBe('chat')
    expect(events.filter((event) => event.type === 'remote.device.changed')).toHaveLength(1)
    const activity = await simulator.call('remote.activity.list', {}) as RemoteActivityEntry[]
    expect(activity[0]?.summary).toBe('Approvals from remote turned off')
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
    const list = await simulator.call('remote.devices.list', {}) as RemoteDevice[]
    expect(list.map((device) => device.id)).toEqual(['device-1', 'device-3'])
    expect(events.filter((event) => event.type === 'remote.device.changed')).toHaveLength(1)
    const activity = await simulator.call('remote.activity.list', {}) as RemoteActivityEntry[]
    expect(activity[0]?.kind).toBe('revoked')
    await expect(simulator.call('remote.devices.revoke', { deviceId: 'gone' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('keeps activity newest-first and caps it at fifty', async () => {
    simulator.reset({ enabled: true, devices: 0 })
    for (let index = 0; index < 60; index += 1) {
      await simulator.call('remote.pair.begin', {})
      simulator.simulatePairingCompleted({ name: `Phone ${index}` })
    }
    const activity = await simulator.call('remote.activity.list', {}) as RemoteActivityEntry[]
    expect(activity).toHaveLength(50)
    expect(activity[0]?.id).toBe('activity-60')
    expect(activity[0]?.summary).toBe('Phone 59 paired')
    expect(activity[0]?.deviceName).toBe('Phone 59')
    expect(activity.at(-1)?.summary).toBe('Phone 10 paired')
    expect(activity.every((entry, index) => index === 0 || entry.at <= activity[index - 1].at)).toBe(true)
  })

  it('toggles the direct address and refuses to pair while disabled', async () => {
    simulator.reset({})
    await expect(simulator.call('remote.pair.begin', {})).rejects.toMatchObject({ code: 'remote_disabled' })
    const on = await simulator.call('remote.direct.set', { enabled: true }) as RemoteStatus
    expect(on.direct).toBe(true)
    expect(on.directAddress).toBe('192.168.1.24:7843')
    const off = await simulator.call('remote.direct.set', { enabled: false }) as RemoteStatus
    expect(off.direct).toBe(false)
    expect(off.directAddress).toBeNull()
    await expect(simulator.call('remote.direct.set', { enabled: 'yes' })).rejects.toThrow('invalid_argument')
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

describe('remote preview simulator (client side)', () => {
  it('lists the paired computers and selects one, including an offline one', async () => {
    simulator.reset({ enabled: true, hosts: 3 })
    const hosts = await simulator.call('remote.hosts.list', {}) as RemoteHost[]
    expect(hosts.map((host) => host.name)).toEqual(['Work PC', 'Home laptop', 'Studio Mac'])
    expect(hosts[0]).toMatchObject({ state: 'online', tier: 'chat', botCount: 5, waitingCount: 1 })
    expect(hosts[1]?.state).toBe('asleep')
    expect(hosts[2]?.state).toBe('offline')

    events.length = 0
    const selected = await simulator.call('remote.hosts.select', { hostId: 'host-home' }) as RemoteHost
    expect(selected.state).toBe('asleep')
    expect(events.at(-1)).toMatchObject({ type: 'remote.host.changed', payload: { hostId: 'host-home', activeHostId: 'host-home' } })

    const offline = await simulator.call('remote.hosts.select', { hostId: 'host-studio' }) as RemoteHost
    expect(offline.state).toBe('offline')
    await expect(simulator.call('remote.hosts.select', { hostId: 'nope' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('shows the current host offline when seeded that way', async () => {
    simulator.reset({ enabled: true, hosts: 3, host: 'offline' })
    const hosts = await simulator.call('remote.hosts.list', {}) as RemoteHost[]
    expect(hosts[0]).toMatchObject({ name: 'Work PC', state: 'offline' })
  })
})
