import { useEffect, useRef, type CSSProperties } from 'react'
import { percentToSoundVolume, soundVolumeToPercent } from '../blob/soundVolume'

/** How long a keyboard or wheel change waits before it counts as "released". */
const SETTLE_MS = 450

/**
 * The companion sounds volume: a native range input from 0 to 100 in 5% steps.
 * `onChange` follows every movement so the level can be applied live and
 * silently; `onCommit` fires once when the control is released (pointer up, a
 * key up, blur, or a short pause after a keyboard step) so the caller can save
 * the value and play one preview cue instead of one per pixel of drag.
 */
export function SoundVolumeSlider({ value, onChange, onCommit, onPlaySample, label = 'Companion sound volume', disabled = false }: {
  /** The volume as a 0 to 1 fraction. */
  value: number
  onChange: (volume: number) => void
  onCommit: (volume: number) => void
  /** Play one cue at the current volume; the button only renders when given. */
  onPlaySample?: () => void
  label?: string
  disabled?: boolean
}) {
  const dragging = useRef(false)
  const pending = useRef<number | null>(null)
  const timer = useRef<number | null>(null)
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit
  const percent = soundVolumeToPercent(value)

  const commit = () => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null }
    if (pending.current === null) return
    const volume = pending.current
    pending.current = null
    onCommitRef.current(volume)
  }
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current) }, [])

  return <span className="volume-slider">
    <input
      type="range"
      className="volume-range"
      min={0}
      max={100}
      step={5}
      value={percent}
      disabled={disabled}
      aria-label={label}
      aria-valuetext={`${percent}%`}
      style={{ '--fill': `${percent}%` } as CSSProperties}
      onChange={(event) => {
        const volume = percentToSoundVolume(Number(event.currentTarget.value))
        pending.current = volume
        onChange(volume)
        if (!dragging.current) {
          if (timer.current !== null) window.clearTimeout(timer.current)
          timer.current = window.setTimeout(commit, SETTLE_MS)
        }
      }}
      onPointerDown={() => { dragging.current = true }}
      onPointerUp={() => { dragging.current = false; commit() }}
      onPointerCancel={() => { dragging.current = false; commit() }}
      onKeyUp={commit}
      onBlur={() => { dragging.current = false; commit() }}
    />
    <output className="volume-value" aria-hidden="true">{percent}%</output>
    {onPlaySample && <button type="button" className="ghost-button small" onClick={onPlaySample} disabled={disabled}>Play sample</button>}
  </span>
}
