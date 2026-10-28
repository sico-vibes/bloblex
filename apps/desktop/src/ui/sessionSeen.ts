import type { Session } from '../types'

export type SeenSessions = Record<string, string>

export function isUnread(session: Session, seen: SeenSessions): boolean {
  const at = attentionAt(session)
  const lastSeen = Date.parse(seen[session.id] ?? '')
  return Number.isFinite(at) && at > (Number.isFinite(lastSeen) ? lastSeen : 0)
}

/** States that ask for the owner count from the moment they happen. */
const ATTENTION_STATES = new Set(['waiting_permission', 'error', 'failed', 'limited'])
/** Teammate messages arrive as user-role rows with these kinds; the owner's own messages never count. */
const TEAM_KINDS = new Set(['blob_reply', 'blob_message', 'blob_update'])

/**
 * When the conversation last said something worth reading: its newest reply, notice or teammate message. A state
 * change alone (warming a conversation, or closing the oldest warm one when another opens) only moves `updatedAt`,
 * and used to leave unread dots on conversations the owner had just switched past (owner report, 28 October 2026).
 */
export function attentionAt(session: Session): number {
  const updated = Date.parse(session.updatedAt ?? '')
  if (ATTENTION_STATES.has(String(session.state ?? ''))) return updated
  const messages = session.messages
  if (!Array.isArray(messages) || messages.length === 0) return updated
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown>
    const role = String(message.role ?? '')
    const kind = String((message.meta as Record<string, unknown> | undefined)?.kind ?? '')
    const counts = role === 'assistant' || role === 'plan' || (role === 'notice' && kind !== 'context_reset') || (role === 'user' && TEAM_KINDS.has(kind))
    if (!counts) continue
    const at = Date.parse(String(message.createdAt ?? ''))
    if (Number.isFinite(at)) return at
  }
  return Number.NaN
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
