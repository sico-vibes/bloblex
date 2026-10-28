// Friendly schedule presets for automations. The daemon stores a 5-field cron
// expression plus an IANA zone, or a one-time instant; this file maps between
// those and the handful of choices the editor offers.

import { entityNoun } from './vocabulary'
import { themeStyle } from '../blob/bitbots'

export type SchedulePreset = 'daily' | 'weekdays' | 'weekly' | 'hours' | 'once' | 'custom'

export interface ScheduleDraft {
  preset: SchedulePreset
  /** `HH:MM`, 24-hour, for daily, weekdays and weekly. */
  time: string
  /** 0 (Sunday) to 6 (Saturday), for weekly. */
  weekday: number
  /** 1 to 12, for "every N hours". */
  everyHours: number
  /** `YYYY-MM-DDTHH:mm`, local, for one-time. */
  onceAt: string
  cron: string
  timezone: string
}

export type DaemonSchedule =
  | { kind: 'cron'; cron: string; timezone: string }
  | { kind: 'once'; at: string }

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

const pad = (value: number) => String(value).padStart(2, '0')
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/

export function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

export function defaultDraft(timezone = localTimeZone()): ScheduleDraft {
  return { preset: 'daily', time: '09:00', weekday: 1, everyHours: 6, onceAt: '', cron: '0 9 * * *', timezone }
}

/** The cron a preset stands for; `null` when the draft is incomplete or invalid. */
export function presetCron(draft: ScheduleDraft): string | null {
  const match = TIME.exec(draft.time)
  const [hour, minute] = match ? [Number(match[1]), Number(match[2])] : [null, null]
  switch (draft.preset) {
    case 'daily': return hour === null ? null : `${minute} ${hour} * * *`
    case 'weekdays': return hour === null ? null : `${minute} ${hour} * * 1-5`
    case 'weekly': return hour === null || draft.weekday < 0 || draft.weekday > 6 ? null : `${minute} ${hour} * * ${draft.weekday}`
    case 'hours': return draft.everyHours >= 1 && draft.everyHours <= 12 ? `0 */${draft.everyHours} * * *` : null
    case 'custom': return draft.cron.trim().split(/\s+/).length === 5 ? draft.cron.trim().replace(/\s+/g, ' ') : null
    default: return null
  }
}

/** Builds the daemon schedule from the draft, or `null` while it is not valid yet. */
export function draftToSchedule(draft: ScheduleDraft): DaemonSchedule | null {
  if (draft.preset === 'once') {
    const at = new Date(draft.onceAt)
    return draft.onceAt && !Number.isNaN(at.getTime()) ? { kind: 'once', at: at.toISOString() } : null
  }
  const cron = presetCron(draft)
  return cron ? { kind: 'cron', cron, timezone: draft.timezone } : null
}

/** Recognises the editor's own presets so an existing schedule opens on the right choice. */
export function scheduleToDraft(schedule: DaemonSchedule, fallbackZone = localTimeZone()): ScheduleDraft {
  const base = defaultDraft(fallbackZone)
  if (schedule.kind === 'once') {
    const at = new Date(schedule.at)
    const local = Number.isNaN(at.getTime()) ? '' : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
    return { ...base, preset: 'once', onceAt: local }
  }
  const draft: ScheduleDraft = { ...base, preset: 'custom', cron: schedule.cron, timezone: schedule.timezone }
  const parts = schedule.cron.trim().split(/\s+/)
  if (parts.length !== 5) return draft
  const [minute, hour, dom, month, dow] = parts
  const num = (value: string) => /^\d{1,2}$/.test(value) ? Number(value) : null
  const everyHours = /^\*\/(\d{1,2})$/.exec(hour)
  if (minute === '0' && everyHours && dom === '*' && month === '*' && dow === '*') {
    const n = Number(everyHours[1])
    if (n >= 1 && n <= 12) return { ...draft, preset: 'hours', everyHours: n }
  }
  const m = num(minute)
  const h = num(hour)
  if (m !== null && h !== null && m <= 59 && h <= 23 && dom === '*' && month === '*') {
    const time = `${pad(h)}:${pad(m)}`
    if (dow === '*') return { ...draft, preset: 'daily', time }
    if (dow === '1-5') return { ...draft, preset: 'weekdays', time }
    const day = num(dow)
    if (day !== null && day >= 0 && day <= 6) return { ...draft, preset: 'weekly', time, weekday: day }
  }
  return draft
}

/** One line for a list row: "Every day at 09:00", "Weekdays at 07:30", "Every 6 hours", "Once on 14 Oct 18:00". */
export function describeSchedule(schedule: DaemonSchedule): string {
  const draft = scheduleToDraft(schedule)
  switch (draft.preset) {
    case 'daily': return `Every day at ${draft.time}`
    case 'weekdays': return `Weekdays at ${draft.time}`
    case 'weekly': return `Every ${WEEKDAYS[draft.weekday]} at ${draft.time}`
    case 'hours': return draft.everyHours === 1 ? 'Every hour' : `Every ${draft.everyHours} hours`
    case 'once': {
      const at = new Date(draft.onceAt)
      return Number.isNaN(at.getTime()) ? 'Once' : `Once on ${at.toLocaleDateString([], { day: 'numeric', month: 'short' })} at ${pad(at.getHours())}:${pad(at.getMinutes())}`
    }
    default: return `Custom: ${draft.cron}`
  }
}

/** "in 3 h", "in 12 min", "tomorrow 09:00" style text for a next-run instant. */
export function describeNextRun(next: string | null | undefined, nowMs: number): string {
  if (!next) return ''
  const at = new Date(next)
  if (Number.isNaN(at.getTime())) return ''
  const diff = at.getTime() - nowMs
  if (diff <= 0) return 'due now'
  if (diff < 60_000) return 'in under a minute'
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)} min`
  if (diff < 24 * 3_600_000) {
    const hours = Math.floor(diff / 3_600_000)
    const minutes = Math.round((diff % 3_600_000) / 60_000)
    return minutes ? `in ${hours} h ${minutes} min` : `in ${hours} h`
  }
  return `${at.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export const RUN_STATUS_LABEL: Record<string, string> = {
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  timeout: 'Timed out',
  interrupted: 'Interrupted',
}

/** A failed run that changed things is never retried by the daemon: the owner decides (wave 13). */
export function needsManualRetry(run: { status?: string; reason?: string | null } | null | undefined): boolean {
  return !!run && (run.status === 'failed' || run.status === 'timeout') && !!run.reason?.endsWith('_after_changes')
}

export function runReasonText(reason: string | null | undefined): string {
  if (!reason) return ''
  if (reason.startsWith('late:')) {
    const secs = Number(reason.slice(5))
    return Number.isFinite(secs) && secs >= 60 ? `Started ${Math.round(secs / 60)} min late` : ''
  }
  switch (reason) {
    case 'still_running': return 'The previous run was still going.'
    case 'nothing_to_report': return 'Nothing to report.'
    case 'error_after_changes': return 'It stopped after changing things, so it was not retried on its own.'
    case 'timeout_after_changes': return 'It ran out of time after changing things, so it was not retried on its own.'
    case 'busy': return `The ${entityNoun(themeStyle())} was busy for too long.`
    default: return ''
  }
}
