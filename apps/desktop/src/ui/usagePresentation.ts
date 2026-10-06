export type UnknownRecord = Record<string, unknown>

export function tokenValue(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unknown'
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

export function usageTokenBuckets(summary: UnknownRecord) {
  return [
    { key: 'inputTokens', label: 'Input tokens', value: tokenValue(summary.inputTokens) },
    { key: 'outputTokens', label: 'Output tokens', value: tokenValue(summary.outputTokens) },
    { key: 'cacheReadTokens', label: 'Cache read tokens', value: tokenValue(summary.cacheReadTokens) },
    { key: 'cacheWriteTokens', label: 'Cache write tokens', value: tokenValue(summary.cacheWriteTokens) },
    { key: 'reasoningTokens', label: 'Reasoning tokens', value: tokenValue(summary.reasoningTokens) },
  ]
}
