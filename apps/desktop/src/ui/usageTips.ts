import { quotaRows, resetIn, type QuotaProviderRow, type QuotaWindowRow } from './quotaModel'

export const USAGE_TIP_THRESHOLDS = [75, 90, 100] as const
export const MAX_USAGE_TIP_DISMISSALS = 24
export const MAX_QUOTA_AGE_MS = 15 * 60_000

export type UsageTipDismissal = { provider: string; windowKey: string; resetAt: string | null; threshold: 75 | 90 | 100 }
export type UsageTip = {
  provider: string
  providerName: string
  windowKey: string
  windowLabel: string
  resetAt: string | null
  usedPercent: number
  threshold: 75 | 90 | 100
  dismissal: UsageTipDismissal
}

export function parseUsageTipDismissals(value: unknown): UsageTipDismissal[] {
  if (!Array.isArray(value)) return []
  return value.slice(-MAX_USAGE_TIP_DISMISSALS).flatMap((item): UsageTipDismissal[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const row = item as Record<string, unknown>
    const provider = typeof row.provider === 'string' ? row.provider : ''
    const windowKey = typeof row.windowKey === 'string' ? row.windowKey : ''
    const threshold = row.threshold
    const resetAt = row.resetAt === null || row.resetAt === undefined ? null : typeof row.resetAt === 'string' && Number.isFinite(Date.parse(row.resetAt)) ? new Date(row.resetAt).toISOString() : undefined
    if (!['claude', 'codex', 'opencode'].includes(provider) || !windowKey || !/^[a-z0-9._:-]{1,100}$/i.test(windowKey) || resetAt === undefined || !USAGE_TIP_THRESHOLDS.includes(threshold as 75 | 90 | 100)) return []
    return [{ provider, windowKey, resetAt, threshold: threshold as UsageTipDismissal['threshold'] }]
  })
}

function normalizedWindowKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9._:-]+/g, '_').slice(0, 100) || 'window'
}

function periodReset(window: QuotaWindowRow) {
  if (!window.resetsAt) return null
  const epoch = Date.parse(window.resetsAt)
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null
}

function samePeriod(left: UsageTipDismissal, provider: string, windowKey: string, resetAt: string | null) {
  return left.provider === provider && left.windowKey === windowKey && left.resetAt === resetAt
}

function freshRow(row: QuotaProviderRow, now: number) {
  if (row.stale || row.status || !row.fetchedAt) return false
  const fetched = Date.parse(row.fetchedAt)
  return Number.isFinite(fetched) && fetched <= now + 60_000 && now - fetched <= MAX_QUOTA_AGE_MS
}

export function selectUsageTip(provider: string | null | undefined, quotas: Record<string, unknown>[], dismissedValues: unknown, now = Date.now()): UsageTip | null {
  if (!provider || !['claude', 'codex', 'opencode'].includes(provider)) return null
  const row = quotaRows(quotas).find((candidate) => candidate.provider === provider)
  if (!row || !freshRow(row, now)) return null
  const dismissed = parseUsageTipDismissals(dismissedValues)
  const candidates = row.windows.flatMap((window) => {
    const windowKey = normalizedWindowKey(window.key)
    const resetAt = periodReset(window)
    if (resetAt && Date.parse(resetAt) <= now) return []
    const sameWindow = dismissed.filter((item) => samePeriod(item, row.provider, windowKey, resetAt))
    const highestDismissed = sameWindow.reduce((highest, item) => Math.max(highest, item.threshold), 0)
    const threshold = [...USAGE_TIP_THRESHOLDS].reverse().find((level) => window.usedPercent >= level && level > highestDismissed)
    if (!threshold) return []
    const dismissal: UsageTipDismissal = { provider: row.provider, windowKey, resetAt, threshold }
    return [{
      provider: row.provider,
      providerName: row.name,
      windowKey,
      windowLabel: window.label,
      resetAt,
      usedPercent: window.usedPercent,
      threshold,
      dismissal,
    }]
  })
  return candidates.sort((left, right) => right.threshold - left.threshold || right.usedPercent - left.usedPercent)[0] ?? null
}

export function usageTipCopy(tip: UsageTip, now = Date.now()) {
  const [periodLabel, ...qualifiers] = tip.windowLabel.split(' · ')
  const period = [periodLabel.toLowerCase(), ...qualifiers].join(' ')
  const reset = resetIn(tip.resetAt, now)
  return `You’re at ${tip.usedPercent}% of your ${period} usage limit.${reset ? ` It resets in ${reset}.` : ''}`
}

export function appendUsageTipDismissal(current: unknown, value: UsageTipDismissal): UsageTipDismissal[] {
  const filtered = parseUsageTipDismissals(current).filter((item) => !samePeriod(item, value.provider, value.windowKey, value.resetAt))
  return [...filtered, value].slice(-MAX_USAGE_TIP_DISMISSALS)
}
