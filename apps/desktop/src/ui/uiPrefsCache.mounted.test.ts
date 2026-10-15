// @vitest-environment happy-dom
// The first-paint cache is read once, when the module loads. These cases reload
// the module (no React, so no renderer instance is involved) to prove the cache
// is honoured and that an invalid cached value falls back to the default.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../tauri', () => ({ rpc: vi.fn(async () => ({})) }))

beforeEach(() => { localStorage.clear(); vi.resetModules() })

describe('uiPrefs first-paint cache', () => {
  it('reads a cached density, else default', async () => {
    localStorage.setItem('bitbots.density', 'roomy')
    expect((await import('./uiPrefs')).density()).toBe('roomy')
    localStorage.setItem('bitbots.density', 'cozy')
    vi.resetModules()
    expect((await import('./uiPrefs')).density()).toBe('default')
  })

  it('reads cached hints and drops invalid entries', async () => {
    localStorage.setItem('bitbots.hints', JSON.stringify(['companion.drag', 'Bad', 4]))
    const reloaded = await import('./uiPrefs')
    expect(reloaded.hintSeen('companion.drag')).toBe(true)
    expect(reloaded.hintSeen('Bad')).toBe(false)
  })

  it('reads a valid cached tour and ignores a stale one', async () => {
    localStorage.setItem('bitbots.tour', JSON.stringify({ version: 1, done: true, step: 5 }))
    expect((await import('./uiPrefs')).tourState()).toEqual({ version: 1, done: true, step: 5 })
    localStorage.setItem('bitbots.tour', JSON.stringify({ version: 1, done: true, step: 500 }))
    vi.resetModules()
    expect((await import('./uiPrefs')).tourState()).toEqual({ version: 0, done: false, step: 0 })
  })
})
