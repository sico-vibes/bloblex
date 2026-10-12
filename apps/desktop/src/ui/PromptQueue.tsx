// The composer's prompt queue: a banner listing waiting messages and the
// "Send later" popover. State lives in the daemon; this file only renders it.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Clock, Pencil, SendHorizontal, X, CircleAlert } from 'lucide-react'
import type { QueuedPrompt } from '../types'
import { moveMenuFocus, usePopoverDismiss } from './ComposerControls'
import { SEND_LATER_MAX_MS, SEND_LATER_MIN_MS, describeDue, queueRowText, sendLaterPresets, toLocalInputValue } from './queueFormat'

const VISIBLE_ROWS = 3

export interface QueueBannerProps {
  items: readonly QueuedPrompt[]
  paused: boolean
  /** Whether the conversation is mid-turn; "send now" then moves a message to the front instead of sending. */
  sessionBusy: boolean
  nowMs: number
  disabled?: boolean
  onSendNow: (id: string) => void
  onDelete: (id: string) => void
  onUpdate: (id: string, text: string) => void
  onReorder: (ids: string[]) => void
  onResume: () => void
  /** Cancels the pending automatic retry (a queue item of kind `retry`). */
  onCancelRetry?: () => void
}

/** Messages waiting to be sent: scheduled and retry items first, then plain ones in order. */
export function QueueBanner({ items, paused, sessionBusy, nowMs, disabled, onSendNow, onDelete, onUpdate, onReorder, onResume, onCancelRetry }: QueueBannerProps) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const visible = expanded ? items : items.slice(0, VISIBLE_ROWS)
  const hidden = items.length - visible.length
  const plainIds = useMemo(() => items.filter((item) => item.kind === 'user' && item.status === 'queued').map((item) => item.id), [items])
  useEffect(() => { if (editing && !items.some((item) => item.id === editing)) setEditing(null) }, [items, editing])
  if (!items.length) return null

  const move = (id: string, direction: -1 | 1) => {
    const index = plainIds.indexOf(id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= plainIds.length) return
    const next = [...plainIds]
    ;[next[index], next[target]] = [next[target], next[index]]
    onReorder(next)
  }
  const commitEdit = (item: QueuedPrompt) => {
    const text = draft.trim()
    setEditing(null)
    if (text && text !== item.text) onUpdate(item.id, text)
  }
  const failedCount = items.filter((item) => item.status === 'failed').length

  return <section className="queue-banner" aria-label={`Queued messages: ${items.length}`}>
    <header className="queue-head">
      <span className="queue-title">Queued <b>{items.length}</b></span>
      {paused && <span className="queue-paused" role="status">
        {failedCount ? 'Paused: a message could not be sent' : 'Paused until you resume'}
        <button type="button" className="queue-link" disabled={disabled} onClick={onResume}>Resume</button>
      </span>}
    </header>
    <ol className="queue-list">
      {visible.map((item) => {
        const scheduled = item.kind === 'send_later'
        const retry = item.kind === 'retry'
        const failed = item.status === 'failed'
        const plainIndex = plainIds.indexOf(item.id)
        const text = retry ? 'Continue automatically' : queueRowText(item.text, item.attachments?.length ?? 0)
        return <li key={item.id} className={`queue-item${failed ? ' failed' : ''}${item.status === 'sending' ? ' sending' : ''}`}>
          <span className="queue-kind" aria-hidden="true">{failed ? <CircleAlert size={13} /> : scheduled || retry ? <Clock size={13} /> : <span className="queue-dot" />}</span>
          {editing === item.id
            ? <input className="queue-edit" autoFocus value={draft} aria-label="Edit queued message" onChange={(event) => setDraft(event.target.value)} onBlur={() => commitEdit(item)} onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); commitEdit(item) }
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(null) }
              }} />
            : <span className="queue-text" title={item.text || text}>{text}</span>}
          {failed
            ? <span className="queue-meta danger" title={item.error ?? undefined}>{item.error ?? 'Could not be sent'}</span>
            : (scheduled || retry) && <span className="queue-meta">{retry ? 'retrying ' : ''}{item.lateBySecs && item.lateBySecs > 0 ? 'late' : describeDue(item.dueAt, nowMs)}</span>}
          <span className="queue-actions">
            {!failed && !retry && item.status === 'queued' && !editing && item.text && <button type="button" className="queue-icon" disabled={disabled} aria-label="Edit queued message" title="Edit" onClick={() => { setDraft(item.text); setEditing(item.id) }}><Pencil size={12} /></button>}
            {plainIndex > 0 && <button type="button" className="queue-icon" disabled={disabled} aria-label="Move up" title="Move up" onClick={() => move(item.id, -1)}><ChevronUp size={13} /></button>}
            {plainIndex >= 0 && plainIndex < plainIds.length - 1 && <button type="button" className="queue-icon" disabled={disabled} aria-label="Move down" title="Move down" onClick={() => move(item.id, 1)}><ChevronDown size={13} /></button>}
            {item.status !== 'sending' && <button type="button" className="queue-icon" disabled={disabled} aria-label={sessionBusy ? 'Send next' : failed ? 'Try again' : 'Send now'} title={sessionBusy ? 'Send next, when the current turn ends' : failed ? 'Try again' : 'Send now'} onClick={() => onSendNow(item.id)}><SendHorizontal size={12} /></button>}
            {item.status !== 'sending' && <button type="button" className="queue-icon" disabled={disabled} aria-label={retry ? 'Cancel automatic retry' : 'Remove from queue'} title={retry ? 'Cancel automatic retry' : 'Remove'} onClick={() => retry && onCancelRetry ? onCancelRetry() : onDelete(item.id)}><X size={13} /></button>}
          </span>
        </li>
      })}
    </ol>
    {(hidden > 0 || expanded) && items.length > VISIBLE_ROWS && <button type="button" className="queue-link queue-more" onClick={() => setExpanded((value) => !value)}>{expanded ? 'Show fewer' : `Show ${hidden} more`}</button>}
  </section>
}

