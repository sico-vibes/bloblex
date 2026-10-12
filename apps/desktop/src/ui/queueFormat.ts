// Wording and presets for queued and scheduled ("send later") prompts.

const pad = (value: number) => String(value).padStart(2, '0')
const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** "in 14 min", "at 18:30", "tomorrow 09:00" or a short date, for a scheduled prompt. */
export function describeDue(dueAt: string | null | undefined, nowMs: number): string {
  if (!dueAt) return ''
  const due = new Date(dueAt)
  if (Number.isNaN(due.getTime())) return ''
  const diff = due.getTime() - nowMs
  if (diff <= 0) return 'due now'
  if (diff < 60_000) return 'in under a minute'
  if (diff < 60 * 60_000) return `in ${Math.round(diff / 60_000)} min`
  const now = new Date(nowMs)
  if (sameDay(due, now)) return `at ${clock(due)}`
  const tomorrow = new Date(nowMs)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (sameDay(due, tomorrow)) return `tomorrow ${clock(due)}`
  return `${due.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(due)}`
}

export interface SendLaterPreset { id: string; label: string; at: Date }

/** Quick choices for "Send later". Tomorrow morning is always the next local 09:00 after today. */
export function sendLaterPresets(nowMs: number): SendLaterPreset[] {
  const plus = (minutes: number) => new Date(nowMs + minutes * 60_000)
  const morning = new Date(nowMs)
  morning.setDate(morning.getDate() + 1)
  morning.setHours(9, 0, 0, 0)
  return [
    { id: '15m', label: 'In 15 minutes', at: plus(15) },
    { id: '1h', label: 'In 1 hour', at: plus(60) },
    { id: '3h', label: 'In 3 hours', at: plus(180) },
    { id: 'tomorrow', label: 'Tomorrow morning', at: morning },
  ]
}

/** Value for a `datetime-local` input from a Date, in local time. */
export function toLocalInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The daemon accepts times from 5 seconds to 366 days ahead; the picker keeps a comfortable margin. */
export const SEND_LATER_MIN_MS = 60_000
export const SEND_LATER_MAX_MS = 365 * 24 * 60 * 60_000

/** One-line text for a queue row; image-only prompts say so. */
export function queueRowText(text: string, attachmentCount: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (trimmed) return trimmed
  return attachmentCount > 0 ? `${attachmentCount} image${attachmentCount === 1 ? '' : 's'}` : 'Empty message'
}
