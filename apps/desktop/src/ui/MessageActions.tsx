import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CornerUpLeft, Copy, RotateCcw, SmilePlus, SquarePen, X } from 'lucide-react'
import { createPortal } from 'react-dom'

export const MESSAGE_REACTIONS = [
  { emoji: '👍', label: 'Thumbs up' },
  { emoji: '👎', label: 'Thumbs down' },
  { emoji: '❤️', label: 'Heart' },
  { emoji: '😂', label: 'Laughing' },
  { emoji: '🎉', label: 'Celebration' },
  { emoji: '😮', label: 'Surprised' },
] as const

export type ReplyTarget = { sourceSessionId: string; messageId: string; author: string; excerpt: string }

export function originalMessageText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((part) => {
    if (typeof part === 'string') return part
    if (!part || typeof part !== 'object') return ''
    const item = part as Record<string, unknown>
    return originalMessageText(item.text ?? item.content ?? item.value)
  }).filter(Boolean).join('\n')
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>
    return originalMessageText(item.text ?? item.content ?? item.value)
  }
  return ''
}

export function messageExcerpt(value: string, limit = 160) {
  const flat = value.split(/\s+/).filter(Boolean).join(' ')
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

export function MessageActions({ text, reactions = [], canReply = true, onReply, onToggleReaction, onError }: {
  text: string
  reactions?: string[]
  canReply?: boolean
  onReply: () => void
  onToggleReaction: (emoji: string) => Promise<unknown> | void
  onError: (error: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 8, top: 8 })
  const previousOpen = useRef(false)
  const close = (restore: boolean) => {
    setOpen(false)
    if (restore) requestAnimationFrame(() => triggerRef.current?.focus())
  }
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node) || pickerRef.current?.contains(event.target as Node)) return
      close(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
    }
    const onBlur = () => close(false)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onBlur)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true); document.removeEventListener('keydown', onKeyDown, true); window.removeEventListener('blur', onBlur) }
  }, [open])
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const anchor = triggerRef.current?.getBoundingClientRect()
      const picker = pickerRef.current?.getBoundingClientRect()
      if (!anchor || !picker) return
      const width = picker.width || 232
      const height = picker.height || 54
      const left = Math.max(8, Math.min(anchor.left + (anchor.width - width) / 2, window.innerWidth - width - 8))
      const below = anchor.bottom + 6
      const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - height - 6)
      setPosition({ left, top })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
  }, [open])
  useEffect(() => {
    if (open && !previousOpen.current) requestAnimationFrame(() => pickerRef.current?.querySelector<HTMLButtonElement>('button')?.focus())
    previousOpen.current = open
  }, [open])
  const choose = async (emoji: string) => {
    try { await onToggleReaction(emoji); close(true) }
    catch { onError('Could not save your reaction. Try again.') }
  }
  const moveReactionFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']
    if (!keys.includes(event.key)) return
    const buttons = Array.from(pickerRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (index < 0 || !buttons.length) return
    const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -3 : event.key === 'ArrowDown' ? 3 : 0
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + delta + buttons.length) % buttons.length
    event.preventDefault()
    buttons[next]?.focus()
  }
  return <div ref={rootRef} className={`message-actions${open ? ' open' : ''}`} role="toolbar" aria-label="Message actions">
    <div className="message-reaction-anchor">
      <button ref={triggerRef} type="button" className="message-action-button" aria-label="React to message" title="React" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <SmilePlus size={15} aria-hidden="true" />
      </button>
      {open && createPortal(<div ref={pickerRef} className="message-reaction-picker" role="dialog" aria-label="Choose a reaction" style={position} onKeyDown={moveReactionFocus}>
        {MESSAGE_REACTIONS.map(({ emoji, label }) => {
          const selected = reactions.includes(emoji)
          return <button key={emoji} type="button" className="message-reaction-option" aria-label={`${selected ? 'Remove' : 'Add'} your ${label.toLowerCase()} reaction`} aria-pressed={selected} title={label} onClick={() => void choose(emoji)}>{emoji}</button>
        })}
      </div>, document.body)}
    </div>
    <button type="button" className="message-action-button" aria-label={canReply ? 'Reply to message' : 'This message cannot be quoted'} title={canReply ? 'Reply' : 'Message text is unavailable'} disabled={!canReply} onClick={onReply}><CornerUpLeft size={15} aria-hidden="true" /></button>
    <button type="button" className="message-action-button" aria-label="Copy message text" title="Copy" disabled={!text} onClick={() => { void navigator.clipboard.writeText(text).catch(() => onError('Could not copy this message.')) }}><Copy size={14} aria-hidden="true" /></button>
  </div>
}

