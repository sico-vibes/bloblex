import type { Session } from '../types'

const cancellableStates = new Set(['starting', 'working', 'waiting_permission', 'waiting_user'])

/** The daemon exposes cancellation rather than a resumable pause operation. */
export function sessionsForPauseRequest(sessions: Session[]) {
  return sessions.filter((session) => cancellableStates.has(session.state ?? ''))
}
