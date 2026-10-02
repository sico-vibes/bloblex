import { useEffect, useRef } from 'react'
import type { RecentProject } from './rosterSelectors'

export function ProjectChooser({ agentName, options, position, onChoose, onBrowse, onClose }: {
  agentName: string
  options: RecentProject[]
  position: { x: number; y: number }
  onChoose: (path: string) => void
  onBrowse: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }, [])
  useEffect(() => {
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key === 'Escape') onClose()
      if (event instanceof MouseEvent && ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close) }
  }, [onClose])
  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
    let target = -1
    if (event.key === 'ArrowDown') target = (index + 1) % buttons.length
    else if (event.key === 'ArrowUp') target = (index - 1 + buttons.length) % buttons.length
    else if (event.key === 'Home') target = 0
    else if (event.key === 'End') target = buttons.length - 1
    if (target >= 0 && buttons.length) { event.preventDefault(); event.stopPropagation(); buttons[target]?.focus() }
  }
  return <div ref={ref} className="runtime-context-menu" role="menu" aria-label={`New session for ${agentName}`} onKeyDown={moveFocus} style={{ left: Math.max(8, Math.min(position.x, window.innerWidth - 210)), top: Math.max(8, Math.min(position.y, window.innerHeight - 190)) }}>
    <strong className="runtime-context-title">{agentName}</strong>
    {options.map((option) => <button type="button" role="menuitem" key={option.key} title={option.path} onClick={() => onChoose(option.path)}>{option.label}</button>)}
    <button type="button" role="menuitem" onClick={onBrowse}>Choose folder...</button>
  </div>
}
