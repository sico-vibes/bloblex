import { afterEach, describe, expect, it, vi } from 'vitest'
import { MASTER_VOLUME, disposeCompanionAudio, playCompanionCue, setCompanionSoundsEnabled, unlockCompanionAudioFromGesture, type CompanionCue } from './soundCues'

class FakeParam {
  readonly values: number[] = []
  setValueAtTime(value: number) { this.values.push(value) }
  exponentialRampToValueAtTime(value: number) { this.values.push(value) }
  linearRampToValueAtTime(value: number) { this.values.push(value) }
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

  it('synthesizes a distinct original cue for every companion moment through one master volume', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('document', testDocument)
    setCompanionSoundsEnabled(true)
    expect(await unlockCompanionAudioFromGesture()).toBe(true)
    const context = FakeAudioContext.instances[0]
    const [masterGain] = context.gains
    expect(masterGain.gain.values).toEqual([MASTER_VOLUME])

    const cues: CompanionCue[] = ['peek', 'open', 'close', 'hover', 'blip', 'tick', 'send', 'pop', 'poke', 'annoyed', 'dizzy', 'love', 'welcome', 'work', 'finish', 'error', 'approval', 'question', 'approve', 'gulp', 'sleep', 'completion']
    const signatures = new Set<string>()
    for (const cue of cues) {
      const before = context.oscillators.length
      expect(playCompanionCue(cue)).toBe(true)
      signatures.add(context.oscillators.slice(before).map((oscillator) => `${oscillator.type}:${oscillator.frequency.values.join(',')}`).join('|'))
    }
    // 'completion' is the earlier name for 'finish'; every other moment sounds different.
    expect(signatures.size).toBe(cues.length - 1)
    const peaks = context.gains.slice(1).flatMap((gain) => gain.gain.values).filter((value) => value > 0.0001)
    expect(Math.max(...peaks)).toBeLessThanOrEqual(1)
    expect(Math.max(...peaks) * MASTER_VOLUME).toBeGreaterThan(0.2)
  })

  it('unlocks on the first click after enabling, and stays audible with reduced motion', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('document', testDocument)
    reducedMotion = true
    setCompanionSoundsEnabled(true)
    testDocument.dispatchEvent(new Event('pointerdown'))
    await Promise.resolve(); await Promise.resolve()
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(FakeAudioContext.instances[0].state).toBe('running')
    expect(playCompanionCue('blip')).toBe(true)
  })

  it('silences voices when hidden or muted', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('document', testDocument)
    setCompanionSoundsEnabled(true)
    expect(await unlockCompanionAudioFromGesture()).toBe(true)
    expect(playCompanionCue('completion')).toBe(true)
    const context = FakeAudioContext.instances[0]
    const voice = context.oscillators[0]

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
