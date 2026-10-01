import type { Runtime, Session } from '../types'
import { records } from './usagePresentation'

export function findApplicableBudget(value: unknown, runtime: Runtime | null, session: Session | null, hostId?: string | null) {
  if (!runtime || !session) return null
  const rank: Record<string, number> = { global: 0, host: 1, agent: 2, runtime: 3, project: 4, session: 5 }
  return records(value)
    .filter((policy) => policy.enabled !== false)
    .filter((policy) => {
      const scope = String(policy.scopeType ?? 'global')
      const scopeId = typeof policy.scopeId === 'string' ? policy.scopeId : null
      if (scope === 'global') return true
      if (scope === 'host') return !!scopeId && scopeId === hostId
      if (scope === 'agent') return !!scopeId && scopeId === runtime.provider
      if (scope === 'runtime') return !!scopeId && scopeId === runtime.id
      if (scope === 'project') return !!scopeId && scopeId === session.projectPath
      if (scope === 'session') return !!scopeId && scopeId === session.id
      return false
    })
    .sort((a, b) => (rank[String(b.scopeType ?? 'global')] ?? 0) - (rank[String(a.scopeType ?? 'global')] ?? 0)
      || Number(a.remaining ?? Number.MAX_SAFE_INTEGER) - Number(b.remaining ?? Number.MAX_SAFE_INTEGER)
      || String(a.id ?? '').localeCompare(String(b.id ?? '')))[0] ?? null
}

export function budgetValue(value: unknown, metric: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unknown'
  const formatted = new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
  return metric === 'runtime_minutes' ? `${formatted} min` : metric === 'turns' ? `${formatted} turns` : metric === 'concurrent_sessions' ? `${formatted} sessions` : formatted
}
