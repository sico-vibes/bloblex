// Companion sounds: short, original synthesized cues for the companion's
// moments (reveal, open, close, switching, sending, a new reply, pokes, and
// the agent's work, finish, error, approval and question states). The set of
// moments follows desktop companions such as Coucou; every sound here is
// generated with Web Audio oscillators, so no third-party audio is bundled.
//
// Sounds are opt-in. The audio context is created and resumed only from a user
// gesture (the first click or key press after enabling), it is suspended while
// the window is hidden or quiet, and several cues may overlap.

export type CompanionCue =
  | 'peek' | 'open' | 'close' | 'hover' | 'blip' | 'tick' | 'send' | 'pop'
  | 'poke' | 'annoyed' | 'dizzy' | 'love' | 'welcome' | 'work' | 'finish'
  | 'error' | 'approval' | 'question' | 'approve' | 'gulp' | 'sleep'
  /** Earlier names, kept for callers that still use them. */
  | 'completion'

/** One voice: a pitch that may glide, under a short attack/decay envelope. */
interface Tone {
  /** Start, in seconds after the cue begins. */
  at: number
  duration: number
  from: number
  /** Glide target; held pitch when omitted. */
  to?: number
  type?: OscillatorType
  /** Relative loudness, 0–1, before the master volume. */
  level?: number
  /** A slow pitch wobble (Hz, depth as a fraction of the pitch). */
  wobble?: { rate: number; depth: number }
}

const bell = (at: number, frequency: number, duration: number, level = 0.8): Tone[] => [
  { at, duration, from: frequency, type: 'sine', level },
  { at, duration: duration * 0.6, from: frequency * 2, type: 'sine', level: level * 0.22 },
]

const CUES: Record<Exclude<CompanionCue, 'completion'>, readonly Tone[]> = {
  peek: [{ at: 0, duration: 0.09, from: 330, to: 720, type: 'sine', level: 0.7 }],
  open: [{ at: 0, duration: 0.13, from: 420, to: 880, type: 'triangle', level: 0.55 }, ...bell(0.07, 1046.5, 0.12, 0.35)],
  close: [{ at: 0, duration: 0.12, from: 820, to: 380, type: 'triangle', level: 0.5 }],
  hover: [{ at: 0, duration: 0.07, from: 990, to: 1120, type: 'sine', level: 0.28 }],
  blip: [{ at: 0, duration: 0.055, from: 1180, to: 1420, type: 'sine', level: 0.45 }],
  tick: [{ at: 0, duration: 0.03, from: 2100, type: 'square', level: 0.12 }, { at: 0, duration: 0.04, from: 1400, type: 'sine', level: 0.3 }],
  send: [{ at: 0, duration: 0.15, from: 520, to: 1250, type: 'sine', level: 0.6 }, { at: 0.02, duration: 0.12, from: 780, to: 1560, type: 'triangle', level: 0.2 }],
  pop: [{ at: 0, duration: 0.08, from: 1250, to: 520, type: 'sine', level: 0.7 }],
  poke: [{ at: 0, duration: 0.16, from: 300, to: 190, type: 'sine', level: 0.75, wobble: { rate: 28, depth: 0.06 } }],
  annoyed: [{ at: 0, duration: 0.1, from: 330, type: 'triangle', level: 0.55 }, { at: 0.11, duration: 0.16, from: 262, to: 233, type: 'triangle', level: 0.55 }],
  dizzy: [{ at: 0, duration: 0.6, from: 720, to: 300, type: 'sine', level: 0.6, wobble: { rate: 9, depth: 0.08 } }],
  love: [...bell(0, 784, 0.16, 0.6), ...bell(0.12, 1046.5, 0.26, 0.6)],
  welcome: [...bell(0, 523.25, 0.14), ...bell(0.1, 659.25, 0.14), ...bell(0.2, 783.99, 0.14), ...bell(0.3, 1046.5, 0.34)],
  work: [{ at: 0, duration: 0.09, from: 494, type: 'sine', level: 0.45 }, { at: 0.09, duration: 0.12, from: 587, type: 'sine', level: 0.45 }],
  finish: [...bell(0, 659.25, 0.13), ...bell(0.1, 830.6, 0.13), ...bell(0.2, 987.8, 0.36)],
  error: [{ at: 0, duration: 0.14, from: 392, type: 'triangle', level: 0.6 }, { at: 0.15, duration: 0.24, from: 311.1, to: 293.7, type: 'triangle', level: 0.6 }],
  approval: [...bell(0, 880, 0.18, 0.75), ...bell(0.17, 698.5, 0.3, 0.75)],
  question: [{ at: 0, duration: 0.09, from: 587.3, type: 'sine', level: 0.55 }, { at: 0.09, duration: 0.2, from: 740, to: 880, type: 'sine', level: 0.55 }],
  approve: [...bell(0, 698.5, 0.1, 0.65), ...bell(0.08, 1046.5, 0.22, 0.65)],
  gulp: [{ at: 0, duration: 0.14, from: 260, to: 120, type: 'sine', level: 0.8 }, { at: 0.12, duration: 0.07, from: 900, to: 420, type: 'sine', level: 0.35 }],
  sleep: [{ at: 0, duration: 0.3, from: 523.25, to: 440, type: 'sine', level: 0.35 }, { at: 0.26, duration: 0.42, from: 392, to: 349.2, type: 'sine', level: 0.3 }],
}

