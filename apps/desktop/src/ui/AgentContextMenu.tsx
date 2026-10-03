import { useEffect, useRef } from 'react'
import { Archive, Copy, Download, Pencil, MessageSquarePlus, Star, StarOff } from 'lucide-react'
import type { Agent } from '../types'

export function AgentContextMenu({ agent, enabled, position, favorite = false, onClose, onNewSession, onEdit, onDuplicate, onArchive, onExport, onToggleFavorite }: {
  agent: Agent
  enabled: { newSession: boolean; duplicate: boolean; archive: boolean }
  position: { x: number; y: number }
  favorite?: boolean
  onClose: () => void
  onNewSession: () => void
  onEdit: () => void
  onDuplicate: () => void
  onArchive: () => void
  onExport?: () => void
  onToggleFavorite?: () => void
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
    if (target >= 0 && buttons.length) { event.preventDefault(); buttons[target]?.focus() }
  }
  return <div ref={ref} className="runtime-context-menu" role="menu" aria-label={`${agent.name} actions`} onKeyDown={moveFocus} style={{ left: Math.max(8, Math.min(position.x, window.innerWidth - 210)), top: Math.max(8, Math.min(position.y, window.innerHeight - 190)) }}>
    <strong className="runtime-context-title">{agent.name}</strong>
    <button type="button" role="menuitem" disabled={!enabled.newSession} onClick={onNewSession}><MessageSquarePlus size={14} />New session</button>
    <button type="button" role="menuitem" onClick={onEdit}><Pencil size={14} />Edit blob</button>
    {onToggleFavorite && <button type="button" role="menuitem" onClick={onToggleFavorite}>{favorite ? <StarOff size={14} /> : <Star size={14} />}{favorite ? 'Remove from favourites' : 'Add to favourites'}</button>}
    <button type="button" role="menuitem" disabled={!enabled.duplicate} onClick={onDuplicate}><Copy size={14} />Duplicate</button>
    {onExport && <button type="button" role="menuitem" onClick={onExport}><Download size={14} />Export blob…</button>}
    <button type="button" role="menuitem" disabled={!enabled.archive} onClick={onArchive}><Archive size={14} />Archive</button>
  </div>
}
