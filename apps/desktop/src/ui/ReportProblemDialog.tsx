// Phase 1B: report a problem. The daemon drafts an issue with no secrets, messages
// or project names. The owner sees and edits the exact text, and nothing leaves the
// computer until they choose to post it or open it in their browser.
import { useEffect, useState } from 'react'
import { Copy, ExternalLink, LoaderCircle, Send } from 'lucide-react'
import { rpc } from '../tauri'
import { useDialogAccessibility, useDialogEntered } from './dialogFocus'
import { openSafeLink } from './openSafeLink'
import './newProject.css'

export type IssueDraft = { repo: string; title: string; body: string; gh: { available: boolean; login: string | null } }

const MAX_URL_BODY_CHARS = 6_000

/** GitHub's new-issue address with the owner's edited text; a long body is cut so the address stays usable. */
export function issueUrl(repo: string, title: string, body: string): string {
  const cut = body.length > MAX_URL_BODY_CHARS ? `${body.slice(0, MAX_URL_BODY_CHARS)}\n\n(cut to fit the address)` : body
  return `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(cut)}`
}

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : typeof reason === 'string' && reason ? reason : fallback

export function ReportProblemDialog({ onClose }: { onClose: () => void }) {
  const entered = useDialogEntered()
  const [busy, setBusy] = useState(false)
  const { ref, close } = useDialogAccessibility(onClose, () => !busy)
  const [draft, setDraft] = useState<IssueDraft | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [posted, setPosted] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let live = true
    void rpc<IssueDraft>('diagnostics.issueDraft', {}).then((next) => { if (!live) return; setDraft(next); setTitle(next?.title ?? ''); setBody(next?.body ?? '') }).catch((reason) => { if (live) setProblem(messageOf(reason, 'The report could not be prepared.')) })
    return () => { live = false }
  }, [])
  const ready = !!draft && !!title.trim() && !busy
  // `available` only means the command runs; posting also needs a sign-in.
  const canPost = !!draft?.gh.available && !!draft.gh.login
  const post = async () => {
    if (!ready) return
    setBusy(true); setProblem(null)
    try { const result = await rpc<{ url?: string }>('diagnostics.issuePost', { title: title.trim(), body, confirm: true }); setPosted(result?.url ?? '') }
    catch (reason) { setProblem(messageOf(reason, 'The issue could not be posted.')) }
    finally { setBusy(false) }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(`${title.trim()}\n\n${body}`); setCopied(true); window.setTimeout(() => setCopied(false), 1600) }
    catch { setProblem('The report could not be copied. Select it and copy it yourself.') }
  }
  return <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`}>
    <section ref={ref} className="blob-dialog report-problem" role="dialog" aria-modal="true" aria-labelledby="report-title" tabIndex={-1}>
      <h2 id="report-title">{posted !== null ? 'Thanks for reporting this' : 'Report a problem'}</h2>
      {posted !== null
        ? <>
          <p>Your issue is on GitHub.{posted ? '' : ' GitHub did not return its address.'}</p>
          <div className="blob-dialog-actions">
            {posted && <button type="button" className="secondary-button" onClick={() => void openSafeLink(posted)}><ExternalLink size={14} aria-hidden="true" />Open it</button>}
            <button type="button" className="primary-button" data-dialog-initial-focus="" onClick={close}>Done</button>
          </div>
        </>
        : <>
          <p>This goes to a public issue at <strong>{draft?.repo ?? 'GitHub'}</strong>, exactly as written below. It leaves out your messages, logs, settings and project names. Read it first, and remove anything you'd rather not share.</p>
          {!draft && !problem && <p role="status"><LoaderCircle size={14} className="spinning" aria-hidden="true" /> Preparing the report…</p>}
          {draft && <>
            <label><span>Title</span><input value={title} maxLength={200} data-dialog-initial-focus="" placeholder="Say what went wrong in a few words" onChange={(event) => setTitle(event.target.value)} /></label>
            <label><span>Report</span><textarea value={body} maxLength={60_000} spellCheck={false} onChange={(event) => setBody(event.target.value)} /></label>
            <p className="report-problem-note">{canPost ? `Posting uses your GitHub CLI sign-in, as ${draft.gh.login}.` : 'To post from here, install and sign in to the GitHub CLI (gh). You can also open it in your browser.'} If someone asks for more detail, Export diagnostics in Settings makes a zip you can attach yourself.</p>
          </>}
          {problem && <p className="new-project-error" role="alert">{problem}</p>}
          <div className="blob-dialog-actions report-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={close}>Cancel</button>
            <span>
              <button type="button" className="ghost-button" disabled={!draft} onClick={() => void copy()}><Copy size={14} aria-hidden="true" />{copied ? 'Copied' : 'Copy'}</button>
              <button type="button" className={canPost ? 'secondary-button' : 'primary-button'} disabled={!ready} title="Opens GitHub with this text filled in. You post it there." onClick={() => { if (draft) void openSafeLink(issueUrl(draft.repo, title.trim(), body)) }}><ExternalLink size={14} aria-hidden="true" />Open in browser</button>
              {canPost && <button type="button" className="primary-button" disabled={!ready} onClick={() => void post()}>{busy ? <LoaderCircle size={14} className="spinning" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}Post issue</button>}
            </span>
          </div>
        </>}
    </section>
  </div>
}
