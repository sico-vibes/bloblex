// Three-way density choice for the Settings Appearance area. A small exported
// component only: the Director places it. Reads and writes through uiPrefs.
import { setDensity, useDensity, type Density } from './uiPrefs'

const OPTIONS: ReadonlyArray<{ value: Density; label: string }> = [
  { value: 'compact', label: 'Compact' },
  { value: 'default', label: 'Default' },
  { value: 'roomy', label: 'Roomy' },
]

export function DensityControl({ className }: { className?: string }) {
  const density = useDensity()
  return <div className={`density-control${className ? ` ${className}` : ''}`} role="radiogroup" aria-label="Density">
    {OPTIONS.map((option) => <button
      key={option.value}
      type="button"
      role="radio"
      aria-checked={density === option.value}
      className={density === option.value ? 'active' : ''}
      onClick={() => setDensity(option.value)}
    >{option.label}</button>)}
  </div>
}