/** "Send later": quick presets and a custom time; the daemon owns the timer. */
export function SendLaterControl({ disabled, nowMs, onSchedule }: { disabled: boolean; nowMs: number; onSchedule: (dueAt: string) => void }) {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const close = (restoreFocus: boolean) => { setOpen(false); setProblem(null); if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus()) }
  usePopoverDismiss(open, rootRef, close)
  useEffect(() => { if (open) requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()) }, [open])
  const presets = sendLaterPresets(nowMs)
  const min = toLocalInputValue(new Date(nowMs + SEND_LATER_MIN_MS))
  const max = toLocalInputValue(new Date(nowMs + SEND_LATER_MAX_MS))

  const pick = (at: Date) => { close(true); onSchedule(at.toISOString()) }
  const scheduleCustom = () => {
    const at = new Date(custom)
    const delta = at.getTime() - nowMs
    if (!custom || Number.isNaN(at.getTime())) { setProblem('Pick a date and time.'); return }
    if (delta < SEND_LATER_MIN_MS) { setProblem('Pick a time at least a minute from now.'); return }
    if (delta > SEND_LATER_MAX_MS) { setProblem('Pick a time within the next year.'); return }
    pick(at)
  }

  return <div ref={rootRef} className="composer-popover-anchor">
    <button ref={triggerRef} type="button" className="composer-icon-button send-later-trigger" aria-haspopup="menu" aria-expanded={open} aria-label="Send later" title="Send later" disabled={disabled} onClick={() => setOpen((value) => !value)}><Clock size={16} aria-hidden="true" /></button>
    {open && <div ref={menuRef} className="composer-menu send-later-menu align-right" role="menu" aria-label="Send this message later" onKeyDown={(event) => { if (moveMenuFocus(menuRef.current, event.key)) event.preventDefault() }}>
      <div className="composer-menu-heading">Send later</div>
      {presets.map((preset) => <button key={preset.id} type="button" role="menuitem" className="composer-menu-item" onClick={() => pick(preset.at)}>
        <span className="composer-menu-text"><strong>{preset.label}</strong><small>{describeDue(preset.at.toISOString(), nowMs)}</small></span>
      </button>)}
      <div className="send-later-custom">
        <label htmlFor="send-later-time">Pick a time</label>
        <input id="send-later-time" type="datetime-local" value={custom} min={min} max={max} onChange={(event) => { setCustom(event.target.value); setProblem(null) }} />
        {problem && <p className="send-later-problem" role="alert">{problem}</p>}
        <button type="button" className="secondary-button small" onClick={scheduleCustom}>Schedule</button>
      </div>
      <p className="composer-menu-note">Sends only while Bloblex is running and the computer is awake.</p>
    </div>}
  </div>
}
