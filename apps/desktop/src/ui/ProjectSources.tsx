// Phase 3: two more ways to add a project, beside creating one. Clone copies a repository
// into a folder the owner picks, and Find looks through a folder for repositories already
// there. The daemon checks the URL and the folder; this only explains what it refuses.
import { useEffect, useRef, useState } from 'react'
import { CircleAlert, CircleCheck, FolderOpen, GitBranch, LoaderCircle } from 'lucide-react'
import type { Project } from '../types'
import { openProjectFolder, rpc } from '../tauri'

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : typeof reason === 'string' && reason ? reason : fallback

export type CloneJob = { id: string; url: string; target: string; state: 'running' | 'done' | 'failed' | 'cancelled'; detail: string | null; project: Project | null }

/** The folder a clone would make: the URL's last part without `.git`. */
export function nameFromCloneUrl(url: string): string {
  const last = url.trim().replace(/[\\/]+$/, '').split(/[\\/:]/).pop() ?? ''
  return last.replace(/\.git$/i, '')
}

/** Why this URL can't be cloned, or null. The daemon checks again. */
export function cloneUrlProblem(raw: string): string | null {
  const url = raw.trim()
  if (!url) return 'Paste the repository\'s URL.'
  if (!/^(https:\/\/|ssh:\/\/|git@[^\s:]+:)/i.test(url)) return 'Use an https://, ssh:// or git@ address.'
  if (/^https:\/\/[^/\s]*:[^/\s]*@/i.test(url)) return 'Put no password in the URL. Sign in with git or the GitHub CLI instead.'
  if (/\s/.test(url)) return 'A URL can\'t contain spaces.'
  return null
}

const usePickedFolder = () => {
  const [folder, setFolder] = useState('')
  useEffect(() => {
    let live = true
    void rpc<{ settings?: Record<string, unknown> } | Record<string, unknown>>('settings.get', {}).then((reply) => {
      const settings = (reply && 'settings' in reply ? reply.settings : reply) as Record<string, unknown> | undefined
      const saved = settings?.['projects.folder']
      if (live && typeof saved === 'string' && saved) setFolder((current) => current || saved)
    }).catch(() => undefined)
    return () => { live = false }
  }, [])
  const browse = async () => {
    const path = await openProjectFolder().catch(() => null)
    if (!path) return
    setFolder(path)
    void rpc('settings.set', { key: 'projects.folder', value: path }).catch(() => undefined)
  }
  return { folder, browse }
}

function FolderField({ label, folder, onBrowse, id }: { label: string; folder: string; onBrowse: () => void; id: string }) {
  return <div className="new-project-field"><span id={id}>{label}</span>
    <button type="button" className="secondary-button new-project-browse" aria-describedby={id} onClick={onBrowse}><FolderOpen size={14} aria-hidden="true" /><span>{folder || 'Choose a folder…'}</span></button>
  </div>
}

