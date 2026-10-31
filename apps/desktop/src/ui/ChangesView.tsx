// Phase 3: the review screen. Every changed file in the conversation's folder against
// HEAD, with its whole diff, stage and discard per file, and comments for the bot.
// The daemon decides what is allowed and takes the folder from the conversation: this
// only ever names a conversation and a path the repository itself listed.
import { useEffect, useMemo, useState } from 'react'
import { Check, GitPullRequest, LoaderCircle, MessageSquare, Undo2, X } from 'lucide-react'
import { rpc } from '../tauri'
import { useDialogAccessibility } from './dialogFocus'
import { DiffBody, DiffModeSwitch, commentsMessage, useDiffMode, type LineComment } from './DiffBody'
import { normalizeRepository, type RepositoryFile, type RepositoryState } from './sessionRepository'
import { pushUndoToast } from './undo'
import './changesView.css'

type FileDiff = { diff: string | null; truncated: boolean; binary: boolean; change?: string }
type Staged = RepositoryFile['staged']

const CHANGE_LETTER: Record<RepositoryFile['change'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }
const CHANGE_WORD: Record<RepositoryFile['change'], string> = { added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed' }
const messageOf = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : typeof reason === 'string' && reason ? reason : fallback
const nameOf = (path: string) => path.split('/').pop() || path
const folderOf = (path: string) => { const at = path.lastIndexOf('/'); return at > 0 ? path.slice(0, at) : '' }

function StageBox({ state, name, disabled, onChange }: { state: Staged; name: string; disabled: boolean; onChange: (staged: boolean) => void }) {
  return <input type="checkbox" className="changes-stage" aria-label={`Stage ${name}`} title={state === 'partial' ? 'Partly staged' : state === 'all' ? 'Staged' : 'Not staged'} disabled={disabled} checked={state === 'all'} ref={(node) => { if (node) node.indeterminate = state === 'partial' }} onChange={(event) => onChange(event.target.checked)} />
}

export function ChangesView({ sessionId, initialPath, botName, onClose, onSendComments, onCreatePr }: {
  sessionId: string
  initialPath?: string | null
  botName: string
  onClose: () => void
  /** Sends the comments as an ordinary message; rejects when the daemon refuses it. */
  onSendComments: (text: string) => Promise<void>
  onCreatePr?: (repository: RepositoryState) => void
}) {
  const { ref, close } = useDialogAccessibility(onClose)
  const [repository, setRepository] = useState<RepositoryState | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(initialPath ?? null)
  const [diff, setDiff] = useState<{ path: string; value: FileDiff } | { path: string; error: string } | null>(null)
  const [mode, setMode] = useDiffMode()
  const [busy, setBusy] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [comments, setComments] = useState<LineComment[]>([])
  const [sending, setSending] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let live = true
    void rpc('session.repository', { sessionId }).then((raw) => {
      if (!live) return
      const next = normalizeRepository(raw)
      if (!next) { setFailure('The repository could not be read just now.'); return }
      setRepository(next)
      setSelected((current) => next.files.some((file) => file.repositoryPath === current) ? current : next.files[0]?.repositoryPath ?? null)
    }).catch((reason) => { if (live) setFailure(messageOf(reason, 'The repository could not be read just now.')) })
    return () => { live = false }
  }, [sessionId, revision])

  useEffect(() => {
    if (!selected) { setDiff(null); return }
    let live = true
    setDiscarding(false)
    void rpc<FileDiff>('session.git.diff', { sessionId, repositoryPath: selected })
      .then((value) => { if (live) setDiff({ path: selected, value }) })
      .catch((reason) => { if (live) setDiff({ path: selected, error: messageOf(reason, 'This diff could not be read.') }) })
    return () => { live = false }
  }, [sessionId, selected, revision])

  const files = repository?.files ?? []
  const file = useMemo(() => files.find((item) => item.repositoryPath === selected) ?? null, [files, selected])
  const stagedCount = files.filter((item) => item.staged === 'all').length
  const allStaged = files.length > 0 && stagedCount === files.length

  /** Stage replies with the fresh list, so the screen never shows a guess. */
  const applyFiles = (raw: unknown) => {
    const list = (raw as { files?: unknown } | null)?.files
    if (!repository || !Array.isArray(list)) { setRevision((value) => value + 1); return }
    const next = normalizeRepository({ ...repository, files: list })
    if (next) setRepository(next)
    else setRevision((value) => value + 1)
  }
  const stage = async (paths: string[], staged: boolean) => {
    setBusy(true); setFailure(null)
    try { applyFiles(await rpc('session.git.stage', { sessionId, paths, staged })) }
    catch (reason) { setFailure(messageOf(reason, 'That could not be staged.')) }
    finally { setBusy(false) }
  }
  const discard = async (target: RepositoryFile) => {
    setBusy(true); setFailure(null); setDiscarding(false)
    try {
      const reply = await rpc<{ undoId?: string | null; name?: string; files?: unknown }>('session.git.revert', { sessionId, repositoryPath: target.repositoryPath, confirm: true })
      setComments((current) => current.filter((comment) => comment.path !== target.repositoryPath))
      setRevision((value) => value + 1)
      const undoId = reply?.undoId
      if (undoId) pushUndoToast({
        id: `git-revert-${undoId}`,
        text: `Discarded the changes to ${nameOf(target.repositoryPath)}`,
        deadline: Date.now() + 10_000,
        undo: async () => { await rpc('session.git.revertUndo', { sessionId, undoId }); setRevision((value) => value + 1) },
      })
    } catch (reason) { setFailure(messageOf(reason, 'Those changes could not be discarded.')) }
    finally { setBusy(false) }
  }
  const sendComments = async () => {
    if (!comments.length || sending) return
    setSending(true); setFailure(null)
    try { await onSendComments(commentsMessage(comments)); setComments([]); close() }
    catch (reason) { setFailure(messageOf(reason, 'The comments could not be sent.')) }
    finally { setSending(false) }
  }
  const body = () => {
    if (!diff || diff.path !== selected) return <p className="diff-empty"><LoaderCircle size={15} className="spinning" aria-hidden="true" /> Loading the diff…</p>
    if ('error' in diff) return <p className="diff-empty">{diff.error}</p>
    if (diff.value.binary) return <p className="diff-empty">Binary file change. Text lines are unavailable.</p>
    if (!diff.value.diff) return <p className="diff-empty">{file?.change === 'deleted' ? 'This file was deleted, so there is no text to show.' : 'There is no text diff for this file.'}</p>
    return <>
      {diff.value.truncated && <p className="changes-note" role="status">This diff is too long to show in full.</p>}
      <DiffBody content={diff.value.diff} mode={mode} path={diff.path}
        comments={comments}
        onAddComment={(line, removed, quote, text) => setComments((current) => [...current, { id: `${diff.path}:${line}:${Date.now()}:${current.length}`, path: diff.path, line, removed, quote, text }])}
        onRemoveComment={(id) => setComments((current) => current.filter((comment) => comment.id !== id))} />
    </>
  }
  return <div className="sheet-backdrop diff-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
    <section ref={ref} className="changes-view" role="dialog" aria-modal="true" aria-labelledby="changes-title" tabIndex={-1}>
      <header className="changes-head">
        <div className="changes-title">
          <h2 id="changes-title">Changes</h2>
          {repository && <small>{repository.detached ? 'Detached HEAD' : repository.branch ?? 'Unknown branch'} · {files.length}{repository.truncated ? '+' : ''} {files.length === 1 ? 'file' : 'files'} · <span className="rail-add">+{repository.addedLines.toLocaleString()}</span> <span className="rail-del">−{repository.removedLines.toLocaleString()}</span></small>}
        </div>
        <DiffModeSwitch mode={mode} onChange={setMode} />
        {onCreatePr && repository && <button type="button" className="secondary-button small" onClick={() => onCreatePr(repository)}><GitPullRequest size={13} aria-hidden="true" />Create PR</button>}
        <button type="button" className="icon-button" data-dialog-initial-focus="" aria-label="Close changes" onClick={close}><X size={17} aria-hidden="true" /></button>
      </header>
      {failure && <p className="changes-error" role="alert">{failure}</p>}
      {repository && !repository.gitRepo
        ? <p className="diff-empty">{repository.error ?? 'This project is not a git repository.'}</p>
        : repository && files.length === 0
          ? <p className="diff-empty"><Check size={15} aria-hidden="true" /> No changes against the last commit.</p>
          : <div className="changes-layout">
            <aside className="changes-files" aria-label="Changed files">
              <label className="changes-stage-all">
                <input type="checkbox" className="changes-stage" disabled={busy || !files.length} checked={allStaged} ref={(node) => { if (node) node.indeterminate = stagedCount > 0 && !allStaged }} onChange={(event) => void stage(files.map((item) => item.repositoryPath), event.target.checked)} />
                <span>{stagedCount ? `${stagedCount} staged` : 'Stage all'}</span>
              </label>
              <ul>{files.map((item) => {
                const count = comments.filter((comment) => comment.path === item.repositoryPath).length
                return <li key={item.repositoryPath} className={item.repositoryPath === selected ? 'selected' : undefined}>
                  <StageBox state={item.staged} name={item.repositoryPath} disabled={busy} onChange={(staged) => void stage([item.repositoryPath], staged)} />
                  <button type="button" className="changes-file" aria-current={item.repositoryPath === selected ? 'true' : undefined} title={item.repositoryPath} onClick={() => setSelected(item.repositoryPath)}>
                    <span className="changes-letter" data-change={item.change} title={CHANGE_WORD[item.change]}>{CHANGE_LETTER[item.change]}</span>
                    <span className="changes-name"><strong>{nameOf(item.repositoryPath)}</strong>{folderOf(item.repositoryPath) && <small>{folderOf(item.repositoryPath)}</small>}</span>
                    {count > 0 && <span className="changes-comment-count" aria-label={`${count} comments`}><MessageSquare size={11} aria-hidden="true" />{count}</span>}
                  </button>
                </li>
              })}</ul>
            </aside>
            <div className="changes-main">
              {file && <div className="changes-file-bar">
                <code title={file.repositoryPath}>{file.repositoryPath}</code>
                {file.addedLines !== null && <em className="rail-add">+{file.addedLines.toLocaleString()}</em>}
                {file.removedLines !== null && <i className="rail-del">−{file.removedLines.toLocaleString()}</i>}
                <span className="changes-spacer" />
                <button type="button" className="ghost-button small" disabled={busy} onClick={() => void stage([file.repositoryPath], file.staged !== 'all')}>{file.staged === 'all' ? 'Unstage' : 'Stage'}</button>
                {discarding
                  ? <span className="changes-confirm" role="group" aria-label={`Discard the changes to ${nameOf(file.repositoryPath)}?`}>
                    <span>Discard?</span>
                    <button type="button" className="ghost-button small" autoFocus onClick={() => setDiscarding(false)}>Keep</button>
                    <button type="button" className="secondary-button small danger" disabled={busy} onClick={() => void discard(file)}>Discard</button>
                  </span>
                  : <button type="button" className="ghost-button small" disabled={busy} onClick={() => setDiscarding(true)}><Undo2 size={13} aria-hidden="true" />Discard</button>}
              </div>}
              <div className="diff-content changes-diff" role="region" aria-label={file ? `Diff for ${file.repositoryPath}` : 'Diff'} tabIndex={0}>{repository ? body() : <p className="diff-empty"><LoaderCircle size={15} className="spinning" aria-hidden="true" /> Reading the repository…</p>}</div>
              {comments.length > 0 && <div className="changes-comments-bar">
                <span>{comments.length} {comments.length === 1 ? 'comment' : 'comments'} for {botName}</span>
                <button type="button" className="ghost-button small" disabled={sending} onClick={() => setComments([])}>Clear</button>
                <button type="button" className="primary-button small" disabled={sending} onClick={() => void sendComments()}>{sending ? 'Sending…' : `Send to ${botName}`}</button>
              </div>}
            </div>
          </div>}
    </section>
  </div>
}
