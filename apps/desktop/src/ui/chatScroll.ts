// C10: the chat's scroll behavior. A reply should not yank the view down while
// the person is reading further up; a small pill offers to scroll down instead.
// Pure metric helpers so the rule can be tested against a stub element.

/** How far from the bottom still counts as "at the bottom". */
export const CHAT_STICK_THRESHOLD = 48

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export type ScrollSource = Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>

export function metricsOf(source: ScrollSource | null | undefined): ScrollMetrics | null {
  if (!source) return null
  const { scrollTop, scrollHeight, clientHeight } = source
  if (!Number.isFinite(scrollTop) || !Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) return null
  return { scrollTop, scrollHeight, clientHeight }
}

/** True when the view is close enough to the bottom to follow new content. */
export function isNearBottom(metrics: ScrollMetrics | null, threshold = CHAT_STICK_THRESHOLD): boolean {
  if (!metrics) return true
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold
}

/**
 * The chat window: how many of `total` messages are shown (`shown`), whether
 * the "Load earlier" button is needed (`canLoad`), and the count after one more
 * press (`next`, eight more, never past the total).
 */
export function earlierWindow(current: number, total: number, step = 8): { shown: number; canLoad: boolean; next: number } {
  const shown = Math.min(total, Math.max(0, current))
  return { shown, canLoad: shown < total, next: Math.min(total, shown + step) }
}
