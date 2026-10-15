// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../tauri', () => ({ rpc: vi.fn(async () => ({})) }))

import { rpc } from '../tauri'
import {
  TOUR_VERSION, density, hintSeen, hydrateDensity, hydrateHints, hydrateTour, isDensity,
  markHintSeen, resetHints, setDensity, setTourState, tourState, useDensity, useHintSeen, useTourState,
} from './uiPrefs'

const save = vi.mocked(rpc)
const mounted: Array<{ root: Root; host: HTMLDivElement }> = []

function mount(Component: () => React.ReactElement) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const render = () => act(() => root.render(<Component />))
  render()
  mounted.push({ root, host })
  return { host, rerender: render }
}

beforeEach(() => {
  localStorage.clear()
  save.mockClear()
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // Return the module's mirror to its defaults without leaving a cache behind.
  hydrateDensity('default')
  hydrateHints([])
  hydrateTour({ version: 0, done: false, step: 0 })
  localStorage.clear()
})

afterEach(() => {
  for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() }
})

describe('uiPrefs density', () => {
  it('defaults to default and mirrors it onto <html data-density>', () => {
    expect(density()).toBe('default')
    expect(document.documentElement.dataset.density).toBe('default')
    expect(isDensity('compact')).toBe(true)
    expect(isDensity('roomy')).toBe(true)
    expect(isDensity('tiny')).toBe(false)
    expect(isDensity(3)).toBe(false)
  })

  it('sets the mirror, the cache, the document attribute and persists', () => {
    setDensity('roomy')
    expect(density()).toBe('roomy')
    expect(document.documentElement.dataset.density).toBe('roomy')
    expect(localStorage.getItem('bitbots.density')).toBe('roomy')
    expect(save).toHaveBeenCalledWith('settings.set', { key: 'appearance.density', value: 'roomy' })
  })

  it('ignores an invalid density from the user or the daemon', () => {
    setDensity('cozy' as never)
    hydrateDensity('gigantic')
    hydrateDensity(7)
    expect(density()).toBe('default')
    expect(localStorage.getItem('bitbots.density')).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })

  it('re-renders a subscriber when the density changes', () => {
    const view = mount(() => <span data-density={useDensity()} />)
    expect(view.host.querySelector('span')?.dataset.density).toBe('default')
    act(() => setDensity('compact'))
    expect(view.host.querySelector('span')?.dataset.density).toBe('compact')
  })

})

describe('uiPrefs hints', () => {
  it('starts empty and records a seen hint once', () => {
    expect(hintSeen('companion.drag')).toBe(false)
    markHintSeen('companion.drag')
    expect(hintSeen('companion.drag')).toBe(true)
    markHintSeen('companion.drag')
    expect(JSON.parse(localStorage.getItem('bitbots.hints')!)).toEqual(['companion.drag'])
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('settings.set', { key: 'hints.seen', value: ['companion.drag'] })
  })

  it('ignores invalid ids and drops invalid daemon entries', () => {
    markHintSeen('Bad Id')
    markHintSeen('')
    hydrateHints(['companion.drag', 'UPPER', 4, 'ok'])
    expect(hintSeen('companion.drag')).toBe(true)
    expect(hintSeen('ok')).toBe(true)
    expect(hintSeen('Bad Id')).toBe(false)
    expect(JSON.parse(localStorage.getItem('bitbots.hints')!)).toEqual(['companion.drag', 'ok'])
    expect(save).not.toHaveBeenCalled()
  })

  it('caps the list at 64 and drops the oldest', () => {
    for (let index = 0; index < 70; index++) markHintSeen(`hint-${index}`)
    const stored = JSON.parse(localStorage.getItem('bitbots.hints')!) as string[]
    expect(stored).toHaveLength(64)
    expect(stored[0]).toBe('hint-6')
    expect(stored.at(-1)).toBe('hint-69')
    expect(hintSeen('hint-0')).toBe(false)
  })

  it('clears every hint on reset', () => {
    markHintSeen('companion.drag')
    resetHints()
    expect(hintSeen('companion.drag')).toBe(false)
    expect(save).toHaveBeenLastCalledWith('settings.set', { key: 'hints.seen', value: [] })
  })

  it('re-renders a subscriber and exposes a marker', () => {
    let mark: () => void = () => undefined
    const view = mount(() => {
      const [seen, markSeen] = useHintSeen('companion.drag')
      mark = markSeen
      return <span data-seen={String(seen)} />
    })
    expect(view.host.querySelector('span')?.dataset.seen).toBe('false')
    act(() => mark())
    expect(view.host.querySelector('span')?.dataset.seen).toBe('true')
  })
})

describe('uiPrefs tour', () => {
  it('starts at version 0, not done, step 0', () => {
    expect(TOUR_VERSION).toBe(1)
    expect(tourState()).toEqual({ version: 0, done: false, step: 0 })
  })

  it('merges a partial update into the stored tour and persists', () => {
    setTourState({ version: TOUR_VERSION, step: 2 })
    expect(tourState()).toEqual({ version: 1, done: false, step: 2 })
    setTourState({ done: true })
    expect(tourState()).toEqual({ version: 1, done: true, step: 2 })
    expect(JSON.parse(localStorage.getItem('bitbots.tour')!)).toEqual({ version: 1, done: true, step: 2 })
    expect(save).toHaveBeenLastCalledWith('settings.set', { key: 'onboarding.tour', value: { version: 1, done: true, step: 2 } })
  })

  it('ignores out-of-range fields from the user or the daemon', () => {
    setTourState({ step: 99 })
    setTourState({ version: 1000 })
    hydrateTour({ version: 0, done: 'yes', step: 0 })
    hydrateTour('tour')
    hydrateTour({ version: 1, done: false })
    expect(tourState()).toEqual({ version: 0, done: false, step: 0 })
    expect(save).not.toHaveBeenCalled()
  })

  it('re-renders a subscriber when the tour changes', () => {
    const view = mount(() => <span data-step={useTourState().step} />)
    expect(view.host.querySelector('span')?.dataset.step).toBe('0')
    act(() => setTourState({ step: 4 }))
    expect(view.host.querySelector('span')?.dataset.step).toBe('4')
  })
})
