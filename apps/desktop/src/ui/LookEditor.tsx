import { useId, useState, type KeyboardEvent } from 'react'
import { Dices, RotateCcw, Shuffle } from 'lucide-react'
import { invokeNative } from '../transport/nativeBridge'
import { BlobCanvas, type BlobMood } from '../blob/BlobCanvas'
import { useThemeStyle } from '../blob/bitbots'
import { BotEditor } from './BotEditor'
import {
  BLOB_SHAPES, SHAPE_LABELS, controlsFor, randomBot, resolveBot, shuffleLook, traitPosition, withTrait,
  type BlobLook, type BlobShape, type LookControl,
} from '../blob/look'
import {
  ART_LABELS, BLOB_ARTS, PAINTED_LABELS, PAINTED_SHAPES, ROBOT_ARTS, defaultArtForStyle, resolveArt, resolvePaint,
  type BotArt, type PaintedShape,
} from '../blob/art/art'
import { inDesktop } from '../tauri'
import { SwatchGrid } from './SwatchGrid'
import { AGENT_SWATCHES, swatchForColor } from './agentColor'
import { useEntityNoun } from './vocabulary'
import { HAZE_ICONS, ICON_LABELS, LOGO_ICONS, PIXEL_ICONS, type HazeIcon } from '../blob/haze/icons'
import { rememberLookRuntime, useLookProvider } from '../blob/haze/runtimeRegistry'
import { HazeAura, auraStatusFor } from '../blob/haze/HazeAura'

type LookTab = 'style' | 'tune'

const TABS: ReadonlyArray<{ id: LookTab; label: string }> = [
  { id: 'style', label: 'Shape & colour' },
  { id: 'tune', label: 'Fine-tune' },
]

const PREVIEW_MOODS: ReadonlyArray<{ mood: BlobMood; label: string }> = [
  { mood: 'idle', label: 'Idle' },
  { mood: 'working', label: 'Working' },
  { mood: 'thinking', label: 'Thinking' },
  { mood: 'permission', label: 'Asking' },
  { mood: 'success', label: 'Done' },
  { mood: 'sleeping', label: 'Asleep' },
]

const CREDIT_URL = 'https://blobatar.dev'

function openCredit() {
  if (!inDesktop) { window.open(CREDIT_URL, '_blank', 'noopener,noreferrer'); return }
  void invokeNative('plugin:opener|open_url', { url: CREDIT_URL }).catch(() => undefined)
}

function nextColor(color: string) {
  const choices = AGENT_SWATCHES.filter((swatch) => swatch.key !== swatchForColor(color))
  return choices[Math.floor(Math.random() * choices.length)].key
}

/**
 * A bot's look: an art style, a live stage that previews moods, and the
 * controls the chosen art reads. Every change is a draft until the page saves.
 */
