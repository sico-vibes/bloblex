import { describe, expect, it } from 'vitest'
import { usageTokenBuckets } from './usagePresentation'

describe('usage presentation', () => {
  it('shows N/A for absent buckets and preserves recorded zeroes and separate categories', () => {
    expect(usageTokenBuckets({ inputTokens: 1200, outputTokens: null, cacheReadTokens: 40, cacheWriteTokens: 0, reasoningTokens: null })).toEqual([
      { key: 'inputTokens', label: 'Input tokens', value: '1,200' },
      { key: 'outputTokens', label: 'Output tokens', value: 'N/A' },
      { key: 'cacheReadTokens', label: 'Cache read tokens', value: '40' },
      { key: 'cacheWriteTokens', label: 'Cache write tokens', value: '0' },
      { key: 'reasoningTokens', label: 'Reasoning tokens', value: 'N/A' },
    ])
  })

  it('uses N/A for every bucket of an empty period', () => {
    expect(usageTokenBuckets({}).map((bucket) => bucket.value)).toEqual(Array(5).fill('N/A'))
  })

})