export function CloneProject({ onCancel, onDone, onBusy }: { onCancel: () => void; onDone: (project: Project | null) => void; onBusy: (busy: boolean) => void }) {
  const { folder, browse } = usePickedFolder()
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [job, setJob] = useState<CloneJob | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const running = starting || job?.state === 'running'
  useEffect(() => { onBusy(running) }, [running, onBusy])
  const jobId = job?.state === 'running' ? job.id : null
  useEffect(() => {
    if (!jobId) return
    const timer = window.setInterval(() => {
      void rpc<{ jobs?: CloneJob[] }>('project.clone.list', {}).then((reply) => {
        const next = reply?.jobs?.find((item) => item.id === jobId)
        if (next) setJob(next)
      }).catch(() => undefined)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [jobId])
  const urlProblem = url ? cloneUrlProblem(url) : null
  const folderName = name.trim() || nameFromCloneUrl(url)
  const ready = !running && !cloneUrlProblem(url) && !!folder && !!folderName
  const start = async () => {
    if (!ready) return
    setStarting(true); setProblem(null)
    try {
      const reply = await rpc<{ job?: CloneJob }>('project.clone', { url: url.trim(), parent: folder, name: name.trim() || null, confirm: true })
      setJob(reply?.job ?? null)
      if (!reply?.job) setProblem('The clone could not start.')
    } catch (reason) { setProblem(messageOf(reason, 'The clone could not start.')) }
    finally { setStarting(false) }
  }
  if (job && job.state !== 'running') {
    const ok = job.state === 'done'
    return <>
      <div className="clone-result" role="status" data-state={job.state}>
        {ok ? <CircleCheck size={16} aria-hidden="true" /> : <CircleAlert size={16} aria-hidden="true" />}
        <span><strong>{ok ? 'Cloned and added as a project' : job.state === 'cancelled' ? 'Clone cancelled' : 'The clone didn\'t finish'}</strong>{ok ? <small>{job.target}</small> : job.detail && <small>{job.detail}</small>}</span>
      </div>
      <div className="blob-dialog-actions">
        {!ok && <button type="button" className="secondary-button" onClick={() => setJob(null)}>Try again</button>}
        <button type="button" className="primary-button" data-dialog-initial-focus="" onClick={() => onDone(job.project)}>Done</button>
      </div>
    </>
  }
  return <>
    <label className="new-project-field"><span>Repository URL</span>
      <input value={url} data-dialog-initial-focus="" spellCheck={false} disabled={running} aria-invalid={!!urlProblem} placeholder="https://github.com/owner/repo.git" onChange={(event) => setUrl(event.target.value)} />
      {urlProblem && <small className="new-project-error" role="alert">{urlProblem}</small>}
    </label>
    <FolderField label="Clone it into" id="clone-where" folder={folder} onBrowse={() => void browse()} />
    <label className="new-project-field"><span>Folder name</span>
      <input value={name} maxLength={80} spellCheck={false} disabled={running} placeholder={nameFromCloneUrl(url) || 'repo'} onChange={(event) => setName(event.target.value)} />
    </label>
    {running && <p className="clone-running" role="status"><LoaderCircle size={14} className="spinning" aria-hidden="true" />Cloning. Large repositories can take a while.</p>}
    {problem && <p className="new-project-error" role="alert">{problem}</p>}
    <div className="blob-dialog-actions">
      {running && job
        ? <button type="button" className="secondary-button" onClick={() => void rpc('project.clone.cancel', { id: job.id }).catch(() => undefined)}>Stop</button>
        : <button type="button" className="secondary-button" disabled={starting} onClick={onCancel}>Cancel</button>}
      <button type="button" className="primary-button" disabled={!ready} onClick={() => void start()}>{running ? 'Cloning…' : 'Clone'}</button>
    </div>
  </>
}

type FoundRepo = { path: string; name: string; branch: string | null; alreadyAdded: boolean }

export function DiscoverProjects({ onCancel, onDone }: { onCancel: () => void; onDone: (project: Project | null) => void }) {
  const { folder, browse } = usePickedFolder()
  const [repos, setRepos] = useState<FoundRepo[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const [looking, setLooking] = useState(false)
  const [adding, setAdding] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const request = useRef(0)
  useEffect(() => {
    if (!folder) return
    const mine = ++request.current
    setLooking(true); setProblem(null); setRepos(null); setChosen(new Set())
    void rpc<{ repos?: FoundRepo[]; truncated?: boolean }>('project.discover', { folder, depth: null })
      .then((reply) => { if (mine === request.current) { setRepos(reply?.repos ?? []); setTruncated(reply?.truncated === true) } })
      .catch((reason) => { if (mine === request.current) { setRepos([]); setProblem(messageOf(reason, 'That folder could not be searched.')) } })
      .finally(() => { if (mine === request.current) setLooking(false) })
  }, [folder])
  const toggle = (path: string) => setChosen((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next })
  const add = async () => {
    setAdding(true); setProblem(null)
    let last: Project | null = null
    const failed: string[] = []
    for (const repo of (repos ?? []).filter((item) => chosen.has(item.path))) {
      try { last = (await rpc<{ project?: Project }>('project.create', { name: repo.name, path: repo.path }))?.project ?? last }
      catch { failed.push(repo.name) }
    }
    setAdding(false)
    if (failed.length) { setProblem(`These couldn't be added: ${failed.join(', ')}.`); return }
    onDone(last)
  }
  const available = (repos ?? []).filter((repo) => !repo.alreadyAdded)
  return <>
    <FolderField label="Look in" id="discover-where" folder={folder} onBrowse={() => void browse()} />
    {looking && <p className="clone-running" role="status"><LoaderCircle size={14} className="spinning" aria-hidden="true" />Looking for repositories…</p>}
    {repos && !looking && (repos.length
      ? <ul className="discover-list" aria-label="Repositories found">{repos.map((repo) => <li key={repo.path}>
        <label data-added={repo.alreadyAdded || undefined} title={repo.path}>
          <input type="checkbox" disabled={repo.alreadyAdded || adding} checked={repo.alreadyAdded || chosen.has(repo.path)} onChange={() => toggle(repo.path)} />
          <span className="discover-name"><strong>{repo.name}</strong><small>{repo.alreadyAdded ? 'Already added' : repo.path}</small></span>
          {repo.branch && <span className="discover-branch"><GitBranch size={11} aria-hidden="true" />{repo.branch}</span>}
        </label>
      </li>)}</ul>
      : <p className="settings-empty" role="status">No git repositories in that folder.</p>)}
    {truncated && <p className="pr-dialog-note">There are more than this. Choose a smaller folder to see the rest.</p>}
    {problem && <p className="new-project-error" role="alert">{problem}</p>}
    <div className="blob-dialog-actions">
      <button type="button" className="secondary-button" disabled={adding} onClick={onCancel}>Cancel</button>
      <button type="button" className="primary-button" disabled={adding || !chosen.size} onClick={() => void add()}>{adding ? 'Adding…' : chosen.size ? `Add ${chosen.size} ${chosen.size === 1 ? 'project' : 'projects'}` : available.length ? 'Choose some to add' : 'Add'}</button>
    </div>
  </>
}
