// Dictation sound cues, adapted from the Waveora bubble (synthesized Web Audio,
// no audio assets). Kept dependency-free and safe to call from any surface.

export type DictationCue = 'record-start' | 'processing-start' | 'processing-finish' | 'error'

type ToneSpec = {
  frequency: number
  durationMs: number
  delayMs: number
  gain: number
  type: OscillatorType
}

const CUES: Record<DictationCue, ToneSpec[]> = {
  'record-start': [
    { frequency: 523, durationMs: 85, delayMs: 0, gain: 0.021, type: 'sine' },
    { frequency: 659, durationMs: 120, delayMs: 100, gain: 0.021, type: 'sine' },
  ],
  'processing-start': [
    { frequency: 494, durationMs: 90, delayMs: 0, gain: 0.022, type: 'sine' },
    { frequency: 622, durationMs: 125, delayMs: 100, gain: 0.022, type: 'sine' },
  ],
  'processing-finish': [
    { frequency: 523, durationMs: 95, delayMs: 0, gain: 0.03, type: 'sine' },
    { frequency: 659, durationMs: 95, delayMs: 120, gain: 0.03, type: 'sine' },
    { frequency: 784, durationMs: 150, delayMs: 240, gain: 0.03, type: 'sine' },
  ],
  error: [
    { frequency: 392, durationMs: 120, delayMs: 0, gain: 0.026, type: 'sine' },
    { frequency: 311, durationMs: 170, delayMs: 140, gain: 0.026, type: 'sine' },
    { frequency: 262, durationMs: 180, delayMs: 310, gain: 0.026, type: 'sine' },
  ],
}

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext }

let context: AudioContext | null = null
let soundsEnabled = true

export function setDictationSoundsEnabled(enabled: boolean) {
  soundsEnabled = enabled
}

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const browserWindow = window as WebkitWindow
  const AudioContextType = window.AudioContext ?? browserWindow.webkitAudioContext
  if (!AudioContextType) return null
  if (!context || context.state === 'closed') context = new AudioContextType()
  if (context.state === 'suspended') void context.resume().catch(() => undefined)
  return context
}

/** Schedule a cue. Silently no-ops when audio is unavailable or muted. */
export function playDictationCue(cue: DictationCue): void {
  if (!soundsEnabled || typeof window === 'undefined' || document.hidden) return
  try {
    const audio = audioContext()
    if (!audio) return
    const now = audio.currentTime + 0.005
    for (const tone of CUES[cue]) {
      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      const start = now + tone.delayMs / 1000
      const end = start + tone.durationMs / 1000
      oscillator.type = tone.type
      oscillator.frequency.setValueAtTime(tone.frequency, start)
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(tone.gain, start + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, end)
      oscillator.connect(gain)
      gain.connect(audio.destination)
      oscillator.start(start)
      oscillator.stop(end + 0.01)
    }
  } catch {
    // Sound feedback is optional.
  }
}
