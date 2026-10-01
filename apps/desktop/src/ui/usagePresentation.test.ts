import { describe, expect, it } from 'vitest'
import { moneyMinor, records, usageTokenBuckets, valuationLabel } from './usagePresentation'

describe('usage presentation', () => {
  it('keeps unknown token buckets unknown and preserves the mutually-exclusive categories', () => {
    expect(usageTokenBuckets({ inputTokens: 1200, outputTokens: null, cacheReadTokens: 40, cacheWriteTokens: 0, reasoningTokens: null })).toEqual([
      { key: 'inputTokens', label: 'Input tokens', value: '1,200' },
      { key: 'outputTokens', label: 'Output tokens', value: 'Unknown' },
      { key: 'cacheReadTokens', label: 'Cache read tokens', value: '40' },
      { key: 'cacheWriteTokens', label: 'Cache write tokens', value: '0' },
      { key: 'reasoningTokens', label: 'Reasoning tokens', value: 'Unknown' },
    ])
  })

  it('formats monetary minor units only when both amount and currency are known', () => {
    expect(moneyMinor(1240, 'GBP')).toContain('12.40')
    expect(moneyMinor(null, 'GBP')).toBe('Unknown')
    expect(moneyMinor(100, null)).toBe('Unknown')
  })

  it('normalizes wrapped lists and labels cost basis explicitly', () => {
    expect(records({ policies: [{ id: 'one' }] })).toEqual([{ id: 'one' }])
    expect(valuationLabel('api_rate_estimate')).toBe('API-rate estimate')
    expect(valuationLabel('subscription_fixed')).toBe('Subscription fee')
  })
})
