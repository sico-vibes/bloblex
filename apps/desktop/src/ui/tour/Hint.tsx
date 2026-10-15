import { useId } from 'react'
import { Coachmark } from './Coachmark'
import { useAnchorRect } from './useAnchorRect'
import type { Placement } from './placement'

/**
 * A one-time pointer for a moment that matters (first permission request, first
 * plan, context nearly full). It is not modal: the app stays fully usable and the
 * hint simply sits next to its anchor until it is dismissed or the anchor goes.
 * Whether it was seen is owned by the caller (`seen` / `onDismiss`).
 */
export function Hint({ anchor, when = true, seen, onDismiss, placement = 'top', title, body }: {
  anchor: string
  when?: boolean
  seen: boolean
  onDismiss: () => void
  placement?: Placement
  title: string
  body: string
}) {
  const rect = useAnchorRect(when && !seen ? anchor : null)
  const titleId = useId()
  const bodyId = useId()
  if (!when || seen) return null
  return <Coachmark target={rect} placement={placement} labelledBy={titleId} describedBy={bodyId} className="hint"
    onKeyDown={(event) => { if (event.key === 'Escape') onDismiss() }}>
    <h2 id={titleId} className="coach-title">{title}</h2>
    <p id={bodyId} className="coach-body">{body}</p>
    <div className="coach-foot"><span /><button type="button" className="secondary-button small" onClick={onDismiss}>Got it</button></div>
  </Coachmark>
}
