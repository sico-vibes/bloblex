import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTooltip } from './useTooltip'
import type { TipPlacement } from './tooltipPosition'
import './tooltipPortal.css'

/**
 * A small styled tooltip for any control, shown on hover and keyboard focus.
 * It works for controls that are unavailable too, which should use
 * `aria-disabled` rather than `disabled` so they stay focusable.
 *
 * The bubble renders in a portal on document.body and is clamped to the
 * viewport, so a scrolling or overflow-hidden container never clips it.
 *
 * Pass `describe` when the text carries information the trigger does not
 * otherwise expose; the trigger then points at the bubble with
 * `aria-describedby`, so assistive technology can read it too. It changes
 * nothing for the existing users that leave it off.
 */
export function Tip({ text, children, placement = 'top', className = '', describe = false }: { text: string; children: ReactNode; placement?: TipPlacement; className?: string; describe?: boolean }) {
  const id = useId()
  const { anchor, bubble, point, open, bind } = useTooltip<HTMLSpanElement>(placement, [text])
  const trigger = describe && isValidElement(children)
    ? cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, { 'aria-describedby': id })
    : children
  return <span ref={anchor} className={`tip ${placement} ${className}`.trim()} {...bind}>
    {trigger}
    {createPortal(<span ref={bubble} id={id} className="tip-bubble tip-portal" role="tooltip" data-open={open ? 'true' : 'false'} style={point}>{text}</span>, document.body)}
  </span>
}
