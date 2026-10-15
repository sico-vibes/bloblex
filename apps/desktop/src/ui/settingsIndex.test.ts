import { describe, expect, it } from 'vitest'
import { searchSettings, settingsPageFromEvent, SETTINGS_INDEX, SETTINGS_PAGE_NAMES } from './settingsIndex'

describe('searchSettings', () => {
  it('finds a setting by its label, ranking label hits first', () => {
    const results = searchSettings('accent')
    expect(results[0]?.label).toBe('Accent colour')
    expect(results[0]?.page).toBe('Appearance')
  })

  it('finds a setting by a keyword the label does not contain', () => {
    expect(searchSettings('autostart')[0]?.label).toBe('Start with Windows')
    expect(searchSettings('dark')[0]?.label).toBe('Theme')
  })

  it('requires every word to match', () => {
    expect(searchSettings('companion volume').map((entry) => entry.label)).toEqual(['Sounds and volume'])
    expect(searchSettings('zzzz')).toEqual([])
  })

  it('returns nothing for an empty query and respects the limit', () => {
    expect(searchSettings('   ')).toEqual([])
    expect(searchSettings('e', SETTINGS_INDEX, 3).length).toBe(3)
  })

  it('finds the Remote page by phone or mobile, with Devices and Recent activity listed', () => {
    expect(searchSettings('phone').some((entry) => entry.page === 'Remote')).toBe(true)
    expect(searchSettings('mobile')[0]?.page).toBe('Remote')
    const remote = SETTINGS_INDEX.filter((entry) => entry.page === 'Remote')
    expect(remote.some((entry) => entry.group === 'Devices' && entry.label === 'Devices')).toBe(true)
    expect(remote.some((entry) => entry.group === 'Recent activity')).toBe(true)
    expect(remote.map((entry) => entry.group)).toEqual(expect.arrayContaining(['Remote access', 'Add a device', 'Safety']))
  })

  it('points every entry at a known page', () => {
    const pages = new Set(SETTINGS_PAGE_NAMES)
    for (const entry of SETTINGS_INDEX) expect(pages.has(entry.page)).toBe(true)
  })
})

describe('settingsPageFromEvent', () => {
  it('accepts only a known page name', () => {
    expect(settingsPageFromEvent('Remote')).toBe('Remote')
    expect(settingsPageFromEvent('Nope')).toBeNull()
    expect(settingsPageFromEvent(null)).toBeNull()
    expect(settingsPageFromEvent({ page: 'Remote' })).toBeNull()
  })
})