export function MessageReactionBadges({ reactions }: { reactions?: unknown }) {
  const selected = Array.isArray(reactions) ? MESSAGE_REACTIONS.filter(({ emoji }) => reactions.includes(emoji)) : []
  if (!selected.length) return null
  return <span className="message-reaction-badges" role="group" aria-label="Your reactions">
    {selected.map(({ emoji, label }) => <span key={emoji} role="img" aria-label={label} title={label}>{emoji}</span>)}
  </span>
}

export function ReplyContextStrip({ target, compact = false, available = true, onCancel, onJump }: {
  target: Pick<ReplyTarget, 'author' | 'excerpt' | 'messageId' | 'sourceSessionId'>
  compact?: boolean
  available?: boolean
  onCancel?: () => void
  onJump?: (sessionId: string, messageId: string) => void
}) {
  const content = <><CornerUpLeft size={13} aria-hidden="true" /><strong>{target.author}</strong><span className="reply-context-excerpt" title={target.excerpt}>{target.excerpt}</span></>
  return <div className={`reply-context-strip${compact ? ' compact' : ''}`}>
    {compact
      ? available && onJump
        ? <button type="button" className="reply-context-link" aria-label={`Jump to original message from ${target.author}: ${target.excerpt}`} onClick={() => onJump(target.sourceSessionId, target.messageId)}>{content}</button>
        : <span className="reply-context-link unavailable" aria-label={`Quoted message from ${target.author}; original message is unavailable`}>{content}</span>
      : <>
        <span className="reply-context-copy"><CornerUpLeft size={13} aria-hidden="true" /><span>Replying to <strong>{target.author}</strong></span><span className="reply-context-excerpt" title={target.excerpt}>{target.excerpt}</span></span>
        {onCancel && <button type="button" className="reply-context-cancel" aria-label="Cancel reply" title="Cancel reply" onClick={onCancel}><X size={14} aria-hidden="true" /></button>}
      </>}
  </div>
}

export function MessageContextMenu({ position, canRetry, onRetry, onEdit, onClose }: { position: { x: number; y: number }; canRetry: boolean; onRetry: () => void; onEdit: () => void; onClose: (restoreFocus?: boolean) => void }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const firstEnabled = canRetry ? 0 : 1
    requestAnimationFrame(() => itemRefs.current[firstEnabled]?.focus())
    const outside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) closeRef.current(false) }
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(true) } }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true) }
  }, [canRetry])
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const enabled = itemRefs.current.map((item, index) => item && !item.disabled ? index : -1).filter((index) => index >= 0)
    if (!enabled.length) return
    const activeIndex = itemRefs.current.findIndex((item) => item === document.activeElement)
    const current = enabled.indexOf(activeIndex)
    const next = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1)! : enabled[(current + (event.key === 'ArrowDown' ? 1 : enabled.length - 1)) % enabled.length]
    itemRefs.current[next]?.focus()
  }
  const left = Math.max(8, Math.min(position.x, window.innerWidth - 208))
  const top = Math.max(8, Math.min(position.y, window.innerHeight - 96))
  return <div ref={rootRef} className="menu-surface message-context-menu" role="menu" aria-label="Message options" style={{ left, top }} onKeyDown={moveFocus}>
    <button ref={(node) => { itemRefs.current[0] = node }} type="button" role="menuitem" tabIndex={canRetry ? 0 : -1} className="menu-item" disabled={!canRetry} onClick={() => { onClose(false); onRetry() }}><RotateCcw size={14} aria-hidden="true" />Retry as a new prompt</button>
    <button ref={(node) => { itemRefs.current[1] = node }} type="button" role="menuitem" tabIndex={canRetry ? -1 : 0} className="menu-item" onClick={() => { onClose(false); onEdit() }}><SquarePen size={14} aria-hidden="true" />Edit as a new draft</button>
  </div>
}
