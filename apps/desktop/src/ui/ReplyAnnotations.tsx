// Phase 1B: annotate a reply. Select part of a bot's reply, write a note, and it
// goes with your next message. The daemon stores the notes in `meta.annotations`
// and hands them to the coding agent; the message's own text stays what you typed.
import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { MessageSquarePlus, Quote, X } from 'lucide-react'
import './annotations.css'

export type ReplyAnnotation = { messageId: string; quote: string; note: string }

export const MAX_ANNOTATIONS = 10
export const MAX_ANNOTATION_CHARS = 2_000

/** The annotations stored on a message, ignoring anything malformed. */
export function messageAnnotations(meta: unknown): ReplyAnnotation[] {
  const raw = meta && typeof meta === 'object' ? (meta as { annotations?: unknown }).annotations : null
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is ReplyAnnotation => !!item && typeof item === 'object' && typeof (item as ReplyAnnotation).quote === 'string' && typeof (item as ReplyAnnotation).note === 'string')
}

const shorten = (text: string, limit = 120) => { const flat = text.trim().replace(/\s+/g, ' '); return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat }

/** The message a selection lies wholly inside, with its text, or null. Replies carry `data-annotate-id`. */
export function selectionInReply(selection: Pick<Selection, 'isCollapsed' | 'anchorNode' | 'focusNode' | 'toString'> | null, container: HTMLElement | null): { messageId: string; quote: string; element: HTMLElement } | null {
  if (!selection || selection.isCollapsed || !container) return null
  const replyOf = (node: Node | null) => {
    const element = node instanceof HTMLElement ? node : node?.parentElement ?? null
    return element?.closest<HTMLElement>('[data-annotate-id]') ?? null
  }
  const reply = replyOf(selection.anchorNode)
  if (!reply || reply !== replyOf(selection.focusNode) || !container.contains(reply)) return null
  const quote = selection.toString().trim().slice(0, MAX_ANNOTATION_CHARS)
  const messageId = reply.dataset.annotateId
  return quote && messageId ? { messageId, quote, element: reply } : null
}

type Picked = { messageId: string; quote: string; top: number; left: number }

/** Watches selections inside `container` and offers "Add a note" beside them. */
export function ReplyAnnotator({ container, full, onAdd }: { container: RefObject<HTMLElement | null>; full: boolean; onAdd: (annotation: ReplyAnnotation) => void }) {
  const [picked, setPicked] = useState<Picked | null>(null)
  const [writing, setWriting] = useState(false)
  const [note, setNote] = useState('')
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const writingRef = useRef(false)
  writingRef.current = writing
  useEffect(() => {
    let timer: number | undefined
    const read = () => {
      if (writingRef.current) return
      const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
      const found = selectionInReply(selection, container.current)
      if (!found || !selection?.rangeCount) { setPicked(null); return }
      const rect = selection.getRangeAt(0).getBoundingClientRect()
      setPicked({ messageId: found.messageId, quote: found.quote, top: Math.max(8, rect.top - 40), left: Math.max(8, Math.min(window.innerWidth - 300, rect.left)) })
    }
    const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(read, 160) }
    document.addEventListener('selectionchange', schedule)
    return () => { window.clearTimeout(timer); document.removeEventListener('selectionchange', schedule) }
  }, [container])
  useEffect(() => { if (writing) requestAnimationFrame(() => fieldRef.current?.focus()) }, [writing])
  if (!picked) return null
  const cancel = () => { setWriting(false); setNote(''); setPicked(null) }
  const save = () => {
    const text = note.trim()
    if (!text) return
    onAdd({ messageId: picked.messageId, quote: picked.quote, note: text.slice(0, MAX_ANNOTATION_CHARS) })
    window.getSelection?.()?.removeAllRanges()
    cancel()
  }
  return createPortal(<div className={`annotate-pop${writing ? ' writing' : ''}`} style={{ top: writing ? Math.min(picked.top, window.innerHeight - 190) : picked.top, left: picked.left }} data-companion-no-drag="" onMouseDown={(event) => { if (!writing) event.preventDefault() }}>
    {writing
      ? <>
        <blockquote title={picked.quote}>{shorten(picked.quote)}</blockquote>
        <textarea ref={fieldRef} value={note} rows={3} maxLength={MAX_ANNOTATION_CHARS} aria-label="Your note about this part" placeholder="What should change here?" onChange={(event) => setNote(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() }
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); save() }
        }} />
        <div className="annotate-actions">
          <button type="button" className="ghost-button small" onClick={cancel}>Cancel</button>
          <button type="button" className="primary-button small" disabled={!note.trim()} onClick={save}>Add note</button>
        </div>
      </>
      : <button type="button" className="annotate-open" disabled={full} title={full ? `Up to ${MAX_ANNOTATIONS} notes per message` : 'Add a note about this part. It goes with your next message.'} onClick={() => setWriting(true)}><MessageSquarePlus size={13} aria-hidden="true" />Add a note</button>}
  </div>, document.body)
}

/** The notes waiting in the composer. */
export function AnnotationTray({ annotations, onRemove }: { annotations: readonly ReplyAnnotation[]; onRemove: (index: number) => void }) {
  if (!annotations.length) return null
  return <ul className="annotation-tray" aria-label="Notes going with this message">
    {annotations.map((annotation, index) => <li key={`${annotation.messageId}-${index}`} className="annotation-chip">
      <Quote size={12} aria-hidden="true" />
      <span className="annotation-chip-copy" title={annotation.quote}><span>{shorten(annotation.quote, 70)}</span><strong>{shorten(annotation.note, 90)}</strong></span>
      <button type="button" aria-label={`Remove note: ${shorten(annotation.note, 40)}`} onClick={() => onRemove(index)}><X size={12} aria-hidden="true" /></button>
    </li>)}
  </ul>
}

/** The notes on a sent message, above its bubble. */
export function MessageAnnotations({ meta, compact = false }: { meta: unknown; compact?: boolean }) {
  const annotations = messageAnnotations(meta)
  if (!annotations.length) return null
  return <div className={`message-annotations${compact ? ' compact' : ''}`}>
    {annotations.map((annotation, index) => <div key={index} className="message-annotation">
      <blockquote title={annotation.quote}>{shorten(annotation.quote, compact ? 80 : 160)}</blockquote>
      <p>{annotation.note}</p>
    </div>)}
  </div>
}