export function LookEditor({ look, color, colorHex, name, locked = false, runtimeId, onLookChange, onColorChange }: {
  look: BlobLook
  /** The bot's runtime, so the Haze look can show its logo. */
  runtimeId?: string | null
  color: string
  colorHex: string
  name: string
  /** FIX39 item 13 / P5 audit: every control here is inert while the bot is locked. */
  locked?: boolean
  /** An optional colour is saved with the look in the same draft update. */
  onLookChange: (look: BlobLook, color?: string) => void
  onColorChange: (color: string) => void
}) {
  const [tab, setTab] = useState<LookTab>('style')
  const [mood, setMood] = useState<BlobMood>('idle')
  const style = useThemeStyle() as string
  const art = resolveArt(look, style)
  const tabsId = useId()
  rememberLookRuntime(look, runtimeId)
  const provider = useLookProvider(look)

  const chooseArt = (next: BotArt | undefined) => {
    if (next) { onLookChange({ ...look, art: next }); return }
    const { art: _art, ...rest } = look
    onLookChange(rest)
  }

  const surprise = () => {
    if (art === 'robot') { onLookChange({ ...look, bot: randomBot(resolveBot(look, colorHex).shape) }); return }
    if (art === 'painted') { onLookChange(shuffleLook(look), nextColor(color)); return }
    if (art === 'blob') { onLookChange(shuffleLook(look), nextColor(color)); return }
    onLookChange(look, nextColor(color))
  }

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = TABS[(index + step + TABS.length) % TABS.length]
    setTab(next.id)
    document.getElementById(`${tabsId}-${next.id}`)?.focus()
  }

  if (style === 'haze') {
    const pick = (icon: HazeIcon) => onLookChange({ ...look, icon })
    const current = look.icon ?? 'logo'
    const option = (icon: HazeIcon) => {
      const preview = { ...look, icon }
      rememberLookRuntime(preview, runtimeId)
      const selected = current === icon
      return <button key={icon} type="button" role="radio" aria-checked={selected} aria-label={ICON_LABELS[icon]} title={ICON_LABELS[icon]} tabIndex={selected ? 0 : -1} disabled={locked || (!provider && !icon.startsWith('px-'))} className={`look-style-option haze-icon-option${selected ? ' selected' : ''}`} onClick={() => pick(icon)}>
        <BlobCanvas decorative color={colorHex} size={icon.startsWith('px-') ? 30 : 26} look={preview} label={ICON_LABELS[icon]} />
      </button>
    }
    const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
      if (!step || locked) return
      event.preventDefault()
      const choices = provider ? HAZE_ICONS : PIXEL_ICONS
      const next = choices[(choices.indexOf(current as never) + step + choices.length) % choices.length]!
      pick(next)
      requestAnimationFrame(() => (event.currentTarget.ownerDocument.querySelector(`.haze-icon-option[aria-label="${ICON_LABELS[next]}"]`) as HTMLElement | null)?.focus())
    }
    return <div className="look-editor haze-look-editor" style={{ ['--look-accent' as string]: colorHex }}>
      <div className="look-stage">
        <div className="look-stage-hero haze-look-hero"><BlobCanvas color={colorHex} size={88} mood={mood} look={look} label={`${name} preview`} /></div>
        <div className="haze-look-row" aria-hidden="true"><HazeAura status={auraStatusFor(mood)} color={colorHex} selected /><BlobCanvas decorative color={colorHex} size={18} look={look} label={name} /><span>{name}</span></div>
        <div className="look-moods" role="radiogroup" aria-label="Preview status">
          {PREVIEW_MOODS.filter((item) => item.mood !== 'sleeping').map((item) => <button key={item.mood} type="button" role="radio" aria-checked={mood === item.mood} disabled={locked} className={mood === item.mood ? 'active' : undefined} onClick={() => setMood(item.mood)}>{item.label}</button>)}
        </div>
      </div>
      <div className="look-panel" role="radiogroup" aria-label="Icon" onKeyDown={onGridKey}>
        <span className="look-section-label">Logo{!provider && ' · choose a coding agent first'}</span>
        <div className="haze-icon-grid logos">{LOGO_ICONS.map(option)}</div>
        <span className="look-section-label">Pixel icon</span>
        <div className="haze-icon-grid">{PIXEL_ICONS.map(option)}</div>
        <div className="look-colour"><span className="look-section-label">Colour</span><SwatchGrid value={color} onChange={onColorChange} disabled={locked} /></div>
      </div>
    </div>
  }

  return <div className="look-editor" style={{ ['--look-accent' as string]: colorHex }}>
    <div className="look-stage">
      <div className="look-stage-hero">
        <BlobCanvas color={colorHex} size={148} mood={mood} look={look} label={`${name} preview`} />
        <div className="look-stage-floor" aria-hidden="true" />
      </div>
      <div className="look-moods" role="radiogroup" aria-label="Preview mood">
        {PREVIEW_MOODS.map((item) => <button key={item.mood} type="button" role="radio" aria-checked={mood === item.mood} disabled={locked} className={mood === item.mood ? 'active' : undefined} onClick={() => setMood(item.mood)}>{item.label}</button>)}
      </div>
      <div className="look-stage-actions">
        {(art === 'blob' || art === 'painted') && <button type="button" className="ghost-button small" disabled={locked} onClick={() => onLookChange(shuffleLook(look))} title={art === 'painted' ? 'New shape, same colour' : 'New eyes, same shape'}><Shuffle size={13} />{art === 'painted' ? 'New shape' : 'Shuffle'}</button>}
        <button type="button" className="ghost-button small" disabled={locked} onClick={surprise} title={art === 'painted' ? 'New shape and colour' : 'New colour'}><Dices size={13} />Surprise me</button>
      </div>
    </div>

    <div className="look-panel">
      <StyleControl art={look.art === 'robot-flat' || look.art === 'robot-dot' ? 'robot-pop' : look.art} style={style} look={look} colorHex={colorHex} locked={locked} onChange={chooseArt} />

      {(art === 'robot' || art === 'robot-pop')
        ? <BotEditor look={look} color={color} colorHex={colorHex} locked={locked} onLookChange={onLookChange} onColorChange={onColorChange} />
        : art === 'painted'
          ? <PaintPanel look={look} color={color} colorHex={colorHex} locked={locked} onLookChange={onLookChange} onColorChange={onColorChange} />
          : art === 'blob'
            ? <div>
              <div className="look-tabs" role="tablist" aria-label="Look">
                {TABS.map((item, index) => <button
                  key={item.id}
                  id={`${tabsId}-${item.id}`}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  aria-controls={`${tabsId}-${item.id}-panel`}
                  tabIndex={tab === item.id ? 0 : -1}
                  disabled={locked}
                  className={tab === item.id ? 'active' : undefined}
                  onClick={() => setTab(item.id)}
                  onKeyDown={(event) => onTabKey(event, index)}
                >{item.label}{item.id === 'tune' && pinnedCount(look) > 0 && <span className="look-tab-count" aria-label={`${pinnedCount(look)} adjusted`}>{pinnedCount(look)}</span>}</button>)}
              </div>

              <div className="look-tab-panel" role="tabpanel" id={`${tabsId}-${tab}-panel`} aria-labelledby={`${tabsId}-${tab}`}>
                {tab === 'style' && <>
                  <ShapeGrid look={look} colorHex={colorHex} locked={locked} onChange={(shape) => onLookChange({ ...look, shape })} />
                  <p className="look-credit">Shapes adapted from <button type="button" className="link-button" onClick={openCredit}>blobatar</button> by Alain · MIT</p>
                  <div className="look-colour"><span className="look-section-label">Colour</span><SwatchGrid value={color} onChange={onColorChange} disabled={locked} /></div>
                </>}
                {tab === 'tune' && <TuneControls look={look} locked={locked} onChange={onLookChange} />}
              </div>
            </div>
            : <ColourPanel color={color} locked={locked} onColorChange={onColorChange} />}
    </div>
  </div>
}

