import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { CompanionFsm } from './companionFsm'

const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  setTimeout: (...args: Parameters<typeof globalThis.setTimeout>) => globalThis.setTimeout(...args),
  clearTimeout: (...args: Parameters<typeof globalThis.clearTimeout>) => globalThis.clearTimeout(...args),
} })
afterAll(() => {
  if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

describe('companion capsule interaction states', () => {
  afterEach(() => vi.useRealTimers())

  it('finishes the welcome greeting even when the pointer passes over and leaves', () => {
    vi.useFakeTimers()
    const fsm = new CompanionFsm()
    fsm.launch()
    fsm.mouseEntered()
    fsm.mouseLeft()
    expect(fsm.state).toBe('welcome')
    fsm.greetComplete()
    vi.advanceTimersByTime(1399)
    expect(fsm.state).toBe('welcome')
    vi.advanceTimersByTime(1)
    expect(fsm.state).toBe('petit')
  })

  it('greets briefly, expands on hover, then collapses after leaving', () => {
    vi.useFakeTimers()
    const fsm = new CompanionFsm()
    fsm.launch()
    expect(fsm.state).toBe('welcome')
    fsm.greetComplete()
    // The island rests briefly after the greeting before shrinking.
    vi.advanceTimersByTime(1399)
    expect(fsm.state).toBe('welcome')
    vi.advanceTimersByTime(1)
    expect(fsm.state).toBe('petit')
    fsm.click()
    expect(fsm.state).toBe('home')
    fsm.mouseLeft()
    vi.advanceTimersByTime(15_000)
    expect(fsm.state).toBe('petit')
  })

  it('keeps a hovered greeting expanded for the upstream ten-second window', () => {
    vi.useFakeTimers()
    const fsm = new CompanionFsm()
    fsm.launch()
    fsm.mouseEntered()
    fsm.greetComplete()
    vi.advanceTimersByTime(9_999)
    expect(fsm.state).toBe('welcome')
    vi.advanceTimersByTime(1)
    expect(fsm.state).toBe('petit')
  })

  it('keeps an approval expanded until it resolves', () => {
    vi.useFakeTimers()
    const fsm = new CompanionFsm()
    fsm.forceHome(true)
    fsm.forceHome()
    fsm.mouseLeft()
    vi.advanceTimersByTime(60_000)
    expect(fsm.state).toBe('home')
    fsm.forcePetit()
    expect(fsm.state).toBe('home')
    fsm.forcePetit(true)
    expect(fsm.state).toBe('petit')
    expect(fsm.pinned).toBe(false)
  })

  it('keeps its approval pin through ordinary navigation and hover timeouts', () => {
    vi.useFakeTimers()
    const fsm = new CompanionFsm()
    fsm.forceHome(true)
    fsm.forceHome()
    fsm.mouseLeft()
    vi.advanceTimersByTime(15_000)
    expect(fsm.state).toBe('home')
    expect(fsm.pinned).toBe(true)
    fsm.forcePetit(true)
    expect(fsm.state).toBe('petit')
    expect(fsm.pinned).toBe(false)
  })

  it('wakes from hidden to the compact bill when the cursor reaches it', () => {
    vi.useFakeTimers()
    const fsm = new CompanionFsm()
    fsm.forceHidden()
    fsm.mouseEntered()
    expect(fsm.state).toBe('petit')
  })

  it('keeps a freely positioned compact window visible until explicit hide', () => {
    vi.useFakeTimers()
    const fsm = new CompanionFsm()
    fsm.reveal()
    fsm.mouseLeft()
    vi.advanceTimersByTime(60_000)
    expect(fsm.state).toBe('petit')
    fsm.forceHidden()
    expect(fsm.state).toBe('hidden')
  })
})
