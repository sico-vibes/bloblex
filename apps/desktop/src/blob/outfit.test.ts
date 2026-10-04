import { describe, expect, it } from 'vitest'
import { isOutfit, normalizeOutfit, resolveOutfit, seasonalOutfit } from './outfit'

describe('outfit contract', () => {
  it('accepts only the stable outfit ids and defaults missing values to auto', () => {
    expect(isOutfit('round-glasses')).toBe(true)
    expect(isOutfit('bunny-ears')).toBe(false)
    expect(normalizeOutfit(undefined)).toBe('auto')
    expect(normalizeOutfit('unknown')).toBe('auto')
  })

  it('resolves seasonal dates using UTC fields and blob anniversaries', () => {
    expect(seasonalOutfit(new Date('2026-01-01T00:00:00Z'))).toBe('party-hat')
    expect(seasonalOutfit(new Date('2026-10-31T23:59:59Z'))).toBe('witch-hat')
    expect(seasonalOutfit(new Date('2026-12-20T00:00:00Z'))).toBe('santa-hat')
    expect(seasonalOutfit(new Date('2026-10-31T00:00:00Z'), '2024-10-31T12:00:00Z')).toBe('witch-hat')
    expect(seasonalOutfit(new Date('2026-12-25T00:00:00Z'), '2024-12-25T12:00:00Z')).toBe('santa-hat')
    expect(seasonalOutfit(new Date('2026-03-02T23:00:00-08:00'), '2024-03-03T02:00:00Z')).toBe('party-hat')
    expect(resolveOutfit('auto', new Date('2026-05-01T00:00:00Z'))).toBe('none')
    expect(resolveOutfit('crown', new Date('2026-10-31T00:00:00Z'))).toBe('crown')
  })
})
