import { describe, expect, it } from 'vitest'
import { usageTokenBuckets } from './usagePresentation'

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

})
