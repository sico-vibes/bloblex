// Phase 1B: create a new project. A folder, optionally a git repository, and
// optionally a GitHub repository. The list of what will happen is the owner's
// approval: nothing starts until they confirm it. A step that fails stops the
// rest, and whatever already worked stays.
import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, CircleMinus, FolderOpen, LoaderCircle } from 'lucide-react'
import type { Project } from '../types'
import { openProjectFolder, rpc } from '../tauri'
import { useDialogAccessibility, useDialogEntered } from './dialogFocus'
import { CloneProject, DiscoverProjects } from './ProjectSources'
import './newProject.css'
import './diffBody.css'

export type ScaffoldStatus = { git: boolean; gh: { available: boolean; login: string | null } }
export type ScaffoldStep = { id: string; status: 'done' | 'failed' | 'skipped'; detail: string | null }
export type ScaffoldResult = { project: Project | null; steps: ScaffoldStep[]; githubUrl: string | null }
export type GithubVisibility = 'private' | 'public'

export const STEP_LABELS: Record<string, string> = { folder: 'Create the folder', project: 'Add the project to Bitbots', git_init: 'Start a git repository', first_commit: 'Make the first commit', github: 'Create the GitHub repository and push' }

/** Why a project can't be named this, or null. The daemon checks again. */
export function folderNameProblem(raw: string): string | null {
  const name = raw.trim()
  if (!name) return 'Give the project a name.'
  if (name.length > 80) return 'Use 80 characters or fewer.'
  if (/[<>:"/\\|?*]/.test(name)) return 'A folder name can\'t contain < > : " / \\ | ? or *.'
  if (/[. ]$/.test(raw.trimStart())) return 'A folder name can\'t end with a dot or a space.'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) return 'Windows reserves that name. Choose another.'
  return null
}

/** What the owner is approving, in order. */
export function scaffoldPlan(name: string, parent: string, git: boolean, github: GithubVisibility | null, login: string | null): string[] {
  const folder = `${parent.replace(/[\\/]+$/, '')}\\${name.trim()}`
  return [
    `Create the folder ${folder}`,
    'Add it to Bitbots as a project',
    ...(git ? ['Start a git repository and commit a README'] : []),
    ...(git && github ? [`Create a ${github} GitHub repository${login ? ` under ${login}` : ''} and push to it`] : []),
  ]
}

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : typeof reason === 'string' && reason ? reason : fallback

export function NewProjectDialog({ onCancel, onDone }: { onCancel: () => void; onDone: (project: Project | null) => void }) {
  const entered = useDialogEntered()
  const [busy, setBusy] = useState(false)
  const [source, setSource] = useState<'new' | 'clone' | 'discover'>('new')
  const [cloning, setCloning] = useState(false)
  const [result, setResult] = useState<ScaffoldResult | null>(null)
  const { ref, close } = useDialogAccessibility(() => { if (result) onDone(result.project); else onCancel() }, () => !busy && !cloning)
  const [status, setStatus] = useState<ScaffoldStatus | null>(null)
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [git, setGit] = useState(true)
  const [github, setGithub] = useState(false)
  const [visibility, setVisibility] = useState<GithubVisibility>('private')
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void rpc<ScaffoldStatus>('project.scaffold.status', {}).then((next) => { if (live) { setStatus(next); if (next?.git === false) setGit(false) } }).catch(() => { if (live) setStatus({ git: false, gh: { available: false, login: null } }) })
    return () => { live = false }
  }, [])
  const nameProblem = name ? folderNameProblem(name) : null
  // `available` only means the command runs; GitHub also needs a sign-in.
  const githubReady = !!status?.gh.available && !!status.gh.login
  const wantsGithub = git && github && githubReady
  const ready = !busy && !folderNameProblem(name) && !!parent
  const browse = async () => { const path = await openProjectFolder().catch(() => null); if (path) setParent(path) }
  const create = async () => {
    if (!ready) return
    setBusy(true); setProblem(null)
    try {
      const made = await rpc<ScaffoldResult>('project.scaffold', { name: name.trim(), parentPath: parent, git, github: wantsGithub ? { visibility } : null, confirm: true })
      setResult({ project: made?.project ?? null, steps: Array.isArray(made?.steps) ? made.steps : [], githubUrl: made?.githubUrl ?? null })
    } catch (reason) { setProblem(messageOf(reason, 'The project could not be created.')) }
    finally { setBusy(false) }
  }
  return <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`}>
    <section ref={ref} className="blob-dialog new-project" role="dialog" aria-modal="true" aria-labelledby="new-project-title" tabIndex={-1}>
      <h2 id="new-project-title">{result ? (result.steps.some((step) => step.status === 'failed') ? 'Not everything worked' : 'Project created') : source === 'clone' ? 'Clone a repository' : source === 'discover' ? 'Find repositories' : 'New project'}</h2>
      {!result && <div className="diff-mode new-project-source" role="group" aria-label="How to add the project">
        {([['new', 'Create'], ['clone', 'Clone'], ['discover', 'Find']] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={source === id} disabled={busy || cloning} onClick={() => setSource(id)}>{label}</button>)}
      </div>}
      {!result && source === 'clone' && <CloneProject onCancel={close} onDone={onDone} onBusy={setCloning} />}
      {!result && source === 'discover' && <DiscoverProjects onCancel={close} onDone={onDone} />}
      {source !== 'new' && !result ? null : result
        ? <>
          <ul className="scaffold-steps">{result.steps.map((step) => <li key={step.id} data-status={step.status}>
            {step.status === 'done' ? <CircleCheck size={15} aria-hidden="true" /> : step.status === 'failed' ? <CircleAlert size={15} aria-hidden="true" /> : <CircleMinus size={15} aria-hidden="true" />}
            <span><strong>{STEP_LABELS[step.id] ?? step.id}</strong>{step.status === 'skipped' && <small>Skipped</small>}{step.detail && <small>{step.detail}</small>}</span>
          </li>)}</ul>
          {result.githubUrl && <p className="scaffold-url">On GitHub: <code>{result.githubUrl}</code></p>}
          <div className="blob-dialog-actions"><button type="button" className="primary-button" data-dialog-initial-focus="" onClick={() => onDone(result.project)}>Done</button></div>
        </>
        : <>
          <label className="new-project-field"><span>Name</span>
            <input value={name} maxLength={80} data-dialog-initial-focus="" spellCheck={false} aria-invalid={!!nameProblem} placeholder="my-project" onChange={(event) => setName(event.target.value)} />
            {nameProblem && <small className="new-project-error" role="alert">{nameProblem}</small>}
          </label>
          <div className="new-project-field"><span id="new-project-where">Create it in</span>
            <button type="button" className="secondary-button new-project-browse" aria-describedby="new-project-where" onClick={() => void browse()}><FolderOpen size={14} aria-hidden="true" /><span>{parent || 'Choose a folder…'}</span></button>
          </div>
          <label className="new-project-check"><input type="checkbox" checked={git} disabled={status?.git === false} onChange={(event) => setGit(event.target.checked)} /><span>Start a git repository{status?.git === false && <small>Git isn't installed on this computer.</small>}</span></label>
          <label className="new-project-check"><input type="checkbox" checked={wantsGithub} disabled={!git || !githubReady} onChange={(event) => setGithub(event.target.checked)} /><span>Also create it on GitHub<small>{status === null ? 'Checking the GitHub CLI…' : !status.gh.available ? 'Install and sign in to the GitHub CLI (gh) to use this.' : status.gh.login ? `Signed in as ${status.gh.login}` : 'Sign in to the GitHub CLI first: run gh auth login in a terminal.'}</small></span></label>
          {wantsGithub && <div className="new-project-visibility" role="radiogroup" aria-label="Who can see the GitHub repository">
            {(['private', 'public'] as const).map((choice) => <label key={choice}><input type="radio" name="new-project-visibility" checked={visibility === choice} onChange={() => setVisibility(choice)} /><span>{choice === 'private' ? 'Private' : 'Public'}</span></label>)}
          </div>}
          {ready && <div className="scaffold-plan"><strong>This will:</strong><ol>{scaffoldPlan(name, parent, git, wantsGithub ? visibility : null, status?.gh.login ?? null).map((line) => <li key={line}>{line}</li>)}</ol></div>}
          {problem && <p className="new-project-error" role="alert">{problem}</p>}
          <div className="blob-dialog-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={close}>Cancel</button>
            <button type="button" className="primary-button" disabled={!ready} onClick={() => void create()}>{busy ? <><LoaderCircle size={14} className="spinning" aria-hidden="true" />Creating…</> : 'Create project'}</button>
          </div>
        </>}
    </section>
  </div>
}
