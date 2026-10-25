// The "when" controls shared by automations and tasks: a repeat preset (or a one-time date), its detail inputs, the time zone
// and the next few run times as the daemon computes them. The caller owns the draft and decides which presets it offers.
import { useEffect, useState } from 'react'
import { rpcFailure } from '../executionContract'
import { Select } from './Select'
import { WEEKDAYS, type DaemonSchedule, type ScheduleDraft, type SchedulePreset } from './automationSchedule'
import './schedules.css'

const PRESET_LABELS: Record<SchedulePreset, string> = { daily: 'Every day', weekdays: 'Weekdays', weekly: 'Every week', hours: 'Every few hours', once: 'Once', custom: 'Custom (cron)' }

export function ScheduleWhen({ draft, onChange, schedule, onPreview, presets }: {
  draft: ScheduleDraft
  onChange: (patch: Partial<ScheduleDraft>) => void
  /** The daemon schedule the draft stands for, or null while it is incomplete. */
  schedule: DaemonSchedule | null
  onPreview: (schedule: DaemonSchedule) => Promise<string[]>
  presets: readonly SchedulePreset[]
}) {
  const [preview, setPreview] = useState<string[] | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const scheduleKey = JSON.stringify(schedule)
  useEffect(() => {
    setPreview(null)
    setPreviewError(null)
    if (!schedule) return
    let active = true
    const timer = window.setTimeout(() => {
      onPreview(schedule).then((rows) => { if (active) setPreview(rows) }).catch((reason) => { if (active) setPreviewError(rpcFailure(reason).message) })
    }, 300)
    return () => { active = false; window.clearTimeout(timer) }
  }, [scheduleKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return <>
    <div className="schedule-when">
      {presets.length > 1 && <Select ariaLabel="Repeat" variant="field" value={draft.preset} onChange={(value) => onChange({ preset: value as SchedulePreset })} options={presets.map((value) => ({ value, label: PRESET_LABELS[value] }))} />}
      {(draft.preset === 'daily' || draft.preset === 'weekdays' || draft.preset === 'weekly') && <input type="time" aria-label="Time" value={draft.time} onChange={(event) => onChange({ time: event.target.value })} />}
      {draft.preset === 'weekly' && <Select ariaLabel="Day" variant="field" value={String(draft.weekday)} onChange={(value) => onChange({ weekday: Number(value) })} options={WEEKDAYS.map((label, index) => ({ value: String(index), label }))} />}
      {draft.preset === 'hours' && <Select ariaLabel="Hours between runs" variant="field" value={String(draft.everyHours)} onChange={(value) => onChange({ everyHours: Number(value) })} options={[1, 2, 3, 4, 6, 8, 12].map((n) => ({ value: String(n), label: n === 1 ? 'Every hour' : `Every ${n} hours` }))} />}
      {draft.preset === 'once' && <input type="datetime-local" aria-label="Date and time" value={draft.onceAt} onChange={(event) => onChange({ onceAt: event.target.value })} />}
      {draft.preset === 'custom' && <input aria-label="Cron expression" value={draft.cron} placeholder="m h dom mon dow" onChange={(event) => onChange({ cron: event.target.value })} />}
    </div>
    {draft.preset !== 'once' && <small className="schedule-zone">Time zone: {draft.timezone}</small>}
    <small className={`schedule-preview${previewError ? ' bad' : ''}`} role="status">
      {previewError ?? (schedule ? (preview ? (preview.length ? `Next: ${preview.join(' · ')}` : 'No upcoming runs.') : 'Checking…') : 'Choose a valid time.')}
    </small>
  </>
}
