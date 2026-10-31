import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, CircleMinus, ExternalLink, GitPullRequest, LoaderCircle } from 'lucide-react'
import { inDesktop, rpc } from '../tauri'
import { useDialogAccessibility } from './dialogFocus'
import { friendlyErrorText } from './errorCopy'
import { openSafeLink } from './openSafeLink'
import type { RepositoryState } from './sessionRepository'
import './newProject.css'

export type PullRequestDraft = {
  ready: boolean
  reason: string | null
  gh: { available: boolean; login: string | null }
  branch: string | null
  base: string | null
  commitsAhead: number
  uncommitted: number
  title: string
  body: string
  existingUrl: string | null
}
type Step = { id: string; status: 'done' | 'failed' | 'skipped'; detail: string | null }
type Created = { steps: Step[]; url: string | null }

const STEP_LABELS: Record<string, string> = { commit: 'Commit the changes', push: 'Push the branch', pr: 'Open the pull request' }

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** What the owner is approving, in order. */
export function pullRequestPlan(draft: PullRequestDraft, commitFirst: boolean, asDraft: boolean): string[] {
  return [
    ...(commitFirst && draft.uncommitted > 0 ? [`Commit ${plural(draft.uncommitted, 'uncommitted file')}`] : []),
    `Push ${draft.branch ?? 'this branch'} to origin`,
    `Open a ${asDraft ? 'draft ' : ''}pull request${draft.base ? ` into ${draft.base}` : ''}${draft.gh.login ? ` as ${draft.gh.login}` : ''}`,
  ]
}

/**
 * The last look before a pull request. When this computer's GitHub CLI can open it, the owner reads the drafted
 * title and body and confirms, and the daemon does it. Otherwise, or if they prefer, confirming sends an ordinary
 * message asking the conversation's coding agent; that dialog only closes once the daemon has accepted the message.
 */
