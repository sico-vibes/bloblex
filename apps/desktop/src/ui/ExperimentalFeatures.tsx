import { useEffect, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentLook } from '../blob/look'
import type { Agent, JsonRecord } from '../types'
import { rpc } from '../tauri'
import { agentColorHex } from './agentColor'
import { parseUnifiedDiff } from './diffParser'
import { useDialogAccessibility } from './dialogFocus'
import { shortcutRows } from './experiments'
import { useEntityNoun } from './vocabulary'
import './experiments.css'

export function ChangeReview({ files, dismissed, onKeep, onRevert, onDiff }: { files: JsonRecord[]; dismissed: string[]; onKeep: (id: string) => void; onRevert: (file: JsonRecord) => void; onDiff: (path: string, content: string) => void }) {
  const visible = files.filter((file) => !dismissed.includes(String(file.id)) && (file.detail as JsonRecord | undefined)?.reverted !== true)
  if (!visible.length) return null
  return <section className="change-review" aria-label="Review changes"><strong>Review changes</strong><ul>{visible.map((file) => {
    const detail = file.detail as JsonRecord | undefined
    const diff = typeof detail?.diff === 'string' ? detail.diff : ''
    const counts = parseUnifiedDiff(diff)
    const path = String(file.path ?? detail?.path ?? '')
    return <li key={String(file.id)}><button type="button" className="ghost-button small review-path" disabled={!diff} onClick={() => onDiff(path, diff)}>{path}</button><span className="review-counts" aria-label={diff ? `${counts.additions} added, ${counts.deletions} removed` : 'Diff unavailable'}>{diff ? <><span>+{counts.additions}</span> / −{counts.deletions}{detail?.diffClipped === true ? ' (partial)' : ''}</> : 'Diff unavailable'}</span><button type="button" className="ghost-button small" onClick={() => onKeep(String(file.id))}>Keep</button><button type="button" className="ghost-button small" onClick={() => onRevert(file)}>Revert</button></li>
  })}</ul></section>
}

export type MessageSearchResult = { sessionId: string; blobId: string | null; title: string; role: string; messageId: string; createdAt: string; snippet: string; blob?: { id: string; name: string; color: string; look?: unknown; archived?: boolean } | null }
export function highlightMatch(text: string, query: string): ReactNode {
  if (!query.trim()) return text
  const index = text.toLowerCase().indexOf(query.trim().toLowerCase())
  if (index < 0) return text
  const end = index + query.trim().length
  return <>{text.slice(0, index)}<mark>{text.slice(index, end)}</mark>{text.slice(end)}</>
}
export function MessageSearch({ agents, onChoose, onClose }: { agents: Agent[]; onChoose: (result: MessageSearchResult) => void; onClose: () => void }) {
  const Noun = useEntityNoun({ capital: true })
  const { ref, close } = useDialogAccessibility(onClose)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MessageSearchResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  useEffect(() => {
    let active = true
    setResults([]); setError(null); setActiveIndex(0); setLoading(!!query.trim())
    if (!query.trim()) return
    const timer = window.setTimeout(() => {
      void rpc<{ results: MessageSearchResult[] }>('search.messages', { query: query.trim() }).then((r) => { if (active) setResults(r.results) }).catch(() => { if (active) setError('Could not search conversations. Try again.') }).finally(() => { if (active) setLoading(false) })
    }, 150)
    return () => { active = false; window.clearTimeout(timer) }
  }, [query])
  return <div className="sheet-backdrop quick-switcher-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}><section className="quick-switcher" ref={ref} role="dialog" aria-modal="true" aria-label="Search messages">
    <label className="quick-switcher-search"><input data-dialog-initial-focus aria-label="Search message text" aria-controls="message-search-results" aria-activedescendant={results.length ? `message-search-${activeIndex}` : undefined} value={query} maxLength={200} placeholder="Search all conversations" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && results.length) { e.preventDefault(); setActiveIndex((activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length) } if (e.key === 'Enter' && results[activeIndex]) { e.preventDefault(); onChoose(results[activeIndex]); close() } }} /><button type="button" className="icon-button" aria-label="Close search" onClick={close}><X size={16} /></button></label>
    <div id="message-search-results" className="quick-switcher-results" role="listbox" aria-label="Matching messages">{results.map((result, i) => {
      const agent = agents.find((a) => a.id === result.blobId) ?? result.blob
      return <button type="button" role="option" aria-selected={activeIndex === i} id={`message-search-${i}`} key={result.messageId} className={`menu-item message-search-result ${activeIndex === i ? 'active' : ''}`} onMouseMove={() => setActiveIndex(i)} onClick={() => { onChoose(result); close() }}>{agent && <BlobCanvas decorative color={agentColorHex(agent.color)} size={28} mood="idle" look={agentLook(agent)} label={agent.name} />}<span className="quick-switcher-copy"><strong>{agent?.name ?? Noun} · {result.title}</strong><small>{highlightMatch(result.snippet, query)}</small><time dateTime={result.createdAt}>{new Date(result.createdAt).toLocaleString()} · {result.role}</time></span></button>
    })}</div><p className="quick-switcher-empty" role="status">{error ?? (loading ? 'Searching…' : !query.trim() ? 'Search saved message text.' : !results.length ? 'No matching messages.' : `${results.length} matching messages`)}</p>
  </section></div>
}

export function ShortcutSheet({ speechEnabled, onClose }: { speechEnabled: boolean; onClose: () => void }) {
  const { ref, close } = useDialogAccessibility(onClose)
  return <div className="sheet-backdrop quick-switcher-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}><section ref={ref} className="quick-switcher shortcut-sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"><header><h2>Keyboard shortcuts</h2><button type="button" className="icon-button" data-dialog-initial-focus aria-label="Close keyboard shortcuts" onClick={close}><X size={16} /></button></header><dl>{shortcutRows(speechEnabled).map(([keys, label]) => <div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{label}</dd></div>)}</dl></section></div>
}

export type UndoToast = { id: string; text: string; deadline: number; undo: () => Promise<void> }
export function UndoToasts({ toasts, onRemove, onError }: { toasts: UndoToast[]; onRemove: (id: string) => void; onError: (error: string) => void }) {
  const [pending, setPending] = useState<string[]>([])
  useEffect(() => {
    if (!toasts.length) return
    const timer = window.setTimeout(() => { for (const toast of toasts) if (toast.deadline <= Date.now()) onRemove(toast.id) }, Math.max(0, Math.min(...toasts.map((toast) => toast.deadline)) - Date.now()))
    return () => window.clearTimeout(timer)
  }, [toasts, onRemove])
  return <div className="undo-toasts" aria-label="Recent actions">{toasts.map((toast) => <div className="undo-toast" role="status" key={toast.id}><span>{toast.text}</span><button type="button" className="ghost-button small" disabled={pending.includes(toast.id)} onClick={() => {
    setPending((p) => [...p, toast.id])
    void toast.undo().then(() => onRemove(toast.id)).catch(() => onError('Could not undo this action. The Undo period may have ended.')).finally(() => setPending((p) => p.filter((id) => id !== toast.id)))
  }}>Undo</button></div>)}</div>
}
