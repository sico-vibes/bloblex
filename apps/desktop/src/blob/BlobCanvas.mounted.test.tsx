// @vitest-environment happy-dom
import React, { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlobCanvas } from './BlobCanvas'
import * as soundCues from './soundCues'

type FrameCallback = (timestamp: number) => void

class TestPath2D {
  moveTo() {} lineTo() {} quadraticCurveTo() {} bezierCurveTo() {} closePath() {}
  ellipse() {} arc() {} rect() {} addPath() {}
}

let clock = 10_000
let nextFrame = 1
let frames = new Map<number, FrameCallback>()
let context: ReturnType<typeof makeCanvasContext>
let mediaQuery: MediaQueryList
let mountedRoots: Array<{ root: Root; host: HTMLElement }> = []

function makeCanvasContext() {
  const gradient = { addColorStop: vi.fn() }
  return {
    setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(),
    createLinearGradient: vi.fn(() => gradient), createRadialGradient: vi.fn(() => gradient),
    beginPath: vi.fn(), arc: vi.fn(), arcTo: vi.fn(), ellipse: vi.fn(), fill: vi.fn(), stroke: vi.fn(), clip: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    roundRect: vi.fn(), quadraticCurveTo: vi.fn(), bezierCurveTo: vi.fn(), closePath: vi.fn(), fillText: vi.fn(),
    setLineDash: vi.fn(), fillRect: vi.fn(),
  }
}

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = []
  observed: Element | null = null
  disconnected = false
  constructor(private readonly callback: IntersectionObserverCallback) { TestIntersectionObserver.instances.push(this) }
  observe = vi.fn((element: Element) => { this.observed = element })
  unobserve = vi.fn()
  disconnect = vi.fn(() => { this.disconnected = true })
  takeRecords = vi.fn(() => [])
  trigger(isIntersecting: boolean) {
    if (!this.observed || this.disconnected) return
    const entry = { target: this.observed, isIntersecting } as IntersectionObserverEntry
    this.callback([entry], this as unknown as IntersectionObserver)
  }
}

function mount(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mountedRoots.push({ root, host })
  act(() => root.render(node))
  return {
    host,
    rerender(next: React.ReactNode) { act(() => root.render(next)) },
    unmount() {
      act(() => root.unmount())
      host.remove()
      mountedRoots = mountedRoots.filter((item) => item.root !== root)
    },
  }
}

function flushFrame(timestamp = clock) {
  clock = timestamp
  const pending = [...frames.values()]
  frames.clear()
  act(() => pending.forEach((callback) => callback(timestamp)))
}

function frameQueueSize() { return frames.size }

beforeEach(() => {
  clock = 10_000
  nextFrame = 1
  frames = new Map()
  TestIntersectionObserver.instances = []
  context = makeCanvasContext()
  mediaQuery = {
    matches: false,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(() => true),
  }
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  vi.stubGlobal('performance', { now: () => clock })
  vi.stubGlobal('Path2D', TestPath2D)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameCallback) => { const id = nextFrame++; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
  vi.spyOn(window, 'matchMedia').mockImplementation(() => mediaQuery)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context as unknown as CanvasRenderingContext2D)
})

