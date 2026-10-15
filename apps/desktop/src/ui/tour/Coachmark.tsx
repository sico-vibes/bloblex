import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { inflate, placeCard, type CardPlacement, type Placement, type Rect } from './placement'
import './tour.css'

export interface CoachmarkProps {
  /** On-screen rectangle of the anchor; `null` renders nothing. */
  target: Rect | null
  placement?: Placement
  /** Dim the rest of the window and ring the target. Tour steps do; hints do not. */
  spotlight?: boolean
  /** Padding between the target and its spotlight ring. */
  pad?: number
  /** Block pointer input outside the target (tour) or leave the app fully usable (hints). */
  modal?: boolean
  labelledBy: string
  describedBy?: string
  className?: string
  children: ReactNode
  onKeyDown?: (event: React.KeyboardEvent) => void
}

const CARD_WIDTH = 328

/**
 * A card with an arrow that points at an anchor, with an optional spotlight.
 * Rendered in a portal above the app; the card is measured after layout so the
 * placement uses its real height. Motion is a short glide; reduced motion turns
 * it off in tour.css.
 */
export function Coachmark({ target, placement = 'bottom', spotlight = false, pad = 6, modal = false, labelledBy, describedBy, className = '', children, onKeyDown }: CoachmarkProps) {
  const card = useRef<HTMLDivElement>(null)
  const [placed, setPlaced] = useState<CardPlacement | null>(null)
  const [size, setSize] = useState({ width: CARD_WIDTH, height: 180 })

  useLayoutEffect(() => {
    const element = card.current
    if (!element) return
    const measured = { width: element.offsetWidth || CARD_WIDTH, height: element.offsetHeight || 180 }
    setSize((previous) => (previous.width === measured.width && previous.height === measured.height ? previous : measured))
  })

  useLayoutEffect(() => {
    if (!target) { setPlaced(null); return }
    setPlaced(placeCard(inflate(target, spotlight ? pad : 0), size, { width: window.innerWidth, height: window.innerHeight }, placement))
  }, [target, size, placement, spotlight, pad])

  if (!target) return null
  const hole = inflate(target, pad)
  const style = placed ? { transform: `translate3d(${Math.round(placed.x)}px, ${Math.round(placed.y)}px, 0)` } : { transform: 'translate3d(-9999px, 0, 0)' }
  return createPortal(<div className={`coach ${modal ? 'modal' : ''} ${className}`} data-spotlight={spotlight ? 'true' : 'false'}>
    {modal && <>
      <div className="coach-shield" style={{ left: 0, top: 0, width: '100vw', height: Math.max(0, hole.y) }} />
      <div className="coach-shield" style={{ left: 0, top: hole.y + hole.height, width: '100vw', bottom: 0 }} />
      <div className="coach-shield" style={{ left: 0, top: hole.y, width: Math.max(0, hole.x), height: hole.height }} />
      <div className="coach-shield" style={{ left: hole.x + hole.width, top: hole.y, right: 0, height: hole.height }} />
    </>}
    {spotlight && <div className="coach-spot" style={{ left: hole.x, top: hole.y, width: hole.width, height: hole.height }} aria-hidden="true" />}
    <div ref={card} className="coach-card" role="dialog" aria-modal="false" aria-labelledby={labelledBy} aria-describedby={describedBy}
      data-placement={placed?.placement ?? placement} style={{ ...style, width: CARD_WIDTH, ['--arrow' as string]: `${placed?.arrowOffset ?? 24}px` }} onKeyDown={onKeyDown}>
      <span className="coach-arrow" aria-hidden="true" />
      {children}
    </div>
  </div>, document.body)
}
