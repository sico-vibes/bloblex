import { useEffect, useState } from 'react'
import { rectsEqual, type Rect } from './placement'

/** The element a tour step or hint points at. Components opt in with `data-tour="name"`. */
export function anchorSelector(name: string) {
  return `[data-tour="${name}"]`
}

function visibleRect(element: Element | null): Rect | null {
  if (!element) return null
  const box = element.getBoundingClientRect()
  if (box.width < 1 || box.height < 1) return null
  const style = getComputedStyle(element)
  if (style.visibility === 'hidden' || style.display === 'none') return null
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}

/**
 * Tracks the on-screen rectangle of an anchor. It follows layout changes
 * (resize, scroll, a panel opening) with one frame of polling that only sets
 * state when the rectangle actually moved, which is cheaper and more reliable
 * than observers for an element that may be re-mounted by React at any time.
 * Returns `null` while the anchor is missing or hidden.
 */
export function useAnchorRect(name: string | null, options: { scrollIntoView?: boolean } = {}): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null)
  const scroll = options.scrollIntoView ?? false
  useEffect(() => {
    if (!name) { setRect(null); return }
    let frame = 0
    let last: Rect | null = null
    let scrolled = false
    const tick = () => {
      const element = document.querySelector(anchorSelector(name))
      const next = visibleRect(element)
      if (next && scroll && !scrolled && element) {
        scrolled = true
        const outside = next.y < 0 || next.y + next.height > window.innerHeight || next.x < 0 || next.x + next.width > window.innerWidth
        if (outside) element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' })
      }
      if (!rectsEqual(last, next)) { last = next; setRect(next) }
      frame = window.requestAnimationFrame(tick)
    }
    tick()
    return () => { window.cancelAnimationFrame(frame); setRect(null) }
  }, [name, scroll])
  return rect
}
