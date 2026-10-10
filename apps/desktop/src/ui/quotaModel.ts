// Normalized daemon quota snapshots -> display rows. Percentages and reset
// times are shown only when the provider reported them; nothing is inferred.

export type QuotaWindowRow = {
  key: string
  /** Long label for detail views, e.g. "Session" or "Weekly · Opus". */
  label: string
  /** Short label for the status bar, e.g. "5h", "wk", "30d". */
  short: string
  usedPercent: number
  resetsAt: string | null
}

export type QuotaProviderRow = {
  provider: string
  name: string
  windows: QuotaWindowRow[]
  /** Short status when no window is available, or the latest refresh failed. */
  status: string | null
  stale: boolean
  fetchedAt: string | null
}

const PROVIDER_ORDER = ['claude', 'codex', 'opencode']

export function quotaProviderName(provider: string) {
  return provider === 'opencode' ? 'OpenCode Go' : provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : provider
}

const ERROR_STATUS: Record<string, string> = {
  no_credentials: 'Not signed in',
  unauthorized: 'Sign-in expired',
  no_subscription: 'No subscription',
  protocol: 'Unreadable',
  timeout: 'Timed out',
  unavailable: 'Unavailable',
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function windowNames(duration: number | null, limitLabel: string, provider: string, slot: 'primary' | 'secondary') {
  const family = /opus|sonnet|fable|haiku/i.exec(limitLabel)?.[0]
  if (family) return { label: `Weekly · ${family[0].toUpperCase()}${family.slice(1).toLowerCase()}`, short: family.slice(0, 1).toUpperCase() + family.slice(1, 4).toLowerCase() }
  if (duration === 300 || /5-hour/i.test(limitLabel)) return { label: 'Session', short: '5h' }
  if (duration === 10_080 || /weekly/i.test(limitLabel)) return { label: 'Weekly', short: 'wk' }
  if (/monthly/i.test(limitLabel)) return { label: 'Monthly', short: '30d' }
  if (duration !== null) {
    const short = duration % 1440 === 0 ? `${duration / 1440}d` : duration % 60 === 0 ? `${duration / 60}h` : `${duration}m`
    return { label: short, short }
  }
  return { label: provider === 'codex' && limitLabel !== 'Codex' ? limitLabel : slot === 'primary' ? 'Primary' : 'Secondary', short: slot === 'primary' ? 'pri' : 'sec' }
}

export function quotaRows(quotas: Record<string, unknown>[]): QuotaProviderRow[] {
  return quotas
    .filter((item) => PROVIDER_ORDER.includes(String(item.provider)))
    .sort((a, b) => PROVIDER_ORDER.indexOf(String(a.provider)) - PROVIDER_ORDER.indexOf(String(b.provider)))
    .map((item) => {
      const provider = String(item.provider)
      const snapshot = record(item.snapshot)
      const limits = Array.isArray(snapshot.limits) ? snapshot.limits.map(record) : []
      const windows: QuotaWindowRow[] = []
      for (const limit of limits) {
        const limitLabel = String(limit.label ?? '')
        for (const slot of ['primary', 'secondary'] as const) {
          const value = record(limit[slot])
          if (typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent)) continue
          const duration = typeof value.windowDurationMins === 'number' ? value.windowDurationMins : null
          const names = windowNames(duration, limitLabel, provider, slot)
          windows.push({ key: `${limitLabel}-${slot}`, ...names, usedPercent: Math.max(0, Math.min(100, Math.round(value.usedPercent))), resetsAt: typeof value.resetsAt === 'string' ? value.resetsAt : null })
        }
      }
      const lastError = typeof item.lastError === 'string' ? item.lastError : null
      return {
        provider,
        name: quotaProviderName(provider),
        windows,
        status: lastError ? ERROR_STATUS[lastError] ?? 'Unavailable' : windows.length ? null : 'Unavailable',
        stale: !!lastError && windows.length > 0,
        fetchedAt: typeof item.fetchedAt === 'string' ? item.fetchedAt : null,
      }
    })
}

/** "4h 59m", "2d 3h", "12m"; null when the reset time is unknown. */
export function resetIn(resetsAt: string | null, now = Date.now()) {
  if (!resetsAt) return null
  const time = new Date(resetsAt).getTime()
  if (Number.isNaN(time)) return null
  const seconds = Math.max(0, Math.floor((time - now) / 1000))
  if (seconds === 0) return 'now'
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  return `${Math.max(1, Math.ceil(seconds / 60))}m`
}

export function updatedAgo(fetchedAt: string | null, now = Date.now()) {
  if (!fetchedAt) return null
  const time = new Date(fetchedAt).getTime()
  if (Number.isNaN(time)) return null
  const minutes = Math.floor((now - time) / 60_000)
  if (minutes < 2) return 'Updated just now'
  if (minutes < 60) return `Updated ${minutes}m ago`
  return `Updated ${Math.floor(minutes / 60)}h ago`
}

/** Bar tone: calm until 70%, warning to 90%, then critical. */
export function quotaTone(percent: number) {
  return percent >= 90 ? 'critical' : percent >= 70 ? 'warning' : 'normal'
}
