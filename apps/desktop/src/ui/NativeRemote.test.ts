import { describe, expect, it } from 'vitest'
import type { RemoteNativeStatus } from '../remote/remoteContract'
import { accountProblem, connectSteps, looksLikeAddress, outsideUrl } from './NativeRemote'

describe('native remote sign-in rules', () => {
  it('asks for a username, a long enough password that is not the username, typed twice', () => {
    expect(accountProblem('', 'x'.repeat(12), 'x'.repeat(12))).toBe('Choose a username.')
    expect(accountProblem('basem', 'short', 'short')).toContain('at least 12')
    expect(accountProblem('basem-is-long', 'basem-is-long', 'basem-is-long')).toBe('The password can’t be the username.')
    expect(accountProblem('basem', 'correct horse battery', 'correct horse batterz')).toBe('The two passwords don’t match.')
    expect(accountProblem('basem', 'correct horse battery', 'correct horse battery')).toBeNull()
  })
})

const base: RemoteNativeStatus = {
  port: 48621, urls: ['https://192.168.1.20:48621', 'https://203.0.113.7:48621'], fingerprint: 'AB:CD', accountSet: true, username: 'owner', listening: true,
  loginPaused: false, pausedUntil: null, lastReachedAt: null, lastReachedFrom: null,
  upnp: { consent: false, state: 'off' }, firewall: 'missing', externalIp: null, externalIpSource: null, cgnat: false,
}
const step = (native: Partial<RemoteNativeStatus>, id: string, on = true) => connectSteps({ ...base, ...native }, on).find((item) => item.id === id)

describe('native remote connection steps', () => {
  it('walks the router from manual forwarding to a mapped port, and says why it failed', () => {
    expect(step({}, 'router')).toMatchObject({ tone: 'todo', detail: expect.stringContaining('Forward TCP port 48621') })
    expect(step({ upnp: { consent: true, state: 'mapped' } }, 'router')).toMatchObject({ tone: 'ok', title: 'Your router forwards port 48621' })
    expect(step({ upnp: { consent: true, state: 'no_gateway' } }, 'router')).toMatchObject({ tone: 'warn', title: 'No router answered' })
    expect(step({ upnp: { consent: true, state: 'failed', error: 'ConflictInMappingEntry' } }, 'router')?.detail).toContain('“ConflictInMappingEntry”')
    expect(step({ upnp: { consent: true, state: 'off' } }, 'router', false)?.detail).toContain('when Remote turns on')
  })

  it('shows the firewall only where it applies', () => {
    expect(step({ firewall: 'allowed' }, 'firewall')?.tone).toBe('ok')
    expect(step({ firewall: 'missing' }, 'firewall')?.tone).toBe('warn')
    expect(step({ firewall: 'unsupported' }, 'firewall')).toBeUndefined()
  })

  it('warns about carrier NAT and private addresses, and names where a public one came from', () => {
    expect(step({ externalIp: '100.72.1.9', cgnat: true, cgnatReason: 'carrier_nat' }, 'address')).toMatchObject({ tone: 'warn', detail: expect.stringContaining('Use Tailscale instead') })
    expect(step({ externalIp: '192.168.1.1', cgnat: true, cgnatReason: 'private' }, 'address')?.title).toBe('That address is private')
    expect(step({ externalIp: '203.0.113.7', externalIpSource: 'manual' }, 'address')).toMatchObject({ tone: 'ok', detail: expect.stringContaining('Entered by you') })
    expect(step({}, 'address')?.title).toBe('Public address unknown')
  })

  it('tests from outside only while Remote is on, and a reach from home is not proof', () => {
    expect(step({}, 'test', false)).toBeUndefined()
    expect(step({ externalIp: '203.0.113.7' }, 'test')?.detail).toContain('https://203.0.113.7:48621/api/ping')
    expect(step({ lastReachedAt: '2026-10-17T20:00:00Z', lastReachedFrom: 'this network' }, 'test')?.title).toBe('Reached from this network only')
    expect(step({ lastReachedAt: '2026-10-17T20:00:00Z', lastReachedFrom: '198.51.100.4' }, 'test')).toMatchObject({ tone: 'ok', title: 'Reached from 198.51.100.4' })
  })

  it('picks the public address for the phone and checks typed addresses', () => {
    expect(outsideUrl({ ...base, externalIp: '203.0.113.7' })).toBe('https://203.0.113.7:48621')
    expect(outsideUrl(base)).toBe('https://192.168.1.20:48621')
    expect(looksLikeAddress(' 203.0.113.7 ')).toBe(true)
    expect(looksLikeAddress('203.0.113.700')).toBe(false)
    expect(looksLikeAddress('2001:db8::1')).toBe(true)
    expect(looksLikeAddress('example.com')).toBe(false)
  })
})
