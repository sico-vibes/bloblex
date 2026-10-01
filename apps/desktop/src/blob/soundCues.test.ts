import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeCompanionAudio, playCompanionCue, setCompanionSoundsEnabled, unlockCompanionAudioFromGesture } from './soundCues'

class FakeParam {
  readonly values: number[] = []
  setValueAtTime(value: number) { this.values.push(value) }
  exponentialRampToValueAtTime(value: number) { this.values.push(value) }
}

class FakeOscillator {
  type: OscillatorType = 'sine'
  frequency = new FakeParam()
  onended: (() => void) | null = null
  start = vi.fn()
  stop = vi.fn()
  connect = vi.fn()
  disconnect = vi.fn()
}

class FakeGain {
  gain = new FakeParam()
  connect = vi.fn()
  disconnect = vi.fn()
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  state: AudioContextState = 'suspended'
  currentTime = 10
  destination = {}
  oscillators: FakeOscillator[] = []
  gains: FakeGain[] = []
  resume = vi.fn(async () => { this.state = 'running' as AudioContextState })
  suspend = vi.fn(async () => { this.state = 'suspended' as AudioContextState })
  close = vi.fn(async () => { this.state = 'closed' as AudioContextState })

  constructor() { FakeAudioContext.instances.push(this) }
  createOscillator() {
    const oscillator = new FakeOscillator()
    this.oscillators.push(oscillator)
    return oscillator as unknown as OscillatorNode
  }
  createGain() {
    const gain = new FakeGain()
    this.gains.push(gain)
    return gain as unknown as GainNode
  }
}

class FakeDocument extends EventTarget {
  hidden = false
}

const testDocument = new FakeDocument()
let reducedMotion = false

afterEach(() => {
  disposeCompanionAudio()
  FakeAudioContext.instances = []
  testDocument.hidden = false
  reducedMotion = false
  vi.unstubAllGlobals()
})

describe('opt-in original companion sound cues', () => {
  it('stays silent by default and preference hydration does not create or unlock audio', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('document', testDocument)
    vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }))

    expect(playCompanionCue('welcome')).toBe(false)
    setCompanionSoundsEnabled(true)
    expect(playCompanionCue('welcome')).toBe(false)
    expect(FakeAudioContext.instances).toHaveLength(0)
    expect(await unlockCompanionAudioFromGesture()).toBe(true)
    expect(playCompanionCue('welcome')).toBe(true)
  })

  it('synthesizes distinct low-volume notes for each original cue', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('document', testDocument)
    vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }))
    setCompanionSoundsEnabled(true)
    expect(await unlockCompanionAudioFromGesture()).toBe(true)

    for (const cue of ['welcome', 'poke', 'approval', 'completion', 'error'] as const) {
      expect(playCompanionCue(cue)).toBe(true)
    }

    const context = FakeAudioContext.instances[0]
    expect(context.oscillators).toHaveLength(10)
    expect(context.oscillators.every((oscillator) => oscillator.type === 'sine')).toBe(true)
    expect(context.gains.flatMap((gain) => gain.gain.values).filter((value) => value > 0.0001).every((value) => value <= 0.022)).toBe(true)
    const frequencies = context.oscillators.map((oscillator) => oscillator.frequency.values[0])
    expect(new Set(frequencies).size).toBeGreaterThan(5)
  })

  it('suppresses cues and silences voices when hidden, reduced-motion, or muted', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('document', testDocument)
    vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }))
    setCompanionSoundsEnabled(true)
    expect(await unlockCompanionAudioFromGesture()).toBe(true)
    expect(playCompanionCue('completion')).toBe(true)
    const context = FakeAudioContext.instances[0]
    const voice = context.oscillators[0]

    reducedMotion = true
    expect(playCompanionCue('poke')).toBe(false)
    reducedMotion = false
    testDocument.hidden = true
    testDocument.dispatchEvent(new Event('visibilitychange'))
    expect(voice.stop).toHaveBeenCalled()
    expect(context.suspend).toHaveBeenCalledOnce()
    expect(playCompanionCue('error')).toBe(false)

    testDocument.hidden = false
    setCompanionSoundsEnabled(false)
    expect(context.close).toHaveBeenCalledOnce()
    expect(playCompanionCue('welcome')).toBe(false)
  })

  it('does not report audio unlocked if the user mutes while resume is pending', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('document', testDocument)
    vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }))
    setCompanionSoundsEnabled(true)
    let finishResume!: () => void
    expect(await unlockCompanionAudioFromGesture()).toBe(true)
    const context = FakeAudioContext.instances[0]
    context.state = 'suspended'
    context.resume = vi.fn(() => new Promise<void>((resolve) => { finishResume = () => { context.state = 'running'; resolve() } }))

    const pendingUnlock = unlockCompanionAudioFromGesture()
    setCompanionSoundsEnabled(false)
    finishResume()

    expect(await pendingUnlock).toBe(false)
    expect(playCompanionCue('approval')).toBe(false)
  })

  it('treats browser audio construction and oscillator failures as a silent fallback', async () => {
    vi.stubGlobal('document', testDocument)
    vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }))
    setCompanionSoundsEnabled(true)
    vi.stubGlobal('AudioContext', class { constructor() { throw new Error('Audio unavailable') } })
    expect(await unlockCompanionAudioFromGesture()).toBe(false)

    vi.stubGlobal('AudioContext', FakeAudioContext)
    expect(await unlockCompanionAudioFromGesture()).toBe(true)
    FakeAudioContext.instances[0].createOscillator = vi.fn(() => { throw new Error('Oscillator unavailable') })
    expect(playCompanionCue('error')).toBe(false)
  })
})