/** Overall loudness. Peaks land around a quiet UI level, under the system volume. */
export const MASTER_VOLUME = 0.32

let soundsEnabled = false
let audioContext: AudioContext | null = null
let master: GainNode | null = null
let boundDocument: Document | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
const activeOscillators = new Set<OscillatorNode>()

const documentIsHidden = () => typeof document !== 'undefined' && document.hidden

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

/** The first click or key press after enabling unlocks audio (browser autoplay rules). */
function handleGesture() {
  if (!soundsEnabled) return
  void unlockCompanionAudioFromGesture()
}

function bindDocument() {
  if (typeof document === 'undefined' || boundDocument === document) return
  unbindDocument()
  boundDocument = document
  boundDocument.addEventListener('visibilitychange', handleVisibilityChange)
  boundDocument.addEventListener('pointerdown', handleGesture, true)
  boundDocument.addEventListener('keydown', handleGesture, true)
}

function unbindDocument() {
  boundDocument?.removeEventListener('visibilitychange', handleVisibilityChange)
  boundDocument?.removeEventListener('pointerdown', handleGesture, true)
  boundDocument?.removeEventListener('keydown', handleGesture, true)
  boundDocument = null
}

/** Load the persisted preference without creating an AudioContext or playing audio. */
export function setCompanionSoundsEnabled(enabled: boolean) {
  soundsEnabled = enabled
  if (enabled) {
    bindDocument()
    return
  }
  unbindDocument()
  silenceActiveVoices()
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  const oldContext = audioContext
  audioContext = null
  master = null
  if (oldContext && oldContext.state !== 'closed') void oldContext.close().catch(() => undefined)
}

export function companionSoundsEnabled() {
  return soundsEnabled
}

/** Call from a user gesture (the Sounds toggle, a click) to create or resume audio. */
export async function unlockCompanionAudioFromGesture(): Promise<boolean> {
  if (!soundsEnabled || documentIsHidden()) return false
  const AudioContextType = audioContextConstructor()
  if (!AudioContextType) return false
  let context: AudioContext
  try {
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new AudioContextType()
      master = audioContext.createGain()
      master.gain.setValueAtTime(MASTER_VOLUME, audioContext.currentTime)
      master.connect(audioContext.destination)
    }
    context = audioContext
    if (context.state !== 'running') await context.resume()
    return soundsEnabled && audioContext === context && context.state === 'running'
  } catch {
    return false
  }
}

/** A running context costs an audio thread; suspend it once the last cue has rung out. */
function scheduleIdle(seconds: number) {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (audioContext && audioContext.state === 'running' && activeOscillators.size === 0) void audioContext.suspend().catch(() => undefined)
  }, (seconds + 1.5) * 1000)
}

/** Play a cue. Returns false when sounds are off, audio is locked, or the window is hidden. */
export function playCompanionCue(kind: CompanionCue): boolean {
  if (!soundsEnabled || !audioContext || !master || documentIsHidden()) return false
  const context = audioContext
  if (context.state === 'suspended') {
    // Suspended for idleness, not by the browser: resume and play on the next tick.
    void context.resume().then(() => { if (context.state === 'running') playCompanionCue(kind) }).catch(() => undefined)
    return true
  }
  if (context.state !== 'running') return false
  const tones = CUES[kind === 'completion' ? 'finish' : kind]
  const start = context.currentTime + 0.01
  const created: Array<{ oscillator: OscillatorNode; envelope: GainNode }> = []
  let end = 0
  try {
    for (const tone of tones) {
      const oscillator = context.createOscillator()
      const envelope = context.createGain()
      created.push({ oscillator, envelope })
      const onset = start + tone.at
      const stop = onset + tone.duration
      const peak = Math.max(0.0002, tone.level ?? 0.6)
      oscillator.type = tone.type ?? 'sine'
      oscillator.frequency.setValueAtTime(tone.from, onset)
      if (tone.wobble) {
        const steps = Math.max(2, Math.round(tone.duration * tone.wobble.rate * 4))
        for (let step = 1; step <= steps; step++) {
          const t = step / steps
          const base = tone.to ? tone.from * Math.pow(tone.to / tone.from, t) : tone.from
          const value = base * (1 + Math.sin(t * tone.duration * tone.wobble.rate * Math.PI * 2) * tone.wobble.depth)
          oscillator.frequency.linearRampToValueAtTime(Math.max(20, value), onset + tone.duration * t)
        }
      } else if (tone.to) {
        oscillator.frequency.exponentialRampToValueAtTime(tone.to, stop)
      }
      envelope.gain.setValueAtTime(0.0001, onset)
      envelope.gain.exponentialRampToValueAtTime(peak, onset + Math.min(0.012, tone.duration / 4))
      envelope.gain.exponentialRampToValueAtTime(0.0001, stop)
      oscillator.connect(envelope)
      envelope.connect(master)
      oscillator.onended = () => {
        activeOscillators.delete(oscillator)
        try { oscillator.disconnect() } catch { /* already disconnected */ }
        try { envelope.disconnect() } catch { /* already disconnected */ }
      }
      activeOscillators.add(oscillator)
      oscillator.start(onset)
      oscillator.stop(stop + 0.02)
      end = Math.max(end, tone.at + tone.duration)
    }
    scheduleIdle(end)
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
