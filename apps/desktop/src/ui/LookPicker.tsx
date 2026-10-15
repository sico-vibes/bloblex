import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { BlobCanvas } from '../blob/BlobCanvas'
import type { BlobMood } from '../blob/characterState'
import type { ThemeStyle } from './appearance'
import './lookPicker.css'

/** The look the app ships with, in the order they are offered. */
export const LOOKS: ReadonlyArray<{ id: ThemeStyle; name: string; tag: 'Primary' | 'Alternative'; blurb: string }> = [
  { id: 'bitbots', name: 'Bitbots', tag: 'Primary', blurb: 'Pixel robots, square corners and dot-matrix type.' },
  { id: 'blobots', name: 'Blobots', tag: 'Alternative', blurb: 'Soft blobs, rounded corners and a calmer feel.' },
]

/** The same default avatar colour in both looks, so only the style differs. */
export const DEFAULT_AVATAR_COLOUR = '#b7a7f4'

/** The default avatar drawn in one look, whatever look the document itself is in. */
export function LookAvatar({ look, size = 56, mood = 'idle', greeting = false, mini = false }: { look: ThemeStyle; size?: number; mood?: BlobMood; greeting?: boolean; mini?: boolean }) {
  return <BlobCanvas style={look} color={DEFAULT_AVATAR_COLOUR} size={size} mood={mood} greeting={greeting} mini={mini} decorative label={look === 'bitbots' ? 'Bitbot' : 'Blobot'} />
}

/**
 * Two look cards. Choosing one wakes its avatar: it waves, then settles. The
 * card marked Primary is the look the app is designed around.
 */
export function LookPicker({ value, onChange, disabled = false, compact = false, label = 'App look' }: {
  value: ThemeStyle | null
  onChange: (look: ThemeStyle) => void
  disabled?: boolean
  compact?: boolean
  label?: string
}) {
  const [woken, setWoken] = useState<ThemeStyle | null>(null)
  useEffect(() => {
    if (!woken) return
    const timer = window.setTimeout(() => setWoken(null), 1800)
    return () => window.clearTimeout(timer)
  }, [woken])
  return <div className={`look-picker ${compact ? 'compact' : ''}`} role="radiogroup" aria-label={label}>
    {LOOKS.map((look) => {
      const selected = value === look.id
      return <button key={look.id} type="button" role="radio" aria-checked={selected} disabled={disabled}
        className={`look-card ${selected ? 'selected' : ''} ${value && !selected ? 'dim' : ''}`} data-look={look.id}
        onClick={() => { setWoken(look.id); onChange(look.id) }}>
        <span className={`look-tag ${look.tag === 'Primary' ? 'primary' : 'alternative'}`}>{look.tag}</span>
        <span className="look-avatar" aria-hidden="true">
          <LookAvatar key={woken === look.id ? 'wake' : 'rest'} look={look.id} size={compact ? 44 : 72} mood={woken === look.id ? 'success' : 'idle'} greeting={woken === look.id && look.id === 'bitbots'} />
        </span>
        <strong>{look.name}</strong>
        {!compact && <small>{look.blurb}</small>}
        <span className="look-check" aria-hidden="true">{selected && <Check size={13} />}</span>
      </button>
    })}
  </div>
}
