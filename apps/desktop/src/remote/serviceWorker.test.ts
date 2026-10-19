// The two hooks the "Update ready" prompt uses, and the registration guard.
// Installing on a phone and the real update flow are not exercised here (they
// need a browser and a host); docs/history/fix-29/wp6c-report.md says so.

import { describe, expect, it, vi } from 'vitest'
import { applyUpdate, onUpdateReady, registerRemoteServiceWorker, updateIsReady } from './serviceWorker'

describe('remote service worker helpers', () => {
  it('has nothing waiting before a worker reports in', () => {
    expect(updateIsReady()).toBe(false)
  })

  it('applies nothing when no update is waiting', () => {
    expect(() => applyUpdate()).not.toThrow()
  })

  it('hands back an unsubscribe function', () => {
    const callback = vi.fn()
    const stop = onUpdateReady(callback)
    expect(typeof stop).toBe('function')
    stop()
    expect(callback).not.toHaveBeenCalled()
  })

  it('does not register without a service worker API', () => {
    // The node test environment has no `navigator.serviceWorker`.
    expect(() => registerRemoteServiceWorker()).not.toThrow()
  })
})
