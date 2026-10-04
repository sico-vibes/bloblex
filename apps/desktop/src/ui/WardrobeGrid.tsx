import { useRef } from 'react'
import { BlobCanvas } from '../blob/BlobCanvas'
import { OUTFITS, OUTFIT_LABELS, resolveOutfit, type Outfit } from '../blob/outfit'

export function WardrobeGrid({ color, value, createdAt, onChange }: {
  color: string
  value: Outfit
  createdAt?: string | null
  onChange: (outfit: Outfit) => void
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const today = new Date()
  const autoPreview = resolveOutfit('auto', today, createdAt)
  const move = (index: number) => {
    const next = (index + OUTFITS.length) % OUTFITS.length
    onChange(OUTFITS[next])
    buttons.current[next]?.focus()
  }
  return <div className="wardrobe-grid" role="radiogroup" aria-label="Blob outfit">
    {OUTFITS.map((outfit, index) => {
      const resolved = outfit === 'auto' ? autoPreview : outfit
      const selected = outfit === value
      const label = outfit === 'auto' ? `Auto, currently ${OUTFIT_LABELS[autoPreview]}` : OUTFIT_LABELS[outfit]
      return <button
        key={outfit}
        ref={(node) => { buttons.current[index] = node }}
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={label}
        tabIndex={selected ? 0 : -1}
        className={`wardrobe-option${selected ? ' selected' : ''}`}
        onClick={() => onChange(outfit)}
        onKeyDown={(event) => {
          const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
          if (delta) { event.preventDefault(); move(index + delta) }
          if (event.key === 'Home') { event.preventDefault(); move(0) }
          if (event.key === 'End') { event.preventDefault(); move(OUTFITS.length - 1) }
        }}
      >
        <BlobCanvas decorative color={color} size={42} outfit={resolved} createdAt={createdAt} label={`${label} preview`} />
        <span>{outfit === 'auto' ? 'Auto' : OUTFIT_LABELS[outfit]}</span>
      </button>
    })}
  </div>
}
