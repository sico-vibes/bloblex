import { useEffect, useRef, useState } from 'react'
import { Check, CircleAlert } from 'lucide-react'
import { friendlyDictationError, type DictationEngineInfo } from './dictation'

// The dictation island: a red recording dot and timer on the left, level bars
// on the right, and the words so far underneath. The bars follow the
// microphone while listening, then keep moving to show what is happening:
// breathing while the model loads, a travelling wave while transcribing, flat
// dots when nothing was heard. Layout and wave motion adapted from Kaze's
// island (MIT, github.com/fayazara/Kaze); see THIRD_PARTY_NOTICES.md.

export type IslandPhase = 'listening' | 'processing' | 'done' | 'silent' | 'error'
type WaveMode = 'live' | 'loading' | 'transcribing' | 'silent'

const BARS = 11

export function DictationIsland({ phase, level, since, stoppedAt, text, warming = false, errorText = '', variant = 'bubble' }: {
  phase: IslandPhase
  /** Latest microphone level from the engine (0 to about 0.3). */
  level: number
  /** When listening started (ms since epoch). */
  since: number | null
  /** When listening stopped; the timer freezes there. */
  stoppedAt?: number | null
  /** The words so far: finished segments plus the current partial. */
  text: string
  /** The model is still loading; audio is queued meanwhile. */
  warming?: boolean
  errorText?: string
  variant?: 'bubble' | 'companion'
  /** Accepted for callers that still pass it; the island never names the engine. */
  engine?: DictationEngineInfo | null
}) {
  const mode: WaveMode = phase === 'processing' ? 'transcribing' : phase === 'silent' ? 'silent' : warming ? 'loading' : 'live'
  const shown = phase === 'error' ? friendlyDictationError(errorText) : lastWords(text)
  const expanded = !!shown && phase !== 'done'
  return <div className={`dictation-island on-${variant} is-${phase} ${expanded ? 'is-expanded' : ''}`} role="status" aria-live="polite" aria-label={label(phase, warming)}>
    <div className="dictation-island-row">
      <span className="dictation-island-lead">
        {phase === 'done' ? <Check size={14} strokeWidth={3} className="dictation-island-check" aria-hidden="true" />
          : phase === 'error' ? <CircleAlert size={14} className="dictation-island-alert" aria-hidden="true" />
          : <>{phase === 'listening' && <span className="dictation-island-dot" aria-hidden="true" />}<Elapsed since={since} until={phase === 'listening' ? null : stoppedAt ?? null} /></>}
        {warming && phase === 'listening' && <span className="dictation-island-note">Getting ready</span>}
        {phase === 'done' && <span className="dictation-island-note">Added to your message</span>}
        {phase === 'silent' && <span className="dictation-island-note">Nothing heard</span>}
      </span>
      {phase !== 'error' && phase !== 'done' && <Wave mode={mode} level={level} />}
    </div>
    {expanded && <p className={`dictation-island-text ${phase === 'error' ? 'error' : ''}`}>{shown}</p>}
  </div>
}

function label(phase: IslandPhase, warming: boolean) {
  if (phase === 'processing') return 'Transcribing'
  if (phase === 'done') return 'Dictation added'
  if (phase === 'silent') return 'Nothing was heard'
  if (phase === 'error') return 'Dictation stopped'
  return warming ? 'Listening, the speech model is loading' : 'Listening'
}

/** Keeps the end of what was said: the newest words matter most. */
export function lastWords(text: string, limit = 150) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `…${flat.slice(flat.length - limit + 1).replace(/^\S*\s/, '')}` : flat
}

function Elapsed({ since, until }: { since: number | null; until: number | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until !== null || since === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [since, until])
  if (since === null) return null
  const seconds = Math.max(0, Math.floor(((until ?? now) - since) / 1000))
  return <span className="dictation-island-time">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>
}

function Wave({ mode, level }: { mode: WaveMode; level: number }) {
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0))
  const [time, setTime] = useState(0)
  const changedAt = useRef(performance.now())
  const frozen = useRef<number[]>(Array(BARS).fill(0))
  const levelsRef = useRef(levels)
  levelsRef.current = levels
  // Newest level on the right.
  useEffect(() => {
    if (mode !== 'live') return
    const value = Math.min(1, Math.pow(Math.max(0, level), 0.58) * 2.1)
    setLevels((current) => [...current.slice(1), value])
  }, [level, mode])
  // Blend from the last live shape so a change of mode never pops.
  useEffect(() => {
    frozen.current = levelsRef.current.map((value) => Math.pow(value, 0.6))
    changedAt.current = performance.now()
  }, [mode])
  useEffect(() => {
    if (mode === 'live' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    let frame = 0
    const tick = (now: number) => { setTime(now); frame = requestAnimationFrame(tick) }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [mode])
  const t = time / 1000
  const blend = Math.min(1, Math.max(0, (time - changedAt.current) / 450))
  const eased = blend * blend * (3 - 2 * blend)
  return <span className={`dictation-island-wave ${mode}`} aria-hidden="true">
    {levels.map((value, index) => {
      const target = mode === 'transcribing' ? 0.22 + 0.6 * (0.5 + 0.5 * Math.sin(t * 6.5 + index * 0.65))
        : mode === 'loading' ? 0.2 + 0.28 * (0.5 + 0.5 * Math.sin(t * 2.4))
        : 0
      const height = mode === 'live' ? Math.pow(value, 0.6) : frozen.current[index] + (target - frozen.current[index]) * eased
      const taper = 0.55 + 0.45 * Math.sin(((index + 1) / (BARS + 1)) * Math.PI)
      const opacity = mode === 'silent' ? 0.35 : 0.5 + 0.45 * height
      return <i key={index} style={{ height: `${Math.max(3, 18 * height * taper)}px`, opacity }} />
    })}
  </span>
}
