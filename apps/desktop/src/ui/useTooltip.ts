import { useLayoutEffect, useRef, useState } from 'react'
import { placeTooltip, type TipPlacement } from './tooltipPosition'

/**
 * Keeps a portalled tooltip bubble positioned from its trigger's rect and
 * open on hover or focus. `anchor` goes on the trigger's wrapper, `bubble` on
 * the portalled bubble, and `point` is the clamped fixed position to apply.
 * `bind` carries the open/close handlers (hover, focus and Escape).
 */
export function useTooltip<T extends HTMLElement = HTMLElement>(placement: TipPlacement, watch: readonly unknown[] = []) {
  const anchor = useRef<T>(null)
  const bubble = useRef<T>(null)
  const [open, setOpen] = useState(false)
  const [point, setPoint] = useState({ left: 0, top: 0 })
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect()
      if (!rect) return
      const box = bubble.current?.getBoundingClientRect()
      const next = placeTooltip(rect, { width: box?.width || 160, height: box?.height || 32 }, placement)
      setPoint({ left: next.left, top: next.top })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, placement, ...watch])
  const bind = {
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => setOpen(false),
    onFocus: () => setOpen(true),
    onBlur: (event: { currentTarget: HTMLElement; relatedTarget: EventTarget | null }) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
    },
    onKeyDown: (event: { key: string }) => { if (event.key === 'Escape') setOpen(false) },
  }
  return { anchor, bubble, point, open, bind }
}
