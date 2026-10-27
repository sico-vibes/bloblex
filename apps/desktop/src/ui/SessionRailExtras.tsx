// Two rail cards that report what the daemon can prove: where the conversation works (its own copy of the
// project, or the shared folder) and what each turn changed, with a single-file undo only where the daemon's own
// dry run says the files still match what the agent wrote. Nothing is inferred in the browser.
import { useCallback, useEffect, useState } from 'react'
import { CircleAlert, FileText, GitBranch, Undo2, Users } from 'lucide-react'
import type { Session } from '../types'
import { rpc } from '../tauri'
import { Skeleton } from './Skeleton'
import { isDraftSession } from './teamSelectors'

type Workspace = {
  sessionId: string
  mode: 'shared' | 'isolated' | 'unknown'
  projectPath: string
  isGit: boolean
  repoRoot: string | null
  branch: string | null
  head: string | null
  worktree: { path: string; branch: string; base: string; baseCommit: string; repo: string } | null
  isolationFailure: string | null
  sharedWith: Array<{ sessionId: string; agentId: string; state: string }>
}

type CheckpointFile = { id: string; turnId: string | null; path: string; operation: string | null; additions: number | null; deletions: number | null; state: 'available' | 'reverted' | 'blocked'; reason: string | null }
type Checkpoints = {
  sessionId: string
  capability: { fileUndo: boolean; fileUndoReason: string | null; providerStateRestore: boolean; providerReason: string }
  busy: boolean
  turns: Array<{ turnId: string | null; files: CheckpointFile[] }>
}

const asError = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason))
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path
const short = (value: string | null | undefined, length = 8) => (value ? value.slice(0, length) : null)

