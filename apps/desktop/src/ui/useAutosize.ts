import { useLayoutEffect, type RefObject } from 'react'

/**
 * Grows a textarea with its text, up to a limit, then scrolls inside it. A
 * message composer should show what is being written, not one line.
 */
export function useAutosizeTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string, limit: number | (() => number)) {
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const max = typeof limit === 'function' ? limit() : limit
    element.style.height = 'auto'
    const natural = element.scrollHeight
    element.style.height = `${Math.min(natural, max)}px`
    element.style.overflowY = natural > max ? 'auto' : 'hidden'
  }, [ref, value, limit])
}

/** About 40% of the window, never under 120 px or over 360 px. */
export function composerMaxHeight(): number {
  const height = typeof window === 'undefined' ? 800 : window.innerHeight
  return Math.max(120, Math.min(360, Math.round(height * 0.4)))
}
