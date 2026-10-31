// Phase 3: task copies whose conversation is gone. They're only ever listed here, and
// only the owner removes one. Anything that would lose work needs a second, plain "yes".
import { useCallback, useEffect, useState } from 'react'
import { rpc } from '../tauri'
import { SettingsGroup } from './SettingsParts'

export type AbandonedWorktree = { id: string; repo: string; path: string; branch: string; reason: 'conversation_deleted' | 'conversation_archived' | 'folder_missing'; dirtyFiles: number; commitsAhead: number; lastActivityAt: string | null }

const REASONS: Record<AbandonedWorktree['reason'], string> = {
  conversation_deleted: 'Its conversation was deleted',
  conversation_archived: 'Its conversation is archived',
  folder_missing: 'Its folder is already gone',
}
const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const messageOf = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback

/** What removing this copy would lose, in words, or null when nothing would be. */
export function wouldLose(item: Pick<AbandonedWorktree, 'dirtyFiles' | 'commitsAhead'>, deleteBranch: boolean): string | null {
  const parts = [
    item.dirtyFiles > 0 ? plural(item.dirtyFiles, 'uncommitted file') : null,
    deleteBranch && item.commitsAhead > 0 ? plural(item.commitsAhead, 'commit') : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' and ') : null
}

function Row({ item, onRemoved }: { item: AbandonedWorktree; onRemoved: () => void }) {
  const [deleteBranch, setDeleteBranch] = useState(item.commitsAhead === 0)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const lose = wouldLose(item, deleteBranch)
  const remove = async () => {
    setBusy(true); setProblem(null)
    try {
      const reply = await rpc<{ removed?: boolean; detail?: string }>('worktree.removeAbandoned', { id: item.id, deleteBranch, force: !!lose, confirm: true })
      if (reply?.removed === false) { setProblem(reply.detail ?? 'That task copy could not be removed.'); setBusy(false); setConfirming(false); return }
      onRemoved()
    } catch (reason) { setProblem(messageOf(reason, 'That task copy could not be removed.')); setBusy(false); setConfirming(false) }
  }
  const facts = [REASONS[item.reason], item.dirtyFiles > 0 ? `${plural(item.dirtyFiles, 'uncommitted file')}` : null, item.commitsAhead > 0 ? `${plural(item.commitsAhead, 'commit')} ahead` : null].filter(Boolean).join(' · ')
  return <li className="worktree-row">
    <div className="worktree-copy">
      <strong title={item.path}>{nameOf(item.repo)} / {nameOf(item.path)}</strong>
      <small>{facts}</small>
      <small className="worktree-branch" title={item.branch}>{item.branch}</small>
      {problem && <small className="new-project-error" role="alert">{problem}</small>}
    </div>
    <div className="worktree-actions">
      <label className="worktree-branch-choice"><input type="checkbox" checked={deleteBranch} disabled={busy} onChange={(event) => { setDeleteBranch(event.target.checked); setConfirming(false) }} /><span>Delete its branch</span></label>
      {confirming && lose
        ? <span className="worktree-confirm" role="group" aria-label={`Remove ${nameOf(item.path)}?`}>
          <span>{lose} will be lost.</span>
          <button type="button" className="ghost-button small" autoFocus disabled={busy} onClick={() => setConfirming(false)}>Keep</button>
          <button type="button" className="secondary-button small worktree-remove" disabled={busy} onClick={() => void remove()}>{busy ? 'Removing…' : 'Remove anyway'}</button>
        </span>
        : <button type="button" className="secondary-button small" disabled={busy} onClick={() => { if (lose) setConfirming(true); else void remove() }}>{busy ? 'Removing…' : 'Remove'}</button>}
    </div>
  </li>
}

export function AbandonedWorktrees() {
  const [items, setItems] = useState<AbandonedWorktree[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const load = useCallback(() => {
    setProblem(null)
    return rpc<{ items?: AbandonedWorktree[] }>('worktree.abandoned', {})
      .then((reply) => setItems(Array.isArray(reply?.items) ? reply.items : []))
      .catch(() => { setItems([]); setProblem('The task copies could not be listed.') })
  }, [])
  useEffect(() => { void load() }, [load])
  return <SettingsGroup title="Leftover task copies" action={<button type="button" className="ghost-button small" disabled={items === null} onClick={() => { setItems(null); void load() }}>Check again</button>}>
    {items === null
      ? <p className="settings-empty" role="status">Looking…</p>
      : problem
        ? <p className="settings-empty" role="status">{problem}</p>
        : !items.length
          ? <p className="settings-empty" role="status">No leftover task copies. Each one still belongs to a conversation.</p>
          : <>
            <p className="settings-empty">These git copies have no conversation using them. Bitbots never removes one by itself.</p>
            <ul className="worktree-list">{items.map((item) => <Row key={item.id} item={item} onRemoved={() => void load()} />)}</ul>
          </>}
  </SettingsGroup>
}
