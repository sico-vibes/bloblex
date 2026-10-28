// When each conversation last heard anything from the daemon (a delta, a tool step,
// a state change), in this window. Session timestamps do not move while text
// streams, so the "Waiting for <agent>…" line reads this instead.

const lastHeard = new Map<string, number>()

/** The conversation a daemon event belongs to, if it names one. */
export function eventSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as { sessionId?: unknown; session?: { id?: unknown } }
  if (typeof record.sessionId === 'string') return record.sessionId
  return typeof record.session?.id === 'string' ? record.session.id : null
}

export function noteSessionActivity(sessionId: string, at = Date.now()) { lastHeard.set(sessionId, at) }

export function lastSessionActivity(sessionId: string): number | null { return lastHeard.get(sessionId) ?? null }

/** For tests. */
export function resetSessionActivity() { lastHeard.clear() }
