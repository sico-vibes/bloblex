import { Plus } from 'lucide-react'
import type { Agent, Session } from '../types'
import { formatUnknownSafe } from '../types'
import { projectFolderName, sessionDotClass, shortTime } from './rosterSelectors'

/** Recent conversations of one blob, as a group on the blob editor. */
export function BlobSessions({ agent, sessions, legacyCount, canCreate, onOpenSession, onNewSession, limit = 6 }: {
  agent: Agent | null
  sessions: Session[]
  legacyCount: number
  canCreate: boolean
  onOpenSession: (session: Session) => void
  onNewSession: () => void
  limit?: number
}) {
  const recent = [...sessions].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))).slice(0, limit)
  return <section className="settings-group blob-group" aria-label="Conversations">
    <div className="settings-group-head">
      <h3>Conversations</h3>
      {agent && canCreate && <button type="button" className="ghost-button small" onClick={onNewSession}><Plus size={13} />New session</button>}
    </div>
    <div className="settings-card">
      {recent.length === 0 && <p className="settings-empty">No conversations yet.</p>}
      {recent.map((session) => {
        const dot = sessionDotClass(session.state)
        return <button type="button" className="settings-row blob-session-row" key={session.id} onClick={() => onOpenSession(session)}>
          <span className="settings-row-copy"><strong>{formatUnknownSafe(session.title, 'New session')}</strong><small>{projectFolderName(session.projectPath)}</small></span>
          {dot !== 'good' && dot !== 'muted' && <i className={`status-dot ${dot}`} aria-hidden="true" />}
          <span className="settings-value">{session.updatedAt ? shortTime(session.updatedAt) : ''}</span>
        </button>
      })}
      {sessions.length > recent.length && <p className="settings-empty">{sessions.length - recent.length} older conversations are in the sidebar.</p>}
      {legacyCount > 0 && <p className="settings-empty">Conversations not linked to a blob stay in the header list.</p>}
    </div>
  </section>
}
