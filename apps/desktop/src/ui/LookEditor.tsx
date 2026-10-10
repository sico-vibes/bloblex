import { useId, useState, type KeyboardEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Dices, RotateCcw, Shuffle } from 'lucide-react'
import { BlobCanvas, type BlobMood } from '../blob/BlobCanvas'
import {
  BLOB_SHAPES, SHAPE_LABELS, controlsFor, shuffleLook, traitPosition, withTrait,
  type BlobLook, type BlobShape, type LookControl,
} from '../blob/look'
import { inDesktop } from '../tauri'
import { SwatchGrid } from './SwatchGrid'

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
  void invoke('plugin:opener|open_url', { url: CREDIT_URL }).catch(() => undefined)
}

/**
 * The blob's look: a live stage that previews moods, then shape, fine-tuning
 * and colour. Every change is a draft until the page is saved.
 */
export function LookEditor({ look, color, colorHex, name, onLookChange, onColorChange }: {
  look: BlobLook
  color: string
  colorHex: string
  name: string
  onLookChange: (look: BlobLook) => void
  onColorChange: (color: string) => void
}) {
  const [tab, setTab] = useState<LookTab>('style')
  const [mood, setMood] = useState<BlobMood>('idle')
  const tabsId = useId()
  const pinned = Object.keys(look.traits ?? {}).length

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = TABS[(index + step + TABS.length) % TABS.length]
    setTab(next.id)
    document.getElementById(`${tabsId}-${next.id}`)?.focus()
  }

  return <div className="look-editor" style={{ ['--look-accent' as string]: colorHex }}>
    <div className="look-stage">
      <div className="look-stage-hero">
        <BlobCanvas color={colorHex} size={148} mood={mood} look={look} label={`${name} preview`} />
        <div className="look-stage-floor" aria-hidden="true" />
      </div>
      <div className="look-moods" role="radiogroup" aria-label="Preview mood">
        {PREVIEW_MOODS.map((item) => <button key={item.mood} type="button" role="radio" aria-checked={mood === item.mood} className={mood === item.mood ? 'active' : undefined} onClick={() => setMood(item.mood)}>{item.label}</button>)}
      </div>
      <div className="look-stage-actions">
        <button type="button" className="ghost-button small" onClick={() => onLookChange(shuffleLook(look))} title="New face and proportions, same shape"><Shuffle size={13} />Shuffle</button>
        <button type="button" className="ghost-button small" onClick={() => onLookChange(shuffleLook(look, true))} title="A random shape and face"><Dices size={13} />Surprise me</button>
      </div>
    </div>

    <div className="look-panel">
      <div className="look-tabs" role="tablist" aria-label="Look">
        {TABS.map((item, index) => <button
          key={item.id}
          id={`${tabsId}-${item.id}`}
          type="button"
          role="tab"
          aria-selected={tab === item.id}
          aria-controls={`${tabsId}-${item.id}-panel`}
          tabIndex={tab === item.id ? 0 : -1}
          className={tab === item.id ? 'active' : undefined}
          onClick={() => setTab(item.id)}
          onKeyDown={(event) => onTabKey(event, index)}
        >{item.label}{item.id === 'tune' && pinned > 0 && <span className="look-tab-count" aria-label={`${pinned} adjusted`}>{pinned}</span>}</button>)}
      </div>

      <div className="look-tab-panel" role="tabpanel" id={`${tabsId}-${tab}-panel`} aria-labelledby={`${tabsId}-${tab}`}>
        {tab === 'style' && <>
          <ShapeGrid look={look} colorHex={colorHex} onChange={(shape) => onLookChange({ ...look, shape })} />
          <p className="look-credit">Shapes adapted from <button type="button" className="link-button" onClick={openCredit}>blobatar</button> by Alain · MIT</p>
          <div className="look-colour"><span className="look-section-label">Colour</span><SwatchGrid value={color} onChange={onColorChange} /></div>
        </>}
        {tab === 'tune' && <TuneControls look={look} onChange={onLookChange} />}
      </div>

    </div>
  </div>
}

function ShapeGrid({ look, colorHex, onChange }: { look: BlobLook; colorHex: string; onChange: (shape: BlobShape) => void }) {
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const columns = 5
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? columns : event.key === 'ArrowUp' ? -columns : 0
    if (!delta) return
    event.preventDefault()
    const next = BLOB_SHAPES[(index + delta + BLOB_SHAPES.length) % BLOB_SHAPES.length]
    onChange(next)
    const grid = event.currentTarget.parentElement
    window.requestAnimationFrame(() => grid?.querySelector<HTMLButtonElement>(`[data-shape="${next}"]`)?.focus())
  }
  return <div className="look-shapes" role="radiogroup" aria-label="Blob shape">
    {BLOB_SHAPES.map((shape, index) => {
      const selected = look.shape === shape
      return <button
        key={shape}
        type="button"
        role="radio"
        data-shape={shape}
        aria-checked={selected}
        tabIndex={selected ? 0 : -1}
        className={`look-shape${selected ? ' selected' : ''}`}
        onClick={() => onChange(shape)}
        onKeyDown={(event) => move(event, index)}
      >
        <BlobCanvas decorative color={colorHex} size={46} look={{ ...look, shape }} label={SHAPE_LABELS[shape]} />
        <span>{SHAPE_LABELS[shape]}</span>
      </button>
    })}
  </div>
}

function TuneControls({ look, onChange }: { look: BlobLook; onChange: (look: BlobLook) => void }) {
  const groups = controlsFor(look.shape)
  const pinned = look.traits ?? {}
  const reset = () => onChange({ shape: look.shape, seed: look.seed })
  return <div className="look-tune">
    {groups.map((group) => <fieldset key={group.title} className="look-tune-group">
      <legend>{group.title}</legend>
      {group.controls.map((control) => <TraitSlider key={controlKey(control)} look={look} control={control} pinned={keysOf(control).some((key) => key in pinned)} onChange={onChange} />)}
    </fieldset>)}
    <div className="look-tune-footer">
      <span>Untouched sliders follow the blob's own seed. Shuffle to roll a new one.</span>
      <button type="button" className="ghost-button small" disabled={Object.keys(pinned).length === 0} onClick={reset}><RotateCcw size={13} />Reset tweaks</button>
    </div>
  </div>
}

function TraitSlider({ look, control, pinned, onChange }: { look: BlobLook; control: LookControl; pinned: boolean; onChange: (look: BlobLook) => void }) {
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
      value={Math.min(1, Math.round(value * 100) / 100)}
      style={{ ['--fill' as string]: `${value * 100}%` }}
      onChange={(event) => onChange(withTrait(look, control.keys, Number(event.target.value)))}
    />
    <button type="button" className="look-slider-reset" aria-label={`Reset ${control.label.toLowerCase()}`} title="Back to the seed" disabled={!pinned} onClick={unpin}><RotateCcw size={11} /></button>
  </div>
}

const keysOf = (control: LookControl): readonly string[] => typeof control.keys === 'string' ? [control.keys] : control.keys
const controlKey = (control: LookControl) => keysOf(control).join('+')
