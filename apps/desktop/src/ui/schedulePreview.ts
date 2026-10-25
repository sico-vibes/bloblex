// The next run times of a schedule, as the daemon computes them with the one parser automations and tasks share.
import { rpc } from '../tauri'
import type { DaemonSchedule } from './automationSchedule'

/** The daemon answers `{ utc: string[], local: string[] }`; older builds and the preview fixture answered `occurrences`. */
export async function previewSchedule(schedule: DaemonSchedule, count = 3): Promise<string[]> {
  const result = await rpc<{ utc?: string[]; occurrences?: Array<string | { local?: string; at?: string }> }>('automation.preview', { schedule, count })
  const zone = schedule.kind === 'cron' ? schedule.timezone : undefined
  const show = (iso: string) => {
    const at = new Date(iso)
    if (Number.isNaN(at.getTime())) return iso
    try { return at.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(zone ? { timeZone: zone } : {}) }) } catch { return at.toLocaleString() }
  }
  const rows = result.utc ?? (result.occurrences ?? []).map((entry) => typeof entry === 'string' ? entry : entry.at ?? entry.local ?? '')
  return rows.filter(Boolean).map(show)
}
