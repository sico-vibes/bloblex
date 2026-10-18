import { useId, type KeyboardEvent } from 'react'
import { RotateCcw } from 'lucide-react'
import { BlobCanvas } from '../blob/BlobCanvas'
import {
  BOT_SHAPES, BOT_SHAPE_LABELS, DEFAULT_SCREEN, DEFAULT_TRIM, SCREEN_SWATCHES, SHELL_SWATCHES, TRIM_SWATCHES,
  resolveBot, type BlobLook, type BotShape, type BotStyle, type BotSwatch,
} from '../blob/look'
import { SwatchGrid } from './SwatchGrid'
import { useEntityNoun } from './vocabulary'
import './bitbotsUi.css'

const CREDIT_URL = 'https://github.com/fayazara/robot-heads'

/**
 * The robot's look while Bitbots mode is on: one of four outlines and three
 * colours. The antenna and the speed are deliberately not offered; they are
 * the same for every robot.
 */
export function BotEditor({ look, color, colorHex, locked = false, onLookChange, onColorChange }: {
  look: BlobLook
  color: string
  colorHex: string
  /** FIX39 item 13 / P5 audit: every control here is inert while the bot is locked. */
  locked?: boolean
  onLookChange: (look: BlobLook) => void
  onColorChange: (color: string) => void
}) {
  const resolved = resolveBot(look, colorHex)
  const noun = useEntityNoun()
  const Noun = useEntityNoun({ capital: true })
  const set = (patch: Partial<BotStyle>) => {
    const next: BotStyle = { ...(look.bot ?? {}), ...patch }
    for (const key of Object.keys(next) as Array<keyof BotStyle>) if (next[key] === undefined) delete next[key]
    onLookChange({ ...look, bot: Object.keys(next).length ? next : undefined })
  }
  const shapeKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (!delta) return
    event.preventDefault()
    const next = BOT_SHAPES[(index + delta + BOT_SHAPES.length) % BOT_SHAPES.length]
    set({ shape: next })
    const group = event.currentTarget.parentElement
    window.requestAnimationFrame(() => group?.querySelector<HTMLButtonElement>(`[data-bot-shape="${next}"]`)?.focus())
  }
  return <div className="bot-editor">
    <div className="bot-shapes" role="radiogroup" aria-label="Robot outline">
      {BOT_SHAPES.map((shape: BotShape, index) => {
        const selected = resolved.shape === shape
        return <button
          key={shape}
          type="button"
          role="radio"
          data-bot-shape={shape}
          aria-checked={selected}
          tabIndex={selected ? 0 : -1}
          disabled={locked}
          className="bot-shape"
          onClick={() => set({ shape })}
          onKeyDown={(event) => shapeKey(event, index)}
        >
          <BlobCanvas decorative color={resolved.shell} size={44} look={{ ...look, bot: { ...resolved, shape } }} label={BOT_SHAPE_LABELS[shape]} />
          <span>{BOT_SHAPE_LABELS[shape]}</span>
        </button>
      })}
    </div>
    <div className="bot-colours">
      <ColourRow title="Shell" hint={look.bot?.shell ? undefined : `Follows the ${noun} colour`} swatches={SHELL_SWATCHES} value={resolved.shell} explicit={!!look.bot?.shell} locked={locked} onPick={(shell) => set({ shell })} onReset={look.bot?.shell ? () => set({ shell: undefined }) : undefined} />
      <ColourRow title="Trim" swatches={TRIM_SWATCHES} value={resolved.trim} explicit={!!look.bot?.trim} fallback={DEFAULT_TRIM} locked={locked} onPick={(trim) => set({ trim })} onReset={look.bot?.trim ? () => set({ trim: undefined }) : undefined} />
      <ColourRow title="Screen" swatches={SCREEN_SWATCHES} value={resolved.screen} explicit={!!look.bot?.screen} fallback={DEFAULT_SCREEN} locked={locked} onPick={(screen) => set({ screen })} onReset={look.bot?.screen ? () => set({ screen: undefined }) : undefined} />
      <div className="bot-colour-row">
        <header><strong>{Noun} colour</strong><span>Mentions and highlights</span></header>
        <SwatchGrid value={color} onChange={onColorChange} disabled={locked} />
      </div>
    </div>
    <p className="bot-fixed-note">Robots by <a href={CREDIT_URL} target="_blank" rel="noopener noreferrer">robot-heads</a> · MIT</p>
  </div>
}

function ColourRow({ title, hint, swatches, value, explicit, fallback, locked = false, onPick, onReset }: {
  title: string
  hint?: string
  swatches: readonly BotSwatch[]
  value: string
  explicit: boolean
  fallback?: string
  locked?: boolean
  onPick: (value: string) => void
  onReset?: () => void
}) {
  const id = useId()
  const preset = swatches.some((swatch) => swatch.value.toLowerCase() === value.toLowerCase())
  const customSelected = explicit && !preset
  return <div className="bot-colour-row">
    <header>
      <strong id={id}>{title}</strong>
      {hint ? <span>{hint}</span> : onReset ? <button type="button" className="ghost-button small" disabled={locked} onClick={onReset} title={`Back to the default ${title.toLowerCase()}`}><RotateCcw size={11} />Default</button> : null}
    </header>
    <div className="bot-swatches" role="radiogroup" aria-labelledby={id}>
      {swatches.map((swatch) => {
        const selected = (explicit || fallback === swatch.value) && swatch.value.toLowerCase() === value.toLowerCase()
        return <button key={swatch.id} type="button" role="radio" aria-checked={selected} disabled={locked} aria-label={swatch.label} title={swatch.label} className="bot-swatch" style={{ ['--swatch' as string]: swatch.value }} onClick={() => onPick(swatch.value)} />
      })}
      <label className="bot-swatch custom" role="radio" aria-checked={customSelected} aria-label={`Custom ${title.toLowerCase()} colour`} title="Custom colour" style={customSelected ? { ['--swatch' as string]: value, background: value } : undefined}>
        <input type="color" disabled={locked} value={value} onChange={(event) => onPick(event.target.value)} />
      </label>
    </div>
  </div>
}
