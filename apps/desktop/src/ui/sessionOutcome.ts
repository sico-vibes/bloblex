// What a conversation's status says once its turns are known. A command or tool that fails and is
// worked around leaves a failed row in the history, but it is not the conversation's outcome: the
// latest finished turn is. These helpers keep that in one place (FIX45, 25 October 2026).
import type { Session } from '../types'

const FAILED = new Set(['error', 'failed'])
const turnState = (turn: unknown) => typeof turn === 'object' && turn !== null ? String((turn as { state?: unknown }).state ?? '').toLowerCase() : ''

/** True when the newest recorded turn ended successfully. Unknown (no turns recorded) is false. */
export function latestTurnCompleted(session: Session | null | undefined) {
  const turns = session?.turns
  return !!turns?.length && turnState(turns[turns.length - 1]) === 'completed'
}

/**
 * The session's state as it should be presented. An `error` state left behind by an earlier or
 * recovered failure yields to a newer completed turn; a genuine terminal error (the newest turn
 * itself errored, or no turn is recorded after it) stays an error.
 */
export function presentedSessionState(session: Session | null | undefined): string | undefined {
  const state = session?.state
  if (!state || !FAILED.has(state.toLowerCase())) return state
  return latestTurnCompleted(session) ? 'completed' : state
}
