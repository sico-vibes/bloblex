import type { Agent, Session } from '../types'
import { AnalyticsView } from './AnalyticsView'

export function BlobUsage({ agentId, sessions, agents, connected }: {
  agentId: string | null
  sessions: readonly Session[]
  agents: readonly Agent[]
  connected: boolean
}) {
  if (!agentId) {
    return <section className="blob-card">
      <h3>Usage</h3>
      <p className="blob-muted">Save this blob to see its usage.</p>
    </section>
  }
  return <AnalyticsView agentId={agentId} sessions={sessions} agents={agents} connected={connected} embedded />
}