afterEach(() => {
  for (const { root, host } of [...mountedRoots]) {
    act(() => root.unmount())
    host.remove()
  }
  mountedRoots = []
  frames.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('BlobCanvas mounted lifecycle', () => {
  it('completes the production greeting once through StrictMode replay and visual reinitialization', () => {
    const complete = vi.fn()
    const cue = vi.spyOn(soundCues, 'playCompanionCue')
    const view = mount(<StrictMode><BlobCanvas color="#e67f72" size={100} mood="idle" greeting soundCues onGreetingComplete={complete} /></StrictMode>)
    expect(cue).toHaveBeenCalledTimes(1)
    expect(cue).toHaveBeenCalledWith('welcome')
    flushFrame(clock)
    view.rerender(<StrictMode><BlobCanvas color="#729be6" size={104} mood="idle" greeting soundCues onGreetingComplete={complete} /></StrictMode>)
    expect(cue).toHaveBeenCalledTimes(1)
    flushFrame(clock + 4601)
    flushFrame(clock + 110)
    expect(complete).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('finishes a real pointer-interrupted greeting exactly once and does not finish on unmount', () => {
    const complete = vi.fn()
    const cue = vi.spyOn(soundCues, 'playCompanionCue')
    const view = mount(<StrictMode><BlobCanvas color="#e67f72" greeting soundCues onGreetingComplete={complete} /></StrictMode>)
    const canvas = view.host.querySelector('canvas')!
    act(() => canvas.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    act(() => canvas.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(complete).toHaveBeenCalledTimes(1)
    expect(cue.mock.calls.filter(([kind]) => kind === 'welcome')).toHaveLength(1)
    expect(cue.mock.calls.filter(([kind]) => kind === 'poke')).toHaveLength(2)
    view.unmount()

    const neverComplete = vi.fn()
    const unfinished = mount(<StrictMode><BlobCanvas color="#e67f72" greeting onGreetingComplete={neverComplete} /></StrictMode>)
    unfinished.unmount()
    expect(neverComplete).not.toHaveBeenCalled()
  })

  it('keeps main-window avatars silent unless the companion explicitly opts in', () => {
    const cue = vi.spyOn(soundCues, 'playCompanionCue')
    const mainAvatar = mount(<BlobCanvas color="#e67f72" />)
    act(() => mainAvatar.host.querySelector('canvas')!.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(cue).not.toHaveBeenCalled()
    mainAvatar.unmount()

    const companionAvatar = mount(<BlobCanvas color="#e67f72" soundCues />)
    act(() => companionAvatar.host.querySelector('canvas')!.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(cue).toHaveBeenCalledTimes(1)
    expect(cue).toHaveBeenCalledWith('poke')
    companionAvatar.unmount()
  })

  it('unlocks local audio on the first opted-in pointer gesture after an event-based opt-in', async () => {
    const cue = vi.spyOn(soundCues, 'playCompanionCue').mockReturnValueOnce(false).mockReturnValue(true)
    const unlock = vi.spyOn(soundCues, 'unlockCompanionAudioFromGesture').mockResolvedValue(true)
    const view = mount(<BlobCanvas color="#e67f72" soundCues />)
    act(() => view.host.querySelector('canvas')!.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(unlock).toHaveBeenCalledExactlyOnceWith()
    expect(cue).toHaveBeenCalledExactlyOnceWith('poke')
    await act(async () => { await Promise.resolve() })
    expect(cue).toHaveBeenCalledTimes(2)
    expect(cue).toHaveBeenLastCalledWith('poke')
    view.unmount()
  })

  it('completes a reduced-motion greeting once despite StrictMode effect replay', () => {
    Object.defineProperty(mediaQuery, 'matches', { configurable: true, value: true })
    const complete = vi.fn()
    const view = mount(<StrictMode><BlobCanvas color="#e67f72" greeting onGreetingComplete={complete} /></StrictMode>)
    expect(complete).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('recovers from three pokes at the deadline even after the Canvas unmounts', () => {
    const dizzy = vi.fn()
    const recovered = vi.fn()
    const view = mount(<BlobCanvas color="#e67f72" onDizzy={dizzy} onDizzyRecovery={recovered} />)
    const canvas = view.host.querySelector('canvas')!
    act(() => {
      canvas.dispatchEvent(new Event('pointerdown'))
      canvas.dispatchEvent(new Event('pointerdown'))
      canvas.dispatchEvent(new Event('pointerdown'))
    })
    expect(dizzy).toHaveBeenCalledTimes(1)
    view.unmount()
    act(() => vi.advanceTimersByTime(3300))
    expect(recovered).toHaveBeenCalledTimes(1)
  })

  it('pauses drawing while hidden or outside the viewport and detaches after unmount', () => {
    const view = mount(<BlobCanvas color="#e67f72" mood="thinking" />)
    const observer = TestIntersectionObserver.instances.at(-1)!
    const canvas = view.host.querySelector('canvas')!
    expect(frameQueueSize()).toBeGreaterThan(0)
    flushFrame(clock)
    const drawCount = context.clearRect.mock.calls.length

    act(() => observer.trigger(false))
    expect(frameQueueSize()).toBe(0)
    flushFrame(clock + 100)
    expect(context.clearRect).toHaveBeenCalledTimes(drawCount)

    act(() => observer.trigger(true))
    expect(frameQueueSize()).toBeGreaterThan(0)
    flushFrame(clock + 100)
    const afterVisibleDraw = context.clearRect.mock.calls.length
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(frameQueueSize()).toBe(0)
    flushFrame(clock + 100)
    expect(context.clearRect).toHaveBeenCalledTimes(afterVisibleDraw)

    view.unmount()
    expect(observer.disconnected).toBe(true)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(frameQueueSize()).toBe(0)
    expect(canvas.isConnected).toBe(false)
  })

  it('fits tall hat outfits with a uniform body transform so the body stays circular', () => {
    const view = mount(<BlobCanvas color="#e67f72" size={100} mood="idle" outfit="witch-hat" />)
    flushFrame(clock)
    const [scaleX, scaleY] = context.scale.mock.calls[0]
    expect(scaleX).toBeLessThan(1)
    expect(scaleY).toBeCloseTo(scaleX)
    view.unmount()
  })

  it('renders each local reference stage and preserves approval/offline/error barriers', () => {
    const view = mount(<BlobCanvas color="#e67f72" label="Agent" mood="success" fileStage="drop" />)
    const canvas = view.host.querySelector('canvas')!
    expect(canvas.getAttribute('aria-label')).toBe('Agent file_drop')
    flushFrame(clock)

    view.rerender(<BlobCanvas color="#e67f72" label="Agent" mood="success" fileStage="preparing" />)
    expect(canvas.getAttribute('aria-label')).toBe('Agent file_preparing')
    flushFrame(clock + 16)
    view.rerender(<BlobCanvas color="#e67f72" label="Agent" mood="success" fileStage="ready" />)
    expect(canvas.getAttribute('aria-label')).toBe('Agent file_ready')
    flushFrame(clock + 16)
    expect(context.quadraticCurveTo).toHaveBeenCalled()
    view.rerender(<BlobCanvas color="#e67f72" label="Agent" mood="success" fileStage="sending" />)
    expect(canvas.getAttribute('aria-label')).toBe('Agent file_sending')
    view.rerender(<BlobCanvas color="#e67f72" label="Agent" mood="success" fileStage="error" />)
    expect(canvas.getAttribute('aria-label')).toBe('Agent file_error')
    // The badge returns once the mailbox morph from the drop stages has
    // relaxed and the previous badge has shrunk away (100 ms swap).
    flushFrame(clock + 16)
    flushFrame(clock + 700)
    flushFrame(clock + 60)
    expect(context.fillText.mock.calls.some(([text]) => text === '!')).toBe(true)

    view.rerender(<BlobCanvas color="#e67f72" label="Agent" mood="permission" fileStage="ready" />)
    expect(canvas.getAttribute('aria-label')).toBe('Agent permission')
    view.rerender(<BlobCanvas color="#e67f72" label="Agent" mood="offline" fileStage="drop" />)
    expect(canvas.getAttribute('aria-label')).toBe('Agent offline')
    view.rerender(<BlobCanvas color="#e67f72" label="Agent" mood="error" fileStage="ready" />)
    expect(canvas.getAttribute('aria-label')).toBe('Agent error')
    view.unmount()
  })
})
