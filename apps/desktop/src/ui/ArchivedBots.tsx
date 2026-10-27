import { useEffect, useState } from 'react'
import { ArchiveRestore, Trash2, X } from 'lucide-react'
import type { Agent } from '../types'
import { rpc } from '../tauri'
import { useDialogAccessibility } from './dialogFocus'
import { friendlyErrorText } from './errorCopy'
import { Skeleton } from './Skeleton'

export function ArchivedBots({ onClose, onRestore, onDelete }: { onClose: () => void; onRestore: (agent: Agent) => Promise<void>; onDelete: (agent: Agent) => void }) {
  const { ref } = useDialogAccessibility(onClose)
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void rpc<{ agents: Agent[] }>('agent.list', { includeArchived: true }).then((result) => { if (!cancelled) setAgents(result.agents.filter((agent) => agent.archived)) }).catch(() => { if (!cancelled) setError('Archived bots could not be loaded. Close this window and try again.') })
    return () => { cancelled = true }
  }, [])
  const restore = async (agent: Agent) => {
    setBusy(agent.id); setError('')
    try { await onRestore(agent); setAgents((current) => current?.filter((item) => item.id !== agent.id) ?? []) }
    catch (reason) { setError(friendlyErrorText(reason instanceof Error ? reason.message : String(reason))) }
    finally { setBusy(null) }
  }
  return <div className="tag-editor-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={ref} className="tag-editor archived-bots" role="dialog" aria-modal="true" aria-label="Archived bots">
      <header className="tag-editor-head"><strong>Archived bots</strong><button type="button" className="icon-button" aria-label="Close archived bots" onClick={onClose}><X size={16} /></button></header>
      <p className="tag-editor-hint">Restore a bot with its saved conversations, or permanently delete it.</p>
      {error && <p role="alert">{error}</p>}
      {!agents && !error && <div className="archived-bots-loading" role="status" aria-busy="true"><span className="sr-only">Loading archived bots…</span>{[0, 1, 2].map((row) => <div className="archived-bot-row archived-bot-skeleton" aria-hidden="true" key={row}><Skeleton className="archived-bot-skeleton-name" /><Skeleton variant="pill" className="archived-bot-skeleton-action" /><Skeleton variant="pill" className="archived-bot-skeleton-icon" /></div>)}</div>}
      {agents?.length === 0 && <p>No archived bots.</p>}
      {agents?.map((agent) => <div className="archived-bot-row" key={agent.id}><strong>{agent.name}</strong><button type="button" className="secondary-button small" disabled={busy !== null || agent.locked} onClick={() => void restore(agent)}><ArchiveRestore size={14} />{busy === agent.id ? 'Restoring…' : 'Restore'}</button><button type="button" className="icon-button danger" aria-label={`Permanently delete ${agent.name}`} title="Permanently delete bot" disabled={busy !== null || agent.locked} onClick={() => { onClose(); onDelete(agent) }}><Trash2 size={15} /></button></div>)}
    </section>
  </div>
}
