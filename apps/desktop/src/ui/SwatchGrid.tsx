import { useEffect, useRef, useState } from 'react'
import { AGENT_SWATCHES, parseCustomHex, swatchForColor, swatchLabel } from './agentColor'
import { CLIENT_MESSAGES } from './agentForm'

export function SwatchGrid({ value, onChange, disabled = false }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const [text, setText] = useState('')
  const [invalid, setInvalid] = useState(false)
  const selected = swatchForColor(value)

  useEffect(() => {
    const parsedText = parseCustomHex(text)
    const textSwatch = parsedText ? swatchForColor(parsedText) : null
    if (parsedText && (parsedText.toLowerCase() === value.trim().toLowerCase() || (selected && textSwatch === selected))) return
    if (!text.trim() && selected && value.trim().toLowerCase() === selected) return
    if (selected && value.trim().toLowerCase() === selected) {
      setText('')
      setInvalid(false)
      return
    }
    const parsedValue = parseCustomHex(value)
    if (parsedValue) {
      setText(parsedValue)
      setInvalid(false)
      return
    }
    setText(value)
    setInvalid(value.trim().length > 0)
  }, [selected, text, value])

  const move = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1
    if (event.key === 'ArrowRight') next = (index + 1) % AGENT_SWATCHES.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + AGENT_SWATCHES.length) % AGENT_SWATCHES.length
    else if (event.key === 'ArrowDown') next = (index + 6) % AGENT_SWATCHES.length
    else if (event.key === 'ArrowUp') next = (index - 6 + AGENT_SWATCHES.length) % AGENT_SWATCHES.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = AGENT_SWATCHES.length - 1
    else return
    event.preventDefault()
    buttons.current[next]?.focus()
  }

  const edit = (raw: string) => {
    setText(raw)
    if (!raw.trim()) {
      setInvalid(false)
      if (selected) onChange(selected)
      return
    }
    const hex = parseCustomHex(raw)
    if (!hex) {
      setInvalid(true)
      onChange(raw)
      return
    }
    setInvalid(false)
    onChange(swatchForColor(hex) ?? hex)
  }

  return <div className="swatch-field">
    <div className="swatch-grid" role="group" aria-label="Blob colour">
      {AGENT_SWATCHES.map((swatch, index) => {
        const pressed = selected === swatch.key
        const label = swatchLabel(swatch.key)
        return <button
          key={swatch.key}
          type="button"
          ref={(node) => { buttons.current[index] = node }}
          className="swatch"
          aria-pressed={pressed}
          aria-label={pressed ? `${label}, selected` : label}
          disabled={disabled}
          onClick={() => { setText(''); setInvalid(false); onChange(swatch.key) }}
          onKeyDown={(event) => move(event, index)}
        >
          <span className="swatch-chip" style={{ background: swatch.hex }} />
          <span>{label}</span>
        </button>
      })}
    </div>
    <label className="blob-field">
      Custom colour
      <input ref={inputRef} value={text} disabled={disabled} aria-invalid={invalid} aria-describedby={invalid ? 'custom-colour-error' : undefined} onChange={(event) => edit(event.target.value)} onBlur={() => { const hex = parseCustomHex(text); if (hex) setText(hex) }} spellCheck={false} autoCapitalize="off" />
    </label>
    {invalid && <p id="custom-colour-error" className="blob-error" role="alert">{CLIENT_MESSAGES.color}</p>}
  </div>
}
