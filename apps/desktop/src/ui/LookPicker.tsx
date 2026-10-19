import { Check } from 'lucide-react'
import { BlobCanvas } from '../blob/BlobCanvas'
import type { BlobMood } from '../blob/characterState'
import { LookOrb } from './LookOrb'
import type { ThemeStyle } from './appearance'
import { THEME_LOOKS } from './appearance'
import './lookPicker.css'

/** The look the app ships with, in the order they are offered. */
export const LOOKS = THEME_LOOKS.map((look) => ({ id: look.id, name: look.label, tag: look.family === 'primary' ? 'Primary' : look.family === 'alternative' ? 'Alternative' : 'More', blurb: look.description }))

/** The same default avatar colour in both looks, so only the style differs. */
export const DEFAULT_AVATAR_COLOUR = '#b7a7f4'

/** Kept for the expanded onboarding preview below the look cards. */
export function LookAvatar({ look, size = 56, mood = 'idle', greeting = false, mini = false }: { look: ThemeStyle; size?: number; mood?: BlobMood; greeting?: boolean; mini?: boolean }) {
  return <BlobCanvas style={look} color={DEFAULT_AVATAR_COLOUR} size={size} mood={mood} greeting={greeting} mini={mini} decorative label={look === 'bitbots' ? 'Bitbot' : 'Blobot'} />
}

/**
 * Look cards use fixed material swatches, independent of the active app theme.
 */
export function LookPicker({ value, onChange, disabled = false, compact = false, label = 'App look' }: {
  value: ThemeStyle | null
  onChange: (look: ThemeStyle) => void
  disabled?: boolean
  compact?: boolean
  label?: string
}) {
  const card = (look: typeof LOOKS[number], small = false) => {
      const selected = value === look.id
      return <button key={look.id} type="button" role="radio" aria-checked={selected} disabled={disabled}
        className={`look-card ${selected ? 'selected' : ''} ${value && !selected ? 'dim' : ''} ${small ? 'small' : ''}`} data-look={look.id}
        onClick={() => onChange(look.id)}>
        <span className={`look-tag ${look.tag === 'Primary' ? 'primary' : 'alternative'}`}>{look.tag}</span>
        <span className="look-orb-wrap">
          <LookOrb look={look.id} size={small ? 44 : compact ? 44 : 72} />
        </span>
        <span className="look-card-copy"><strong>{look.name}</strong>{!small && !compact && <small>{look.blurb}</small>}</span>
        <span className="look-check" aria-hidden="true">{selected && <Check size={13} />}</span>
      </button>
  }
  return <div className={`look-picker-wrap ${compact ? 'compact' : ''}`} role="radiogroup" aria-label={label}>
    <div className="look-picker primary-looks">{LOOKS.filter((look) => look.tag !== 'More').map((look) => card(look))}</div>
    <div className="more-looks-label">More looks</div>
    <div className="look-picker more-looks">{LOOKS.filter((look) => look.tag === 'More').map((look) => card(look, true))}</div>
  </div>
}
