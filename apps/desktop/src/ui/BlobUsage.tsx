import type { Agent, Runtime, Session } from '../types'
import { AnalyticsView } from './AnalyticsView'

export function BlobUsage({ agentId, sessions, agents, runtimes, budgets, connected, onSetPrices }: {
  agentId: string | null
  sessions: readonly Session[]
  agents: readonly Agent[]
  runtimes: readonly Runtime[]
  budgets: readonly Record<string, unknown>[]
  connected: boolean
  onSetPrices: () => void
}) {
  if (!agentId) {
    return <section className="blob-card">
      <h3>Usage</h3>
      <p className="blob-muted">Save this blob to see its usage.</p>
    </section>
  }
  return <AnalyticsView agentId={agentId} sessions={sessions} agents={agents} runtimes={runtimes} budgets={budgets} connected={connected} onSetPrices={onSetPrices} embedded />
}