function pinnedCount(look: BlobLook) {
  const visibleKeys = new Set(controlsFor(look.shape).flatMap((group) => group.controls.flatMap(keysOf)))
  return Object.keys(look.traits ?? {}).filter((key) => visibleKeys.has(key)).length
}

function StyleControl({ art, style, look, colorHex, locked, onChange }: {
  art: BotArt | undefined
  style: string
  look: BlobLook
  colorHex: string
  locked: boolean
  onChange: (art: BotArt | undefined) => void
}) {
  const option = (id: BotArt | undefined, label: string) => {
    const selected = id ? art === id : !art
    return <button
      key={id ?? 'auto'}
      type="button"
      role="radio"
      data-style-option={id ?? 'auto'}
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      disabled={locked}
      className={`look-style-option${selected ? ' selected' : ''}`}
      onClick={() => onChange(id)}
    >
      <BlobCanvas decorative color={colorHex} size={40} art={id ?? defaultArtForStyle(style)} look={look} label={label} />
      <span>{label}</span>
    </button>
  }
  return <div className="look-style" role="radiogroup" aria-label="Style">
    {option(undefined, 'Automatic')}
    <div className="look-style-group">
      <span className="look-style-heading">Robots</span>
      <div className="look-style-grid">{ROBOT_ARTS.map((id) => option(id, ART_LABELS[id]))}</div>
    </div>
    <div className="look-style-group">
      <span className="look-style-heading">Blobs</span>
      <div className="look-style-grid">{BLOB_ARTS.map((id) => option(id, ART_LABELS[id]))}</div>
    </div>
  </div>
}

function PaintPanel({ look, color, colorHex, locked, onLookChange, onColorChange }: {
  look: BlobLook
  color: string
  colorHex: string
  locked: boolean
  onLookChange: (look: BlobLook, color?: string) => void
  onColorChange: (color: string) => void
}) {
  const paint = resolvePaint(look)
  return <div className="look-tab-panel">
    <PaintGrid look={look} paint={paint} colorHex={colorHex} locked={locked} onChange={(shape) => onLookChange({ ...look, art: 'painted', paint: shape })} />
    <div className="look-colour"><span className="look-section-label">Colour</span><SwatchGrid value={color} onChange={onColorChange} disabled={locked} /></div>
  </div>
}

function PaintGrid({ look, paint, colorHex, locked, onChange }: { look: BlobLook; paint: PaintedShape; colorHex: string; locked: boolean; onChange: (shape: PaintedShape) => void }) {
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const columns = 4
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? columns : event.key === 'ArrowUp' ? -columns : 0
    if (!delta) return
    event.preventDefault()
    const next = PAINTED_SHAPES[(index + delta + PAINTED_SHAPES.length) % PAINTED_SHAPES.length]
    onChange(next)
    const grid = event.currentTarget.parentElement
    window.requestAnimationFrame(() => grid?.querySelector<HTMLButtonElement>(`[data-paint="${next}"]`)?.focus())
  }
  return <div className="look-shapes" role="radiogroup" aria-label="Painted shape">
    {PAINTED_SHAPES.map((shape, index) => {
      const selected = paint === shape
      return <button
        key={shape}
        type="button"
        role="radio"
        data-paint={shape}
        aria-checked={selected}
        tabIndex={selected ? 0 : -1}
        disabled={locked}
        className={`look-shape${selected ? ' selected' : ''}`}
        onClick={() => onChange(shape)}
        onKeyDown={(event) => move(event, index)}
      >
        <BlobCanvas decorative color={colorHex} size={46} art="painted" look={{ ...look, art: 'painted', paint: shape }} label={PAINTED_LABELS[shape]} />
        <span>{PAINTED_LABELS[shape]}</span>
      </button>
    })}
  </div>
}

