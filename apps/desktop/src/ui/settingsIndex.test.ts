import { describe, expect, it } from 'vitest'
import { SETTINGS_INDEX, searchSettings } from './settingsIndex'

describe('searchSettings', () => {
  it('finds a setting by its label, ranking label hits first', () => {
    const results = searchSettings('accent')
    expect(results[0]?.label).toBe('Accent colour')
    expect(results[0]?.page).toBe('Appearance')
  })

  it('finds a setting by a keyword the label does not contain', () => {
    expect(searchSettings('startup')[0]?.label).toBe('Start with Windows')
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

  it('points every entry at a known page', () => {
    const pages = new Set(['General', 'Appearance', 'Agents', 'Memory', 'Speech', 'Updates'])
    for (const entry of SETTINGS_INDEX) expect(pages.has(entry.page)).toBe(true)
  })
})
