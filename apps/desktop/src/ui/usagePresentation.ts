export type UnknownRecord = Record<string, unknown>

export function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {}
}

export function records(value: unknown): UnknownRecord[] {
  if (Array.isArray(value)) return value.filter((item): item is UnknownRecord => !!item && typeof item === 'object' && !Array.isArray(item))
  const row = record(value)
  const list = Object.values(row).find(Array.isArray)
  return Array.isArray(list) ? list.filter((item): item is UnknownRecord => !!item && typeof item === 'object' && !Array.isArray(item)) : []
}

export function tokenValue(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unknown'
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

export function moneyMinor(value: unknown, currency: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return 'Unknown'
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: digits }).format(value / (10 ** digits))
  } catch { return 'Unknown' }
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

export function valuationLabel(basis: unknown) {
  if (basis === 'provider_reported_actual') return 'Provider-reported actual'
  if (basis === 'api_rate_estimate') return 'API-rate estimate'
  if (basis === 'subscription_fixed') return 'Subscription fee'
  if (basis === 'local_free') return 'Local/free'
  return 'Unknown valuation'
}
