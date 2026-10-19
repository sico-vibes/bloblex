import { useRef } from 'react'

export type SegmentOption<T extends string> = { value: T; label: string }
export function SegmentedControl<T extends string>({ value, options, label, onChange }: {
  value: T
  options: readonly SegmentOption<T>[]
  label: string
  onChange: (value: T) => void
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const move = (index: number, key: string) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return
    const next = key === 'Home' ? 0 : key === 'End' ? options.length - 1
      : (index + (key === 'ArrowLeft' || key === 'ArrowUp' ? options.length - 1 : 1)) % options.length
    buttons.current[next]?.focus()
    onChange(options[next]!.value)
  }
  return <div className="density-control appearance-segmented" role="radiogroup" aria-label={label}>
    {options.map((option, index) => <button
      key={option.value}
      ref={(node) => { buttons.current[index] = node }}
      type="button"
      role="radio"
      aria-checked={value === option.value}
      tabIndex={value === option.value ? 0 : -1}
      className={value === option.value ? 'active' : ''}
      onClick={() => onChange(option.value)}
      onKeyDown={(event) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.preventDefault(); move(index, event.key) } }}
    >{option.label}</button>)}
  </div>
}
