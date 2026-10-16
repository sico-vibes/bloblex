import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../tauri', () => ({ rpc: mocks.rpc }))

import { CATALOG_FRESH_MS, fetchCached, invalidateCatalog, isStale, readCached, resetCatalogCacheForTests } from './catalogCache'

beforeEach(() => { resetCatalogCacheForTests(); mocks.rpc.mockReset() })
afterEach(() => { vi.useRealTimers() })

describe('catalog cache', () => {
  it('asks the daemon once for concurrent reads of one key and serves the answer from cache afterwards', async () => {
    let resolve!: (value: unknown) => void
    mocks.rpc.mockReturnValue(new Promise((done) => { resolve = done }))
    const first = fetchCached('runtime.models', { runtimeId: 'rt' })
    const second = fetchCached('runtime.models', { runtimeId: 'rt' })
    resolve({ models: [{ id: 'a' }] })
    await expect(first).resolves.toEqual({ models: [{ id: 'a' }] })
    await expect(second).resolves.toEqual({ models: [{ id: 'a' }] })
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    expect(readCached('runtime.models', { runtimeId: 'rt' })).toEqual({ models: [{ id: 'a' }] })
    await fetchCached('runtime.models', { runtimeId: 'rt' })
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  it('keys by every parameter but ignores empty ones and their order', async () => {
    mocks.rpc.mockResolvedValue({ ok: true })
    await fetchCached('runtime.capabilities', { runtimeId: 'rt', model: 'm', agentId: undefined })
    expect(readCached('runtime.capabilities', { model: 'm', runtimeId: 'rt' })).toEqual({ ok: true })
    expect(readCached('runtime.capabilities', { runtimeId: 'rt' })).toBeUndefined()
  })

  it('goes stale after the fresh window, and invalidation forces the next read to ask again', async () => {
    vi.useFakeTimers()
    mocks.rpc.mockResolvedValue({ v: 1 })
    await fetchCached('runtime.models', { runtimeId: 'rt' })
    expect(isStale('runtime.models', { runtimeId: 'rt' })).toBe(false)
    vi.advanceTimersByTime(CATALOG_FRESH_MS + 1)
    expect(isStale('runtime.models', { runtimeId: 'rt' })).toBe(true)
    // A stale value is still readable while it refreshes.
    expect(readCached('runtime.models', { runtimeId: 'rt' })).toEqual({ v: 1 })
    mocks.rpc.mockResolvedValue({ v: 2 })
    await fetchCached('runtime.models', { runtimeId: 'rt' })
    expect(readCached('runtime.models', { runtimeId: 'rt' })).toEqual({ v: 2 })
    invalidateCatalog('rt')
    expect(isStale('runtime.models', { runtimeId: 'rt' })).toBe(true)
    expect(readCached('runtime.models', { runtimeId: 'rt' })).toEqual({ v: 2 })
  })

  it('keeps the last good value when a refresh fails', async () => {
    mocks.rpc.mockResolvedValueOnce({ v: 1 })
    await fetchCached('runtime.models', { runtimeId: 'rt' })
    mocks.rpc.mockRejectedValueOnce(new Error('provider_unavailable'))
    await expect(fetchCached('runtime.models', { runtimeId: 'rt' }, { force: true })).rejects.toThrow('provider_unavailable')
    expect(readCached('runtime.models', { runtimeId: 'rt' })).toEqual({ v: 1 })
  })

  it('always re-checks a suggested (fallback) catalog but keeps showing it', async () => {
    mocks.rpc.mockResolvedValueOnce({ fallback: true, validated: false, models: [] })
    await fetchCached('runtime.models', { runtimeId: 'rt' })
    expect(isStale('runtime.models', { runtimeId: 'rt' })).toBe(true)
    mocks.rpc.mockResolvedValueOnce({ fallback: false, validated: true, models: [{ id: 'a' }] })
    await fetchCached('runtime.models', { runtimeId: 'rt' })
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
    expect(isStale('runtime.models', { runtimeId: 'rt' })).toBe(false)
  })
})
