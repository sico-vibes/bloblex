import { describe, expect, it } from 'vitest'
import { defaultDraft, describeNextRun, describeSchedule, draftToSchedule, presetCron, needsManualRetry, runReasonText, scheduleToDraft } from './automationSchedule'

describe('automation schedule presets', () => {
  it('builds the cron each preset stands for', () => {
    const base = defaultDraft('Europe/Berlin')
    expect(presetCron({ ...base, preset: 'daily', time: '07:05' })).toBe('5 7 * * *')
    expect(presetCron({ ...base, preset: 'weekdays', time: '18:30' })).toBe('30 18 * * 1-5')
    expect(presetCron({ ...base, preset: 'weekly', time: '09:00', weekday: 0 })).toBe('0 9 * * 0')
    expect(presetCron({ ...base, preset: 'hours', everyHours: 4 })).toBe('0 */4 * * *')
    expect(presetCron({ ...base, preset: 'custom', cron: '  */15   8-18 * * 1-5 ' })).toBe('*/15 8-18 * * 1-5')
  })

  it('rejects incomplete or out-of-range choices', () => {
    const base = defaultDraft('UTC')
    expect(presetCron({ ...base, preset: 'daily', time: '25:00' })).toBeNull()
    expect(presetCron({ ...base, preset: 'daily', time: '' })).toBeNull()
    expect(presetCron({ ...base, preset: 'weekly', weekday: 7 })).toBeNull()
    expect(presetCron({ ...base, preset: 'hours', everyHours: 0 })).toBeNull()
    expect(presetCron({ ...base, preset: 'hours', everyHours: 13 })).toBeNull()
    expect(presetCron({ ...base, preset: 'custom', cron: '* * *' })).toBeNull()
    expect(draftToSchedule({ ...base, preset: 'once', onceAt: '' })).toBeNull()
  })

  it('produces daemon schedules with the chosen zone, and an ISO instant for one-time runs', () => {
    const base = defaultDraft('America/New_York')
    expect(draftToSchedule({ ...base, preset: 'daily', time: '09:00' })).toEqual({ kind: 'cron', cron: '0 9 * * *', timezone: 'America/New_York' })
    const once = draftToSchedule({ ...base, preset: 'once', onceAt: '2026-10-20T18:00' })
    expect(once?.kind).toBe('once')
    expect(new Date((once as { at: string }).at).getFullYear()).toBe(2026)
  })

  it('opens an existing schedule on the matching preset and falls back to custom', () => {
    expect(scheduleToDraft({ kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' })).toMatchObject({ preset: 'daily', time: '09:00', timezone: 'UTC' })
    expect(scheduleToDraft({ kind: 'cron', cron: '30 7 * * 1-5', timezone: 'UTC' })).toMatchObject({ preset: 'weekdays', time: '07:30' })
    expect(scheduleToDraft({ kind: 'cron', cron: '0 18 * * 5', timezone: 'UTC' })).toMatchObject({ preset: 'weekly', time: '18:00', weekday: 5 })
    expect(scheduleToDraft({ kind: 'cron', cron: '0 */6 * * *', timezone: 'UTC' })).toMatchObject({ preset: 'hours', everyHours: 6 })
    expect(scheduleToDraft({ kind: 'cron', cron: '*/10 * * * *', timezone: 'UTC' })).toMatchObject({ preset: 'custom', cron: '*/10 * * * *' })
    expect(scheduleToDraft({ kind: 'cron', cron: '0 9 1 * *', timezone: 'UTC' })).toMatchObject({ preset: 'custom' })
    expect(scheduleToDraft({ kind: 'once', at: new Date(2026, 9, 20, 18, 0).toISOString() })).toMatchObject({ preset: 'once', onceAt: '2026-10-20T18:00' })
  })

  it('describes schedules and next runs in plain words', () => {
    expect(describeSchedule({ kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' })).toBe('Every day at 09:00')
    expect(describeSchedule({ kind: 'cron', cron: '30 7 * * 1-5', timezone: 'UTC' })).toBe('Weekdays at 07:30')
    expect(describeSchedule({ kind: 'cron', cron: '0 18 * * 5', timezone: 'UTC' })).toBe('Every Friday at 18:00')
    expect(describeSchedule({ kind: 'cron', cron: '0 */1 * * *', timezone: 'UTC' })).toBe('Every hour')
    expect(describeSchedule({ kind: 'cron', cron: '0 */6 * * *', timezone: 'UTC' })).toBe('Every 6 hours')
    expect(describeSchedule({ kind: 'cron', cron: '5 4 1 * *', timezone: 'UTC' })).toBe('Custom: 5 4 1 * *')
    const now = new Date(2026, 9, 12, 10, 0, 0).getTime()
    expect(describeNextRun(null, now)).toBe('')
    expect(describeNextRun(new Date(now - 1000).toISOString(), now)).toBe('due now')
    expect(describeNextRun(new Date(now + 20 * 60_000).toISOString(), now)).toBe('in 20 min')
    expect(describeNextRun(new Date(now + 3 * 3_600_000 + 5 * 60_000).toISOString(), now)).toBe('in 3 h 5 min')
  })

  it('turns run reasons into calm sentences and ignores unknown codes', () => {
    expect(runReasonText('late:600')).toBe('Started 10 min late')
    expect(runReasonText('late:30')).toBe('')
    expect(runReasonText('still_running')).toBe('The previous run was still going.')
    expect(runReasonText('weird_code')).toBe('')
    expect(runReasonText(null)).toBe('')
    expect(runReasonText('nothing_to_report')).toBe('Nothing to report.')
    expect(runReasonText('error_after_changes')).toBe('It stopped after changing things, so it was not retried on its own.')
  })

  // Wave 13: only a failed run that changed things waits for the owner to retry it.
  it('asks for a manual retry only after a run that changed things failed', () => {
    expect(needsManualRetry({ status: 'failed', reason: 'error_after_changes' })).toBe(true)
    expect(needsManualRetry({ status: 'timeout', reason: 'timeout_after_changes' })).toBe(true)
    expect(needsManualRetry({ status: 'failed', reason: 'error' })).toBe(false)
    expect(needsManualRetry({ status: 'completed', reason: 'nothing_to_report' })).toBe(false)
    expect(needsManualRetry(null)).toBe(false)
  })
})
