import type { Agent, Session } from '../types'
import { formatUnknownSafe, labelize } from '../types'
import { projectFolderName, sessionDotClass, shortTime } from './rosterSelectors'

export function BlobSessions({ agent, sessions, legacyCount, canCreate, onOpenSession, onNewSession }: {
  agent: Agent | null
  sessions: Session[]
  legacyCount: number
  canCreate: boolean
  onOpenSession: (session: Session) => void
  onNewSession: () => void
}) {
  return <div className="blob-card">
    <h3>Sessions</h3>
    {sessions.length === 0 && <p className="blob-muted">No conversations yet.</p>}
    {sessions.length === 0 && canCreate && <button type="button" className="primary-button" onClick={onNewSession}>New session</button>}
    {sessions.map((session) => <button type="button" className="blob-session-row" key={session.id} onClick={() => onOpenSession(session)}>
      <strong>{formatUnknownSafe(session.title, 'New session')}</strong>
      <span><i className={`status-dot ${sessionDotClass(session.state)}`} /> {labelize(session.state, 'Idle')}</span>
      <small>{projectFolderName(session.projectPath)}</small>
      <small>{session.updatedAt ? shortTime(session.updatedAt) : ''}</small>
    </button>)}
    {legacyCount > 0 && <p className="blob-help">Conversations not linked to a blob stay in the header list.</p>}
    {agent && sessions.length > 0 && canCreate && <button type="button" className="secondary-button" onClick={onNewSession}>New session</button>}
  </div>
}
