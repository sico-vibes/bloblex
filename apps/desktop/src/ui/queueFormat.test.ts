import { describe, expect, it } from 'vitest'
import { describeDue, queueRowText, sendLaterPresets, toLocalInputValue } from './queueFormat'

describe('queue formatting', () => {
  it('describes a due time relative to now', () => {
    const now = new Date(2026, 9, 12, 10, 0, 0).getTime()
    const local = (day: number, hour: number, minute: number) => new Date(2026, 9, day, hour, minute, 0).toISOString()
    expect(describeDue(null, now)).toBe('')
    expect(describeDue('not a date', now)).toBe('')
    expect(describeDue(local(12, 9, 59), now)).toBe('due now')
    expect(describeDue(new Date(now + 30_000).toISOString(), now)).toBe('in under a minute')
    expect(describeDue(new Date(now + 14 * 60_000).toISOString(), now)).toBe('in 14 min')
    expect(describeDue(local(12, 18, 30), now)).toBe('at 18:30')
    expect(describeDue(local(13, 9, 5), now)).toBe('tomorrow 09:05')
    expect(describeDue(local(20, 7, 0), now)).toMatch(/07:00$/)
  })

  it('offers fixed presets and puts tomorrow morning at 09:00 local the next day', () => {
    const now = new Date(2026, 9, 12, 23, 40, 0).getTime()
    const presets = sendLaterPresets(now)
    expect(presets.map((preset) => preset.id)).toEqual(['15m', '1h', '3h', 'tomorrow'])
    expect(presets[0].at.getTime() - now).toBe(15 * 60_000)
    expect(presets[2].at.getTime() - now).toBe(180 * 60_000)
    const tomorrow = presets[3].at
    expect([tomorrow.getDate(), tomorrow.getHours(), tomorrow.getMinutes()]).toEqual([13, 9, 0])
  })

  it('formats local input values and one-line row text', () => {
    expect(toLocalInputValue(new Date(2026, 0, 5, 7, 4))).toBe('2026-01-05T07:04')
    expect(queueRowText('  fix   the\nbuild  ', 0)).toBe('fix the build')
    expect(queueRowText('', 2)).toBe('2 images')
    expect(queueRowText('   ', 1)).toBe('1 image')
    expect(queueRowText('', 0)).toBe('Empty message')
  })
})
