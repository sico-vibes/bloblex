// The strip at the top of a conversation after a turn changed files: what
// changed, by how much, and an Undo for each file (the daemon reverses that
// turn's saved diff). A second line appears when the context is nearly full.
import { useState } from 'react'
import { ChevronDown, ChevronUp, FileText, X } from 'lucide-react'
import type { JsonRecord, Session } from '../types'
import { parseUnifiedDiff } from './diffParser'
import './changeBanner.css'

const LIVE = ['working', 'starting', 'running', 'cancelling', 'waiting_permission']
/** Above this share of the context window the banner suggests a fresh conversation. */
export const CONTEXT_TIP_PERCENT = 80

/** Files the most recent finished turn changed (none while a turn is running). */
export function lastTurnChanges(session: Session | null): JsonRecord[] {
  if (!session || LIVE.includes(String(session.state ?? ''))) return []
  const files = (session.files ?? []).filter((file) => typeof file.turnId === 'string' && (file.detail as JsonRecord | undefined)?.reverted !== true)
  if (!files.length) return []
  const turns = session.turns ?? []
  const order = (turnId: string) => { const index = turns.findIndex((turn) => turn.id === turnId); return index < 0 ? -1 : index }
  const lastTurn = files.reduce((best, file) => order(String(file.turnId)) >= order(best) ? String(file.turnId) : best, String(files[0].turnId))
  const turn = turns.find((item) => item.id === lastTurn)
  if (turn && LIVE.includes(String(turn.state ?? ''))) return []
  // One row per path: its latest change in that turn.
  const byPath = new Map<string, JsonRecord>()
  for (const file of files.filter((item) => item.turnId === lastTurn)) byPath.set(String(file.path ?? (file.detail as JsonRecord | undefined)?.path ?? file.id), file)
  return [...byPath.values()]
}

function counts(file: JsonRecord): { diff: string; added: number; removed: number; clipped: boolean } {
  const detail = file.detail as JsonRecord | undefined
  const diff = typeof detail?.diff === 'string' ? detail.diff : typeof file.diff === 'string' ? file.diff : ''
  const parsed = diff ? parseUnifiedDiff(diff) : null
  const added = parsed ? parsed.additions : typeof file.addedLines === 'number' ? file.addedLines : 0
  const removed = parsed ? parsed.deletions : typeof file.removedLines === 'number' ? file.removedLines : 0
  return { diff, added, removed, clipped: detail?.diffClipped === true }
}

export function ChangeBanner({ session, dismissed, onDiff, onUndo, onDismiss, onNewConversation }: {
  session: Session | null
  dismissed: readonly string[]
  onDiff: (path: string, diff: string) => void
  onUndo: (file: JsonRecord) => void
  onDismiss: (ids: string[]) => void
  onNewConversation?: () => void
}) {
  const [open, setOpen] = useState(false)
  const files = lastTurnChanges(session).filter((file) => !dismissed.includes(String(file.id)))
  const used = typeof session?.contextUsed === 'number' ? session.contextUsed : 0
  const size = typeof session?.contextSize === 'number' ? session.contextSize : 0
  const percent = size > 0 ? Math.round((used / size) * 100) : 0
  const contextTip = percent >= CONTEXT_TIP_PERCENT && !LIVE.includes(String(session?.state ?? ''))
  if (!files.length && !contextTip) return null
  const totals = files.reduce<{ added: number; removed: number }>((sum, file) => { const value = counts(file); return { added: sum.added + value.added, removed: sum.removed + value.removed } }, { added: 0, removed: 0 })
  const first = files[0]
  const row = (file: JsonRecord) => {
    const value = counts(file)
    const path = String(file.path ?? (file.detail as JsonRecord | undefined)?.path ?? '')
    const name = path.split(/[\\/]/).pop() || path
    return <li key={String(file.id)} className="change-banner-file">
      <button type="button" className="change-banner-name" title={value.diff ? `View the diff for ${path}` : path} disabled={!value.diff} onClick={() => onDiff(path, value.diff)}><FileText size={13} aria-hidden="true" />{name}</button>
      <button type="button" className="change-banner-undo" onClick={() => onUndo(file)} disabled={value.clipped} title={value.clipped ? 'This diff was too large to keep, so it cannot be undone here.' : `Undo this change to ${name}`}>Undo</button>
      <span className="change-banner-counts"><em>+{value.added}</em> <i>−{value.removed}</i></span>
    </li>
  }
  return <section className="change-banner" aria-label="Latest changes">
    {files.length > 0 && <div className="change-banner-main">
      {files.length === 1
        ? <ul className="change-banner-list single">{row(first)}</ul>
        : <div className="change-banner-summary">
          <button type="button" className="change-banner-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}><FileText size={13} aria-hidden="true" />{files.length} files changed{open ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}</button>
          <span className="change-banner-counts"><em>+{totals.added}</em> <i>−{totals.removed}</i></span>
        </div>}
      <button type="button" className="change-banner-close" aria-label="Hide these changes" title="Hide" onClick={() => onDismiss(files.map((file) => String(file.id)))}><X size={13} /></button>
    </div>}
    {files.length > 1 && open && <ul className="change-banner-list">{files.map(row)}</ul>}
    {contextTip && <p className="change-banner-tip">This conversation's context is {percent}% full. A new conversation keeps replies fast and lighter on your usage.{onNewConversation && <> <button type="button" className="change-banner-link" onClick={onNewConversation}>New conversation</button></>}</p>}
  </section>
}
