import { BlobCanvas } from '../blob/BlobCanvas'
import type { BlobMood } from '../blob/characterState'
import { LookOrb } from './LookOrb'
import type { ThemeStyle } from './appearance'
import { THEME_LOOKS } from './appearance'
import './lookPicker.css'

/** The look the app ships with, in the order they are offered. */
export const LOOKS = THEME_LOOKS.map((look) => ({ id: look.id, name: look.label, tag: look.family === 'primary' ? 'Primary' : 'Alternative', blurb: look.description }))

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
  const order: ThemeStyle[] = ['bitbots', 'blobots']
  return <div className={`look-orb-picker ${compact ? 'compact' : ''}`} role="radiogroup" aria-label={label}>
    {order.map((id) => {
      const look = LOOKS.find((item) => item.id === id)!
      return <button key={id} type="button" className="look-orb-choice" data-look={id} role="radio" aria-label={look.name} aria-checked={value === id} disabled={disabled} title={look.name} onClick={() => onChange(id)}><LookOrb look={id} size={compact ? 54 : 68} /><span className="look-orb-tooltip">{look.name}</span></button>
    })}
  </div>
}
