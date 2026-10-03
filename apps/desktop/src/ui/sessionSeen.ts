import type { Session } from '../types'

export type SeenSessions = Record<string, string>

export function isUnread(session: Session, seen: SeenSessions): boolean {
  const updated = Date.parse(session.updatedAt ?? '')
  const lastSeen = Date.parse(seen[session.id] ?? '')
  return Number.isFinite(updated) && updated > (Number.isFinite(lastSeen) ? lastSeen : 0)
}

export function markSeen(seen: SeenSessions, sessionId: string, at: string): SeenSessions {
  return { ...seen, [sessionId]: at }
}

export function pruneSeen(seen: SeenSessions, sessions: Session[]): SeenSessions {
  const ids = new Set(sessions.map((session) => session.id))
  return Object.fromEntries(Object.entries(seen).filter(([id]) => ids.has(id)))
}

export function initialiseSeen(sessions: Session[], stored: SeenSessions | null): SeenSessions {
  if (stored) return pruneSeen(stored, sessions)
  return Object.fromEntries(sessions.map((session) => [session.id, session.updatedAt ?? new Date(0).toISOString()]))
}

export function unreadNeedsApproval(session: Session, seen: SeenSessions): boolean {
  return isUnread(session, seen) && session.state === 'waiting_permission'
}
