// C7: the completion peek. A bot other than the focused one whose main session
// goes from busy to idle or completed earns one short banner in the compact bar.
// The trigger and the coalescing are pure so they can be table-tested; the
// companion component only owns the timer and the copy.

export interface PeekSessionState {
  id: string
  state: string | null | undefined
}

/** Session states that mean a turn is in flight. */
const BUSY_STATES = ['working', 'starting']
/** Session states that mean the turn is done and the bot is waiting quietly. */
const FINISHED_STATES = ['idle', 'completed']

/** How long a peek stays on screen before the normal status line returns. */
export const PEEK_VISIBLE_MS = 4_000
/** At most one peek in this window; later finishes fold into the one on screen. */
export const PEEK_WINDOW_MS = 10_000

export interface Peek {
  /** The finished bots, in the order they were first seen. */
  ids: string[]
  /** When the current peek window opened. */
  at: number
}

/**
 * The ids that finished a turn between two snapshots: busy then (`working`,
 * `starting`), finished now (`idle`, `completed`). The focused bot is never
 * included (its mood already shows it), and neither are failed turns (they use
 * the existing error mood).
 */
export function detectFinished(prev: readonly PeekSessionState[], next: readonly PeekSessionState[], focusedId: string | null | undefined): string[] {
  const before = new Map(prev.map((item) => [item.id, String(item.state ?? '').toLowerCase()]))
  const finished: string[] = []
  for (const item of next) {
    if (item.id === focusedId) continue
    const was = before.get(item.id)
    if (!was || !BUSY_STATES.includes(was)) continue
    if (FINISHED_STATES.includes(String(item.state ?? '').toLowerCase())) finished.push(item.id)
  }
  return finished
}

/**
 * The peek to show now: a fresh one, the one on screen with the new ids folded
 * in (within the window), or the previous one unchanged when nothing finished.
 */
export function nextPeek(previous: Peek | null, finished: readonly string[], now: number, windowMs = PEEK_WINDOW_MS): Peek | null {
  if (!finished.length) return previous
  if (previous && now - previous.at < windowMs) {
    const ids = [...previous.ids]
    for (const id of finished) if (!ids.includes(id)) ids.push(id)
    return { ids, at: previous.at }
  }
  return { ids: [...finished], at: now }
}

/** "Claude finished." for one, "3 bots finished." for several. */
export function peekText(names: readonly string[], pluralNoun: string): string {
  if (names.length === 0) return ''
  if (names.length === 1) return `${names[0]} finished.`
  return `${names.length} ${pluralNoun} finished.`
}
