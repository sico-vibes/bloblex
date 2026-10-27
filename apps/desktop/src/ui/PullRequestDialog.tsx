import { useState } from 'react'
import { GitPullRequest } from 'lucide-react'
import { useDialogAccessibility } from './dialogFocus'
import { friendlyErrorText } from './errorCopy'
import type { RepositoryState } from './sessionRepository'

/**
 * The last look before a pull request is requested. Confirming sends an ordinary message to the open
 * conversation's coding agent (the same path as typing it); nothing happens to the repository from here,
 * and the dialog only closes once the daemon has accepted the message.
 */
export function PullRequestDialog({ repository, botName, busy, onSend, onClose }: {
  repository: RepositoryState
  botName: string
  /** The coding agent is in the middle of a turn, so the request waits behind it. */
  busy: boolean
  /** Sends the request; rejects when the daemon refuses it. */
  onSend: () => Promise<void>
  onClose: () => void
}) {
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState('')
  const { ref, close } = useDialogAccessibility(onClose, () => !pending)
  const root = repository.repoRoot ?? repository.projectPath ?? ''
  const folder = root.split(/[\\/]/).filter(Boolean).pop() ?? 'this repository'
  const fileCount = `${repository.files.length}${repository.truncated ? '+' : ''}`
  const confirm = async () => {
    if (pending) return
    setPending(true); setFailure('')
    try { await onSend(); onClose() }
    catch (reason) { setFailure(friendlyErrorText(reason instanceof Error ? reason.message : String(reason))); setPending(false) }
  }
  return <div className="sheet-backdrop blob-dialog-backdrop is-entered">
    <section ref={ref} className="blob-dialog pr-dialog" role="dialog" aria-modal="true" aria-labelledby="pr-dialog-title" tabIndex={-1} aria-busy={pending || undefined}>
      <span className="blob-dialog-icon" aria-hidden="true"><GitPullRequest size={18} /></span>
      <h2 id="pr-dialog-title">Create a pull request?</h2>
      <p>{botName} will look at these changes, commit the ones that belong together, push the branch and open a pull request with the tools installed on this computer. It sends you the link, or says what stopped it.</p>
      <dl className="pr-dialog-facts">
        <div><dt>Repository</dt><dd title={root}>{folder}</dd></div>
        <div><dt>Branch</dt><dd>{repository.detached ? 'Detached HEAD' : repository.branch ?? 'Unknown'}</dd></div>
        <div><dt>Changes</dt><dd>{fileCount} {repository.files.length === 1 && !repository.truncated ? 'file' : 'files'} · <span className="rail-add">+{repository.addedLines.toLocaleString()}</span> <span className="rail-del">−{repository.removedLines.toLocaleString()}</span></dd></div>
      </dl>
      <p className="pr-dialog-note">These are all the uncommitted changes in the repository, not only this conversation's. {botName} commits only what it judges relevant and tells you what it left out.{busy ? ` ${botName} is working now, so this waits until the current turn ends.` : ''}</p>
      {failure && <p className="hold-confirm-error" role="alert">{failure}</p>}
      <div className="blob-dialog-actions">
        <button type="button" className="secondary-button" data-dialog-initial-focus disabled={pending} onClick={close}>Cancel</button>
        <button type="button" className="primary-button" disabled={pending} onClick={() => void confirm()}>{pending ? 'Sending…' : `Ask ${botName} to create it`}</button>
      </div>
    </section>
  </div>
}
