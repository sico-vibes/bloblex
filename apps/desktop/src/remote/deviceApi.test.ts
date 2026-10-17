import { describe, expect, it } from 'vitest'
import { codeFromHash, describeThisDevice } from './deviceApi'

describe('device helpers', () => {
  it('reads a scanned code from the address and describes the device', () => {
    expect(codeFromHash('#pair=k7qm4xpd')).toBe('K7QM4XPD')
    expect(codeFromHash('#other=1&pair=K7QM-4XPD')).toBe('K7QM-4XPD')
    expect(codeFromHash('')).toBe('')
    expect(describeThisDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit Version/18.0 Mobile/15E148 Safari/604.1')).toEqual({ kind: 'phone', platform: 'iOS, Safari' })
    expect(describeThisDevice('Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit Chrome/129.0 Mobile Safari/537.36')).toEqual({ kind: 'phone', platform: 'Android, Chrome' })
    expect(describeThisDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit Chrome/129.0 Safari/537.36 Edg/129.0')).toEqual({ kind: 'browser', platform: 'Windows, Edge' })
  })
})