/** The daemon-reported workspace: shared folder or the bot's own copy, with a visible reason when isolation failed. */
export function WorkspaceBody({ session, active }: { session: Session; active: boolean }) {
  const [data, setData] = useState<Workspace | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const working = ['working', 'starting', 'waiting_permission'].includes(session.state ?? '')
  // A draft is not in the daemon until its first message, so there is nothing to read.
  const draft = isDraftSession(session)
  useEffect(() => {
    if (!active || draft) return
    let live = true
    setFailed(null)
    void rpc<Workspace>('session.workspace', { sessionId: session.id }).then((result) => { if (live) setData(result) }).catch((reason) => { if (live) { setData(null); setFailed(asError(reason)) } })
    return () => { live = false }
  }, [session.id, session.projectPath, working, active, draft])
  if (draft) return <p className="rail-note">Nothing to show until the first message is sent.</p>
  if (failed) return <p className="rail-note rail-problem" role="alert"><CircleAlert size={12} aria-hidden="true" /><span>The workspace could not be read: {failed}</span></p>
  if (!data) return <div className="rail-loading" role="status" aria-busy="true"><span className="sr-only">Reading the workspace…</span><Skeleton lines={2} variant="row" /></div>
  const own = data.mode === 'isolated' && data.worktree
  return <>
    <div className="rail-row"><GitBranch size={13} aria-hidden="true" /><span className="rail-row-main">{own ? 'Its own copy of the project' : data.mode === 'unknown' ? 'No project folder' : 'The shared project folder'}</span><span className="rail-tag">{own ? 'isolated' : data.mode === 'unknown' ? 'unknown' : 'shared'}</span></div>
    {own && data.worktree && <p className="rail-note">Branch <b>{data.worktree.branch}</b>, taken from {data.worktree.base}{short(data.worktree.baseCommit) ? ` at ${short(data.worktree.baseCommit)}` : ''}. Changes here are this bot's alone and are offered for merge when the task ends.</p>}
    {!own && data.mode === 'shared' && <p className="rail-note">{data.isGit && data.branch ? <>Branch <b>{data.branch}</b>{short(data.head) ? ` at ${short(data.head)}` : ''}. </> : null}Changes in a shared folder belong to the folder, not to one bot: anyone working here, or you, may have made them.</p>}
    {data.isolationFailure && <p className="rail-note rail-problem" role="alert"><CircleAlert size={12} aria-hidden="true" /><span>Bitbots could not give this bot its own copy: {data.isolationFailure} It is working in the shared folder.</span></p>}
    {(data.sharedWith?.length ?? 0) > 0 && <p className="rail-note"><Users size={12} aria-hidden="true" /> {data.sharedWith.length} other {data.sharedWith.length === 1 ? 'conversation is' : 'conversations are'} working in this folder right now, so changes can overlap.</p>}
  </>
}

/**
 * What each turn changed, file by file, with the daemon's own check of whether a single change can still be undone.
 * Undoing one file puts it back as it was before the agent's edit. It is not a rollback of the conversation: the
 * agent keeps what it remembers, other files are untouched, and a file that changed afterwards is refused.
 */
export function CheckpointsBody({ session, active, onChanged }: { session: Session; active: boolean; onChanged?: () => void }) {
  const [data, setData] = useState<Checkpoints | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'problem'; text: string } | null>(null)
  const fileCount = session.files?.length ?? 0
  const state = session.state ?? ''
  const draft = isDraftSession(session)
  const load = useCallback(() => {
    if (draft) return Promise.resolve()
    return rpc<Checkpoints>('session.checkpoints', { sessionId: session.id }).then((result) => { setData(result); setFailed(null) }).catch((reason) => { setFailed(asError(reason)) })
  }, [session.id, draft])
  useEffect(() => { setData(null); setConfirming(null); setNotice(null) }, [session.id])
  // Re-read when a turn ends or another change is recorded; never while the card is hidden.
  useEffect(() => { if (active) void load() }, [active, load, fileCount, state])

  const messages = session.messages ?? []
  const turnIndex = (turnId: string | null) => (session.turns ?? []).findIndex((turn) => turn.id === turnId)
  const promptOf = (turnId: string | null) => {
    const text = messages.find((message) => message.role === 'user' && (message as { turnId?: string }).turnId === turnId)?.content
    const line = typeof text === 'string' ? text.replace(/s+/g, ' ').trim() : ''
    return line ? (line.length > 56 ? `${line.slice(0, 55)}…` : line) : null
  }

  const undo = async (file: CheckpointFile) => {
    setBusy(true)
    setNotice(null)
    try {
      await rpc('file.revert', { sessionId: session.id, fileChangeId: file.id })
      setNotice({ tone: 'ok', text: `${baseName(file.path)} is back as it was before this change. The agent was not told.` })
      onChanged?.()
    } catch (reason) {
      setNotice({ tone: 'problem', text: `${baseName(file.path)} was not changed: ${asError(reason)}` })
    } finally { setBusy(false); setConfirming(null); void load() }
  }

  if (draft) return <p className="rail-note">Files the coding agent changes appear here, turn by turn.</p>
  if (failed && !data) return <p className="rail-note rail-problem" role="alert"><CircleAlert size={12} aria-hidden="true" /><span>Changes by turn could not be read: {failed}</span></p>
  if (!data) return <div className="rail-loading" role="status" aria-busy="true"><span className="sr-only">Checking what each turn changed…</span><Skeleton lines={2} variant="row" /></div>
  if (!data.turns?.length) return <p className="rail-note">Files the coding agent changes appear here, turn by turn.</p>
  const turns = [...data.turns].reverse()
  const canUndo = data.capability.fileUndo && !data.busy
  return <>
    {!data.capability.fileUndo && <p className="rail-note">{data.capability.fileUndoReason ?? 'Single changes cannot be undone here.'}</p>}
    {data.busy && <p className="rail-note">Undo is available when the turn finishes.</p>}
    <ul className="rail-turns">{turns.map((turn) => {
      const key = turn.turnId ?? 'unrecorded'
      const index = turnIndex(turn.turnId)
      const added = turn.files.reduce((sum, file) => sum + (file.additions ?? 0), 0)
      const removed = turn.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
      const prompt = promptOf(turn.turnId)
      return <li key={key} className="rail-turn">
        <div className="rail-turn-head"><span className="rail-turn-title" title={prompt ?? undefined}>{index >= 0 ? `Turn ${index + 1}` : 'Earlier changes'}{prompt ? <small>{prompt}</small> : null}</span><span className="rail-diffstat"><em>+{added}</em> <i>−{removed}</i></span></div>
        <ul className="rail-files">{turn.files.map((file) => <li key={file.id} className="rail-file" data-state={file.state}>
          <span className="rail-file-open static"><FileText size={13} aria-hidden="true" /><span className="rail-file-name" title={file.path}>{baseName(file.path)}</span>{file.state !== 'available' && <span className="rail-tag" title={file.reason ?? undefined}>{file.state === 'reverted' ? 'undone' : 'cannot undo'}</span>}</span>
          {file.state === 'available' && canUndo && confirming !== file.id && <button type="button" className="rail-link rail-undo" aria-label={`Undo this change to ${baseName(file.path)}`} onClick={() => setConfirming(file.id)}><Undo2 size={12} aria-hidden="true" />Undo</button>}
          {confirming === file.id && <div className="rail-confirm" role="group" aria-label={`Confirm undoing ${baseName(file.path)}`}><span>Put <b>{baseName(file.path)}</b> back as it was before this change? Only this file changes. If it has been edited since, nothing happens. The agent is not told, so mention it if it matters.</span><span className="rail-confirm-actions"><button type="button" className="secondary-button small" disabled={busy} onClick={() => setConfirming(null)}>Keep</button><button type="button" className="primary-button small" disabled={busy} onClick={() => void undo(file)}>{busy ? 'Working…' : 'Undo this change'}</button></span></div>}
        </li>)}</ul>
        {turn.files.some((file) => file.state === 'blocked') && <ul className="rail-block-reasons">{[...new Set(turn.files.filter((file) => file.state === 'blocked' && file.reason).map((file) => file.reason!))].slice(0, 2).map((reason) => <li key={reason}>{reason}</li>)}</ul>}
      </li>
    })}</ul>
    {notice && <p className={`rail-note${notice.tone === 'problem' ? ' rail-problem' : ''}`} role={notice.tone === 'problem' ? 'alert' : 'status'}>{notice.text}</p>}
    <p className="rail-note">{data.capability.providerReason}</p>
  </>
}
