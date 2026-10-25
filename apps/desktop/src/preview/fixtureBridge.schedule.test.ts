// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { rpc } from './fixtureBridge'

const runs = async (schedule: Record<string, unknown>, count = 3) => (await rpc<{ utc: string[] }>('automation.preview', { schedule, count })).utc.map((iso) => new Date(iso))

describe('preview automation.preview', () => {
  it('honours the time of day and the days of a daily or weekday schedule', async () => {
    const daily = await runs({ kind: 'cron', cron: '30 9 * * *', timezone: 'UTC' })
    expect(daily).toHaveLength(3)
    for (const run of daily) expect([run.getHours(), run.getMinutes()]).toEqual([9, 30])
    expect(daily[1]!.getTime() - daily[0]!.getTime()).toBeGreaterThanOrEqual(23 * 3_600_000)
    const weekdays = await runs({ kind: 'cron', cron: '0 7 * * 1-5', timezone: 'UTC' }, 6)
    for (const run of weekdays) expect([1, 2, 3, 4, 5]).toContain(run.getDay())
    const mondays = await runs({ kind: 'cron', cron: '15 18 * * 1', timezone: 'UTC' })
    for (const run of mondays) expect([run.getDay(), run.getHours(), run.getMinutes()]).toEqual([1, 18, 15])
  })

  it('steps every few hours from midnight and returns a one-time instant as chosen', async () => {
    const hourly = await runs({ kind: 'cron', cron: '0 */6 * * *', timezone: 'UTC' }, 4)
    for (const run of hourly) expect([0, 6, 12, 18]).toContain(run.getHours())
    const at = new Date(Date.now() + 5 * 86_400_000).toISOString()
    expect((await runs({ kind: 'once', at }))[0]!.toISOString()).toBe(at)
  })

  it('refuses a cron line that is not five fields', async () => {
    await expect(rpc('automation.preview', { schedule: { kind: 'cron', cron: '0 9 *', timezone: 'UTC' } })).rejects.toBeTruthy()
  })
})
