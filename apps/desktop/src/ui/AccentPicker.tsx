import { useId } from 'react'
import { Check } from 'lucide-react'
import { normalizeAccent } from './appearance'
import './lookPicker.css'

/** '' is the neutral default (the ink colour itself). */
const SWATCHES: ReadonlyArray<{ value: string; name: string }> = [
  { value: '', name: 'Neutral' },
  { value: '#8b7cf6', name: 'Violet' },
  { value: '#4c8dff', name: 'Blue' },
  { value: '#22b8cf', name: 'Cyan' },
  { value: '#3fb97f', name: 'Green' },
  { value: '#f0b84a', name: 'Amber' },
  { value: '#f0814a', name: 'Orange' },
  { value: '#ef5b5b', name: 'Red' },
  { value: '#e46ba8', name: 'Pink' },
]

/** Accent colour: a short row of swatches plus a free colour input. Applies to both looks. */
export function AccentPicker({ value, onChange, disabled = false }: { value: string; onChange: (hex: string) => void; disabled?: boolean }) {
  const current = normalizeAccent(value)
  const preset = SWATCHES.some((swatch) => swatch.value === current)
  const inputId = useId()
  return <div className="accent-picker" role="radiogroup" aria-label="Accent colour">
    {SWATCHES.map((swatch) => {
      const selected = swatch.value === current
      return <button key={swatch.name} type="button" role="radio" aria-checked={selected} aria-label={swatch.name} title={swatch.name} disabled={disabled}
        className={`accent-swatch ${swatch.value ? '' : 'neutral'} ${selected ? 'selected' : ''}`} style={swatch.value ? { ['--swatch' as string]: swatch.value } : undefined}
        onClick={() => onChange(swatch.value)}>{selected && <Check size={12} />}</button>
    })}
    <label className={`accent-swatch custom ${!preset ? 'selected' : ''}`} htmlFor={inputId} title="Custom colour" style={!preset ? { ['--swatch' as string]: current } : undefined}>
      <input id={inputId} type="color" aria-label="Custom accent colour" disabled={disabled} value={current || '#8b7cf6'} onChange={(event) => onChange(normalizeAccent(event.target.value))} />
      {!preset && <Check size={12} />}
    </label>
  </div>
}