function ColourPanel({ color, locked, onColorChange }: { color: string; locked: boolean; onColorChange: (color: string) => void }) {
  return <div className="look-colour">
    <span className="look-section-label">Colour</span>
    <SwatchGrid value={color} onChange={onColorChange} disabled={locked} />
  </div>
}

function ShapeGrid({ look, colorHex, locked = false, onChange }: { look: BlobLook; colorHex: string; locked?: boolean; onChange: (shape: BlobShape) => void }) {
  const Noun = useEntityNoun({ capital: true })
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const columns = 4
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? columns : event.key === 'ArrowUp' ? -columns : 0
    if (!delta) return
    event.preventDefault()
    const next = BLOB_SHAPES[(index + delta + BLOB_SHAPES.length) % BLOB_SHAPES.length]
    onChange(next)
    const grid = event.currentTarget.parentElement
    window.requestAnimationFrame(() => grid?.querySelector<HTMLButtonElement>(`[data-shape="${next}"]`)?.focus())
  }
  return <div className="look-shapes" role="radiogroup" aria-label={`${Noun} shape`}>
    {BLOB_SHAPES.map((shape, index) => {
      const selected = look.shape === shape
      return <button
        key={shape}
        type="button"
        role="radio"
        data-shape={shape}
        aria-checked={selected}
        tabIndex={selected ? 0 : -1}
        disabled={locked}
        className={`look-shape${selected ? ' selected' : ''}`}
        onClick={() => onChange(shape)}
        onKeyDown={(event) => move(event, index)}
      >
        <BlobCanvas decorative color={colorHex} size={46} art="blob" look={{ ...look, shape }} label={SHAPE_LABELS[shape]} />
        <span>{SHAPE_LABELS[shape]}</span>
      </button>
    })}
  </div>
}

function TuneControls({ look, locked = false, onChange }: { look: BlobLook; locked?: boolean; onChange: (look: BlobLook) => void }) {
  const noun = useEntityNoun()
  const groups = controlsFor(look.shape)
  const pinned = look.traits ?? {}
  const reset = () => onChange({ shape: look.shape, seed: look.seed })
  return <div className="look-tune">
    {groups.map((group) => <fieldset key={group.title} className="look-tune-group">
      <legend>{group.title}</legend>
      {group.controls.map((control) => <TraitSlider key={controlKey(control)} look={look} control={control} pinned={keysOf(control).some((key) => key in pinned)} locked={locked} onChange={onChange} />)}
    </fieldset>)}
    <div className="look-tune-footer">
      <span>Untouched sliders follow the {noun}'s own seed. Shuffle to roll a new one.</span>
      <button type="button" className="ghost-button small" disabled={locked || Object.keys(pinned).length === 0} onClick={reset}><RotateCcw size={13} />Reset tweaks</button>
    </div>
  </div>
}

function TraitSlider({ look, control, pinned, locked = false, onChange }: { look: BlobLook; control: LookControl; pinned: boolean; locked?: boolean; onChange: (look: BlobLook) => void }) {
  const id = useId()
  const [first] = keysOf(control)
  const value = traitPosition(look, first)
  const unpin = () => {
    const traits = { ...(look.traits ?? {}) }
    for (const key of keysOf(control)) delete traits[key]
    onChange({ ...look, traits: Object.keys(traits).length ? traits : undefined })
  }
  return <div className={`look-slider${pinned ? ' pinned' : ''}`}>
    <label htmlFor={id}>{control.label}</label>
    <input
      id={id}
      type="range"
      min={0}
      max={1}
      step={0.01}
      disabled={locked}
      value={Math.min(1, Math.round(value * 100) / 100)}
      style={{ ['--fill' as string]: `${value * 100}%` }}
      onChange={(event) => onChange(withTrait(look, control.keys, Number(event.target.value)))}
    />
    <button type="button" className="look-slider-reset" aria-label={`Reset ${control.label.toLowerCase()}`} title="Back to the seed" disabled={locked || !pinned} onClick={unpin}><RotateCcw size={11} /></button>
  </div>
}

const keysOf = (control: LookControl): readonly string[] => typeof control.keys === 'string' ? [control.keys] : control.keys
const controlKey = (control: LookControl) => keysOf(control).join('+')
