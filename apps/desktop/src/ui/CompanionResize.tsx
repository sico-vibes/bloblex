// Resize handles for the frameless, transparent companion window: eight strips on its edges and corners. A drag asks the shell to
// resize the window from the real cursor position (companion_resize_*), so the page never measures the screen itself.
import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { companionResizeBegin, companionResizeEnd, companionResizeStep, type CompanionEdge } from '../tauri'

const EDGES: readonly CompanionEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const LABEL: Record<CompanionEdge, string> = { n: 'top edge', s: 'bottom edge', e: 'right edge', w: 'left edge', ne: 'top right corner', nw: 'top left corner', se: 'bottom right corner', sw: 'bottom left corner' }

export function CompanionResizeHandles({ onStart, onEnd }: { onStart?: () => void; onEnd?: (size: [number, number] | null) => void }) {
  const frame = useRef(0)
  const active = useRef(false)
  const step = () => {
    frame.current = 0
    if (active.current) void companionResizeStep().catch(() => undefined)
  }
  const down = (edge: CompanionEdge) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    active.current = true
    onStart?.()
    void companionResizeBegin(edge).catch(() => { active.current = false })
  }
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!active.current || event.buttons === 0 || frame.current) return
    frame.current = requestAnimationFrame(step)
  }
  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!active.current) return
    active.current = false
    if (frame.current) { cancelAnimationFrame(frame.current); frame.current = 0 }
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    void companionResizeStep().catch(() => undefined).then(() => companionResizeEnd()).then((size) => onEnd?.(size)).catch(() => undefined)
  }
  return <>{EDGES.map((edge) => <div key={edge} className={`cs-resize cs-resize-${edge}`} data-companion-no-drag="" title={`Drag the ${LABEL[edge]} to resize`} aria-hidden="true" onPointerDown={down(edge)} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />)}</>
}
