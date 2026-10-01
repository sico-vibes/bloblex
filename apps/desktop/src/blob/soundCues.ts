export type CompanionCue = 'welcome' | 'poke' | 'approval' | 'completion' | 'error'

interface Note {
  frequency: number
  duration: number
}

const cues: Record<CompanionCue, readonly Note[]> = {
  welcome: [{ frequency: 523.25, duration: 0.095 }, { frequency: 659.25, duration: 0.095 }, { frequency: 783.99, duration: 0.15 }],
  poke: [{ frequency: 392, duration: 0.075 }],
  approval: [{ frequency: 440, duration: 0.09 }, { frequency: 587.33, duration: 0.13 }],
  completion: [{ frequency: 659.25, duration: 0.1 }, { frequency: 880, duration: 0.16 }],
  error: [{ frequency: 392, duration: 0.11 }, { frequency: 311.13, duration: 0.17 }],
}

const peakGain = 0.022
let soundsEnabled = false
let audioContext: AudioContext | null = null
let visibilityDocument: Document | null = null
const activeOscillators = new Set<OscillatorNode>()

function documentIsHidden() {
  return typeof document !== 'undefined' && document.hidden
}

function prefersReducedMotion() {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

function audioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window !== 'undefined' && window.AudioContext) return window.AudioContext
  return typeof AudioContext !== 'undefined' ? AudioContext : undefined
}

function silenceActiveVoices() {
  if (!audioContext) return
  const now = audioContext.currentTime
  for (const oscillator of activeOscillators) {
    try { oscillator.stop(now) } catch { /* already ended */ }
    try { oscillator.disconnect() } catch { /* context is closing */ }
  }
  activeOscillators.clear()
}

function handleVisibilityChange() {
  if (!documentIsHidden() || !audioContext) return
  silenceActiveVoices()
  void audioContext.suspend().catch(() => undefined)
}

function bindVisibilityListener() {
  if (typeof document === 'undefined' || visibilityDocument === document) return
  unbindVisibilityListener()
  visibilityDocument = document
  visibilityDocument.addEventListener('visibilitychange', handleVisibilityChange)
}

function unbindVisibilityListener() {
  visibilityDocument?.removeEventListener('visibilitychange', handleVisibilityChange)
  visibilityDocument = null
}

/** Load the persisted preference without creating an AudioContext or playing audio. */
export function setCompanionSoundsEnabled(enabled: boolean) {
  soundsEnabled = enabled
  if (enabled) {
    bindVisibilityListener()
    return
  }
  unbindVisibilityListener()
  silenceActiveVoices()
  const oldContext = audioContext
  audioContext = null
  if (oldContext && oldContext.state !== 'closed') void oldContext.close().catch(() => undefined)
}

/** Call directly inside the user's Sounds-toggle gesture to satisfy browser autoplay policy. */
export async function unlockCompanionAudioFromGesture(): Promise<boolean> {
  if (!soundsEnabled || documentIsHidden() || prefersReducedMotion()) return false
  const AudioContextType = audioContextConstructor()
  if (!AudioContextType) return false
  let context: AudioContext
  try {
    if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContextType()
    context = audioContext
    if (context.state !== 'running') await context.resume()
    return soundsEnabled && audioContext === context && context.state === 'running'
  } catch {
    return false
  }
}

/** Play a short, original synthesized cue only after an explicit opt-in and audio unlock. */
export function playCompanionCue(kind: CompanionCue): boolean {
  if (!soundsEnabled || !audioContext || audioContext.state !== 'running' || documentIsHidden() || prefersReducedMotion()) return false
  const context = audioContext
  let onset = context.currentTime + 0.012
  const created: Array<{ oscillator: OscillatorNode; envelope: GainNode }> = []
  try {
    for (const note of cues[kind]) {
      const oscillator = context.createOscillator()
      const envelope = context.createGain()
      created.push({ oscillator, envelope })
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(note.frequency, onset)
      envelope.gain.setValueAtTime(0.0001, onset)
      envelope.gain.exponentialRampToValueAtTime(peakGain, onset + 0.012)
      envelope.gain.exponentialRampToValueAtTime(0.0001, onset + note.duration)
      oscillator.connect(envelope)
      envelope.connect(context.destination)
      oscillator.onended = () => {
        activeOscillators.delete(oscillator)
        try { oscillator.disconnect() } catch { /* already disconnected */ }
        try { envelope.disconnect() } catch { /* already disconnected */ }
      }
      activeOscillators.add(oscillator)
      oscillator.start(onset)
      oscillator.stop(onset + note.duration + 0.02)
      onset += note.duration + 0.035
    }
    return true
  } catch {
    for (const { oscillator, envelope } of created) {
      activeOscillators.delete(oscillator)
      try { oscillator.stop(context.currentTime) } catch { /* already ended */ }
      try { oscillator.disconnect() } catch { /* context is closing */ }
      try { envelope.disconnect() } catch { /* context is closing */ }
    }
    return false
  }
}

/** Stop voices and release browser resources when the desktop surface is destroyed. */
export function disposeCompanionAudio() {
  setCompanionSoundsEnabled(false)
}
