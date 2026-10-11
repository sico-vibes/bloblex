import type { ReactNode } from 'react'

/**
 * A small styled tooltip for any control, shown on hover and keyboard focus.
 * It works for controls that are unavailable too, which should use
 * `aria-disabled` rather than `disabled` so they stay focusable.
 */
export function Tip({ text, children, placement = 'top', className = '' }: { text: string; children: ReactNode; placement?: 'top' | 'bottom'; className?: string }) {
  return <span className={`tip ${placement} ${className}`.trim()}>
    {children}
    <span className="tip-bubble" role="tooltip">{text}</span>
  </span>
}
