// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createPreviewDeviceApi, PREVIEW_PASSPHRASE, codeFromHash, describeThisDevice } from './deviceApi'

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

describe('preview device sign-in', () => {
  const input = { username: 'owner', password: PREVIEW_PASSPHRASE, name: 'Pixel 8', kind: 'phone' as const, platform: 'Android, Chrome' }

  it('accepts any username with the preview passphrase, then approves like a pairing request', async () => {
    localStorage.clear()
    const api = createPreviewDeviceApi({ approveAfterMs: 0, method: 'native' })
    expect(await api.login({ ...input, username: 'anyone' })).toEqual({ state: 'pending' })
    expect(await api.pairStatus()).toBe('approved')
    expect((await api.me()).method).toBe('native')
  })

  it('refuses any other password', async () => {
    localStorage.clear()
    const api = createPreviewDeviceApi()
    await expect(api.login({ ...input, password: 'wrong' })).rejects.toMatchObject({ code: 'login_invalid' })
  })

  it('carries the method on a refused me()', async () => {
    localStorage.clear()
    const api = createPreviewDeviceApi({ method: 'native' })
    await expect(api.me()).rejects.toMatchObject({ code: 'unauthorized', method: 'native' })
  })

  it('reports Tailscale by default', async () => {
    localStorage.clear()
    const api = createPreviewDeviceApi({ approveAfterMs: 0 })
    await api.login(input)
    await api.pairStatus()
    expect((await api.me()).method).toBe('tailscale')
  })
})