export function PullRequestDialog({ sessionId, repository, botName, busy, onSend, onClose, onCreated }: {
  sessionId: string
  repository: RepositoryState
  botName: string
  /** The coding agent is in the middle of a turn, so the request waits behind it. */
  busy: boolean
  /** Sends the request; rejects when the daemon refuses it. */
  onSend: () => Promise<void>
  onClose: () => void
  onCreated?: () => void
}) {
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState('')
  const { ref, close } = useDialogAccessibility(onClose, () => !pending)
  // `undefined` while it loads; null when it can't be read, which leaves asking the bot.
  const [draft, setDraft] = useState<PullRequestDraft | null | undefined>(inDesktop ? undefined : null)
  const [askInstead, setAskInstead] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [asDraft, setAsDraft] = useState(false)
  const [commitFirst, setCommitFirst] = useState(true)
  const [commitMessage, setCommitMessage] = useState('')
  const [created, setCreated] = useState<Created | null>(null)
  useEffect(() => {
    if (!inDesktop) return
    let live = true
    void rpc<PullRequestDraft>('session.pr.draft', { sessionId }).then((next) => {
      if (!live) return
      if (!next || typeof next.ready !== 'boolean') { setDraft(null); return }
      setDraft(next)
      setTitle(next.title ?? '')
      setBody(next.body ?? '')
      setCommitMessage(next.title ?? '')
    }).catch(() => { if (live) setDraft(null) })
    return () => { live = false }
  }, [sessionId])
  const root = repository.repoRoot ?? repository.projectPath ?? ''
  const folder = root.split(/[\\/]/).filter(Boolean).pop() ?? 'this repository'
  const fileCount = `${repository.files.length}${repository.truncated ? '+' : ''}`
  const ask = async () => {
    if (pending) return
    setPending(true); setFailure('')
    try { await onSend(); onClose() }
    catch (reason) { setFailure(friendlyErrorText(reason instanceof Error ? reason.message : String(reason))); setPending(false) }
  }
  const native = !!draft?.ready && !draft.existingUrl && !askInstead
  const needsMessage = !!draft && draft.uncommitted > 0 && commitFirst
  const canCreate = !pending && !!title.trim() && (!needsMessage || !!commitMessage.trim())
  const create = async () => {
    if (!draft || !canCreate) return
    setPending(true); setFailure('')
    try {
      const made = await rpc<Created>('session.pr.create', { sessionId, title: title.trim(), body, base: draft.base, draft: asDraft, commitMessage: needsMessage ? commitMessage.trim() : null, confirm: true })
      setCreated({ steps: Array.isArray(made?.steps) ? made.steps : [], url: made?.url ?? null })
      if (made?.url) onCreated?.()
    } catch (reason) { setFailure(friendlyErrorText(reason instanceof Error ? reason.message : String(reason))) }
    finally { setPending(false) }
  }
  if (created) {
    const failed = created.steps.some((step) => step.status === 'failed')
    return <div className="sheet-backdrop blob-dialog-backdrop is-entered">
      <section ref={ref} className="blob-dialog new-project pr-form" role="dialog" aria-modal="true" aria-labelledby="pr-dialog-title" tabIndex={-1}>
        <h2 id="pr-dialog-title">{failed ? 'Not everything worked' : 'Pull request opened'}</h2>
        <ul className="scaffold-steps">{created.steps.map((step) => <li key={step.id} data-status={step.status}>
          {step.status === 'done' ? <CircleCheck size={15} aria-hidden="true" /> : step.status === 'failed' ? <CircleAlert size={15} aria-hidden="true" /> : <CircleMinus size={15} aria-hidden="true" />}
          <span><strong>{STEP_LABELS[step.id] ?? step.id}</strong>{step.status === 'skipped' && <small>Skipped</small>}{step.detail && <small>{step.detail}</small>}</span>
        </li>)}</ul>
        <div className="blob-dialog-actions">
          {created.url && <button type="button" className="secondary-button pr-open" onClick={() => void openSafeLink(created.url as string)}><ExternalLink size={13} aria-hidden="true" />Open on GitHub</button>}
          <button type="button" className="primary-button" data-dialog-initial-focus="" onClick={onClose}>Done</button>
        </div>
      </section>
    </div>
  }
  if (native && draft) {
    return <div className="sheet-backdrop blob-dialog-backdrop is-entered">
      <section ref={ref} className="blob-dialog new-project pr-form" role="dialog" aria-modal="true" aria-labelledby="pr-dialog-title" tabIndex={-1} aria-busy={pending || undefined}>
        <h2 id="pr-dialog-title">Create a pull request</h2>
        <label className="new-project-field"><span>Title</span><input value={title} maxLength={256} data-dialog-initial-focus="" onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="new-project-field"><span>Description</span><textarea rows={7} value={body} maxLength={60_000} onChange={(event) => setBody(event.target.value)} /></label>
        {draft.uncommitted > 0 && <label className="new-project-check"><input type="checkbox" checked={commitFirst} onChange={(event) => setCommitFirst(event.target.checked)} /><span>Commit {plural(draft.uncommitted, 'uncommitted file')} first</span></label>}
        {needsMessage && <label className="new-project-field"><span>Commit message</span><input value={commitMessage} maxLength={256} onChange={(event) => setCommitMessage(event.target.value)} /></label>}
        <label className="new-project-check"><input type="checkbox" checked={asDraft} onChange={(event) => setAsDraft(event.target.checked)} /><span>Open it as a draft</span></label>
        <div className="scaffold-plan"><strong>This will:</strong><ol>{pullRequestPlan(draft, commitFirst, asDraft).map((line) => <li key={line}>{line}</li>)}</ol></div>
        {draft.uncommitted > 0 && !commitFirst && <p className="pr-dialog-note">The uncommitted files stay on your computer and aren't part of this.</p>}
        {failure && <p className="hold-confirm-error" role="alert">{failure}</p>}
        <div className="blob-dialog-actions">
          <button type="button" className="secondary-button pr-ask" disabled={pending} onClick={() => setAskInstead(true)}>Ask {botName} instead</button>
          <button type="button" className="secondary-button" disabled={pending} onClick={close}>Cancel</button>
          <button type="button" className="primary-button" disabled={!canCreate} onClick={() => void create()}>{pending ? <><LoaderCircle size={14} className="spinning" aria-hidden="true" />Creating…</> : 'Create pull request'}</button>
        </div>
      </section>
    </div>
  }
  const reason = draft && !draft.ready && !askInstead ? draft.reason : null
  return <div className="sheet-backdrop blob-dialog-backdrop is-entered">
    <section ref={ref} className="blob-dialog pr-dialog" role="dialog" aria-modal="true" aria-labelledby="pr-dialog-title" tabIndex={-1} aria-busy={pending || undefined}>
      <span className="blob-dialog-icon" aria-hidden="true"><GitPullRequest size={18} /></span>
      <h2 id="pr-dialog-title">Create a pull request?</h2>
      <p>{botName} will look at these changes, commit the ones that belong together, push the branch and open a pull request with the tools installed on this computer. It sends you the link, or says what stopped it.</p>
      {draft?.existingUrl && !askInstead && <p className="pr-existing">This branch already has an open pull request. <button type="button" className="rail-link" onClick={() => void openSafeLink(draft.existingUrl as string)}>Open it on GitHub</button></p>}
      {reason && <p className="pr-dialog-note">Bitbots can't open this one itself: {reason}</p>}
      <dl className="pr-dialog-facts">
        <div><dt>Repository</dt><dd title={root}>{folder}</dd></div>
        <div><dt>Branch</dt><dd>{repository.detached ? 'Detached HEAD' : repository.branch ?? 'Unknown'}</dd></div>
        <div><dt>Changes</dt><dd>{fileCount} {repository.files.length === 1 && !repository.truncated ? 'file' : 'files'} · <span className="rail-add">+{repository.addedLines.toLocaleString()}</span> <span className="rail-del">−{repository.removedLines.toLocaleString()}</span></dd></div>
      </dl>
      <p className="pr-dialog-note">These are all the uncommitted changes in the repository, not only this conversation's. {botName} commits only what it judges relevant and tells you what it left out.{busy ? ` ${botName} is working now, so this waits until the current turn ends.` : ''}</p>
      {failure && <p className="hold-confirm-error" role="alert">{failure}</p>}
      <div className="blob-dialog-actions">
        <button type="button" className="secondary-button" data-dialog-initial-focus disabled={pending} onClick={close}>Cancel</button>
        <button type="button" className="primary-button" disabled={pending} onClick={() => void ask()}>{pending ? 'Sending…' : `Ask ${botName} to create it`}</button>
      </div>
    </section>
  </div>
}
