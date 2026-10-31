// The right-hand rail for the open conversation: where it works, how full its
// context is, what it produced and what it changed. Each card collapses and
// remembers that. Values are only what the daemon reported; nothing is guessed.
// Outputs and Changes read the repository itself (`session.repository`): what Git
// says differs from HEAD now, whoever made the change, with what the conversation's
// own coding agent reported kept alongside for anything Git no longer lists.
import { useEffect, useState, type ReactNode } from 'react'
import { Bot, ChevronDown, ChevronRight, CircleAlert, Code2, Copy, FileText, FolderOpen, GitBranch, Monitor, Smartphone } from 'lucide-react'
import type { Agent, JsonRecord, Session } from '../types'
import { rpc } from '../tauri'
import { HelpTip } from './SettingsParts'
import { Skeleton } from './Skeleton'
import { usePlatform } from '../transport/platform'
import { useRemoteStatus } from '../remote/useRemote'
import { CheckpointsBody, WorkspaceBody } from './SessionRailExtras'
import { ScheduleOverview } from './ScheduleOverview'
import { isDraftSession } from './teamSelectors'
import { buildRailView, conversationFiles, repositoryRefreshKey, useSessionRepository, type RailFile, type RepositoryState } from './sessionRepository'
import './sessionRail.css'

type Environment = { projectPath: string | null; gitRepo: boolean; branch: string | null; detached: boolean; host: string }

const environmentCache = new Map<string, Environment>()

function useEnvironment(sessionId: string | null) {
  const [value, setValue] = useState<Environment | null>(() => sessionId ? environmentCache.get(sessionId) ?? null : null)
  useEffect(() => {
    if (!sessionId) { setValue(null); return }
    setValue(environmentCache.get(sessionId) ?? null)
    let cancelled = false
    void rpc<Environment>('session.environment', { sessionId }).then((result) => {
      if (cancelled || !result || typeof result !== 'object') return
      environmentCache.set(sessionId, result)
      setValue(result)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [sessionId])
  return value
}

function readOpen(id: string) {
  try { return localStorage.getItem(`bloblex.rail.${id}`) !== '0' } catch { return true }
}

function Card({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(() => readOpen(id))
  const toggle = () => setOpen((current) => { try { localStorage.setItem(`bloblex.rail.${id}`, current ? '0' : '1') } catch { /* preference only */ } return !current })
  return <section className="rail-card" aria-labelledby={`rail-${id}`}>
    <header className="rail-card-head">
      <button type="button" id={`rail-${id}`} className="rail-card-toggle" aria-expanded={open} onClick={toggle}>{title}{open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}</button>
      {aside}
    </header>
    {open && <div className="rail-card-body">{children}</div>}
  </section>
}

function compact(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`
  return String(value)
}

const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0

/** This conversation's reported token counts, summed across its turns (each report counted once). */
export function sessionTokenSplit(session: Session | null, usage: readonly JsonRecord[]) {
  if (!session) return null
  const seen = new Set<string>()
  const rows = [...(session.usage ?? []), ...usage.filter((entry) => entry.sessionId === session.id)].filter((entry) => {
    const key = typeof entry.id === 'string' ? entry.id : JSON.stringify([entry.turnId, entry.timestamp, entry.inputTokens, entry.outputTokens])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (!rows.length) return null
  const total = (key: string) => rows.reduce((sum, entry) => sum + num(entry[key]), 0)
  return { input: total('inputTokens'), output: total('outputTokens'), cacheRead: total('cacheReadTokens'), cacheWrite: total('cacheWriteTokens'), reasoning: total('reasoningTokens') }
}

/** One entry per path (its latest change), newest first, with +/− counts where a diff or count was reported. */
export const fileChanges = conversationFiles

const folderOf = (path: string | null | undefined) => path?.split(/[\\/]/).filter(Boolean).pop() ?? null
const lines = (value: number) => value.toLocaleString('en-US')

/** The small tag a file row carries when its diff is not the whole story. */
export function fileNote(file: RailFile): string | null {
  if (file.change === 'deleted') return 'deleted'
  if (file.binary) return 'binary'
  if (file.truncated) return 'cut short'
  if (file.change === 'renamed') return 'renamed'
  return null
}

/** Why a row cannot open a diff, in words; null when it can. */
export function diffUnavailableReason(file: RailFile): string | null {
  if (file.diff) return null
  if (file.binary) return 'Binary file: there is no text diff to show.'
  if (file.change === 'deleted') return 'The file was deleted, so there is no text diff to show.'
  return file.source === 'repository' ? 'Git did not return a diff for this file. Open it to read the change.' : 'The coding agent did not report a diff for this file.'
}

/** How many changed files the Changes card lists before "Show all". */
const CHANGE_LIMIT = 8

export function SessionRail({ session, usage, appliedModel, onOpenFile, onRevealFile, onCopyPath, onDiff, onOpenFolder, runtimeFacts, onOpenRemote, workingBots, botName = 'The bot', canCreatePr = false, onCreatePr, onReview, active = true, agents = [], isManager = false, onOpenSessionById, onOpenSchedules }: {
  /** Every bot, so a schedule can name the bot it wakes. */
  agents?: readonly Agent[]
  /** The Manager sees every schedule; any other bot sees its own and its project's. */
  isManager?: boolean
  onOpenSessionById?: (sessionId: string) => void
  onOpenSchedules?: () => void
  workingBots?: ReactNode
  session: Session | null
  usage: readonly JsonRecord[]
  /** The model the coding agent last reported actually using, when known. */
  appliedModel?: string | null
  onOpenFile: (path: string) => void
  onRevealFile: (path: string) => void
  onCopyPath: (path: string) => void
  onDiff: (path: string, diff: string) => void
  /** Opens the review screen, on this file when one is named. Desktop only. */
  onReview?: (repositoryPath: string | null) => void
  onOpenFolder: (path: string) => void
  /** Coding agent facts (version, sign-in, executable) for the Environment card's "?" tip. */
  runtimeFacts?: string
  /** Opens Settings > Remote, where Remote is turned on (Tailscale check and consent live there). */
  onOpenRemote?: () => void
  /** The open conversation's bot, named in the pull request dialog. */
  botName?: string
  /** The conversation can take a message right now (connected, a usable coding agent, not a draft). */
  canCreatePr?: boolean
  /** Opens the pull request review; the App sends the request once the owner confirms. */
  onCreatePr?: (repository: RepositoryState) => void
  /** The rail is on screen. A hidden rail does not read the repository. */
  active?: boolean
}) {
  const platform = usePlatform()
  const remote = useRemoteStatus(true)
  const [remoteBusy, setRemoteBusy] = useState(false)
  // A draft is not in the daemon until its first message, so it is never asked about.
  const environment = useEnvironment(session && !isDraftSession(session) ? session.id : null)
  const busy = ['working', 'starting', 'waiting_permission'].includes(session?.state ?? '')
  const repository = useSessionRepository(session, repositoryRefreshKey(session), busy, active)
  const [showAllOutputs, setShowAllOutputs] = useState(false)
  const [showAllChanges, setShowAllChanges] = useState(false)
  if (!session) return <div className="session-rail">{workingBots}<div className="rail-empty">Open a conversation to see where it works and what it changed.</div></div>
  const projectPath = repository.data?.projectPath ?? environment?.projectPath ?? session.projectPath ?? null
  const folderName = typeof session.workspaceLabel === 'string' && session.workspaceLabel ? session.workspaceLabel : folderOf(projectPath)
  const used = num(session.contextUsed)
  const size = num(session.contextSize)
  const percent = size > 0 ? Math.min(100, Math.round((used / size) * 100)) : null
  const split = sessionTokenSplit(session, usage)
  const repo = repository.data
  const view = buildRailView(session, repo)
  const outputs = view.created
  const visibleOutputs = showAllOutputs ? outputs : outputs.slice(0, 5)
  const branch = repo?.gitRepo && repo.branch ? repo.branch : environment?.gitRepo ? environment.branch : null
  const detached = repo?.gitRepo ? repo.detached : environment?.detached === true
  const repoName = folderOf(repo?.repoRoot ?? projectPath)
  // A folder that is not a Git repository is a state to explain, not a failure to retry.
  const notRepo = !!repo && repo.gitRepo === false
  const readFailed = repository.failed || (!!repo && !!repo.error && !notRepo)
  // A conversation in its own git copy can have finished commits and nothing uncommitted.
  const ownCopy = !!session?.link?.worktree
  const canPr = !!onCreatePr && canCreatePr && view.fromRepository && !!repo && (repo.files.length > 0 || ownCopy) && !repository.failed
  const prTitle = !onCreatePr || !repo ? undefined : repository.failed ? 'The repository could not be read just now, so these changes may be out of date. Try again first.' : !view.fromRepository ? 'Pull requests need a Git repository that can be read.' : repo.files.length === 0 && !ownCopy ? 'There are no changes to put in a pull request.' : !canCreatePr ? 'Reconnect, or pick a working coding agent, to ask for a pull request.' : `Ask ${botName} to open a pull request for these changes.`
  const total = view.repository.length + view.earlier.length
  const openFolder = projectPath && platform.editor ? <button type="button" className="rail-link" onClick={() => onOpenFolder(projectPath)}>Open the folder</button> : null
  const fileButtons = (file: RailFile) => <span className="rail-file-actions">
    {platform.editor && file.change !== 'deleted' && <button type="button" title="Open in editor" aria-label={`Open ${file.relative ?? file.path} in editor`} onClick={() => onOpenFile(file.path)}><Code2 size={12} /></button>}
    {platform.editor && file.change !== 'deleted' && <button type="button" title="Reveal in File Explorer" aria-label={`Reveal ${file.relative ?? file.path} in File Explorer`} onClick={() => onRevealFile(file.path)}><FolderOpen size={12} /></button>}
    <button type="button" title="Copy path" aria-label={`Copy ${file.relative ?? file.path}`} onClick={() => onCopyPath(file.path)}><Copy size={12} /></button>
  </span>
  const changeRow = (file: RailFile) => {
    const reason = diffUnavailableReason(file)
    const note = fileNote(file)
    // Anything Git lists opens in the review screen, which reads the whole diff itself.
    const reviewable = !!onReview && file.source === 'repository' && !!file.relative
    return <li key={file.key} className="rail-file" data-source={file.source}>
      <button type="button" className="rail-file-open" title={reviewable ? `Review ${file.relative}` : reason ?? (file.truncated ? `View the shortened diff for ${file.relative ?? file.path}` : `View the diff for ${file.relative ?? file.path}`)} aria-disabled={reason && !reviewable ? true : undefined} disabled={!!reason && !reviewable} onClick={() => { if (reviewable && file.relative) onReview?.(file.relative); else if (file.diff) onDiff(file.path, file.diff) }}>
        <FileText size={13} aria-hidden="true" /><span className="rail-file-name" title={file.relative ?? file.path}>{file.name}</span>{note && <span className="rail-tag" title={reason ?? undefined}>{note}</span>}
      </button>
      {!file.binary && file.added !== null && <em className="rail-add">+{lines(file.added)}</em>}
      {!file.binary && file.removed !== null && <i className="rail-del">−{lines(file.removed)}</i>}
      {fileButtons(file)}
    </li>
  }
  const changesAside = total > 0 || canPr || !!onCreatePr && view.fromRepository
    ? <span className="rail-card-aside">
      {view.fromRepository && total > 0 && <span className="rail-diffstat" aria-label={`${lines(view.added)} lines added, ${lines(view.removed)} removed`}><em>+{lines(view.added)}</em> <i>−{lines(view.removed)}</i></span>}
      {!view.fromRepository && view.earlier.length > 0 && <span className="rail-diffstat"><em>+{lines(view.added)}</em> <i>−{lines(view.removed)}</i></span>}
      {onReview && view.fromRepository && view.repository.length > 0 && <button type="button" className="rail-pr" title="Review these changes, stage them and comment for the bot" onClick={() => onReview(null)}>Review</button>}
      {onCreatePr && view.fromRepository && <button type="button" className="rail-pr" disabled={!canPr} title={prTitle} onClick={() => repo && onCreatePr(repo)}>Create PR</button>}
    </span>
    : undefined

  return <div className="session-rail">
    {workingBots}
    <Card id="environment" title="Environment" aside={runtimeFacts ? <HelpTip text={runtimeFacts} align="end" placement="bottom" /> : undefined}>
      <div className="rail-row"><Monitor size={13} aria-hidden="true" /><span className="rail-row-main">{environment?.host ?? 'This computer'}</span></div>
      {folderName && <div className="rail-row"><FolderOpen size={13} aria-hidden="true" /><span className="rail-row-main" title={projectPath ?? undefined}>{folderName}</span>{projectPath && platform.editor && <button type="button" className="rail-link" onClick={() => onOpenFolder(projectPath)}>Open</button>}</div>}
      {appliedModel && <div className="rail-row"><Bot size={13} aria-hidden="true" /><span className="rail-row-main" title="The model the coding agent reported using">{appliedModel}</span></div>}
      {branch && <div className="rail-row"><GitBranch size={13} aria-hidden="true" /><span className="rail-row-main" title="The branch the repository has checked out now">{branch}</span>{detached && <span className="rail-tag">detached</span>}</div>}
      {remote.available === true && remote.status && <div className="rail-row rail-remote">
        <Smartphone size={13} aria-hidden="true" />
        <span className="rail-row-main" title={remote.status.enabled && remote.status.url ? remote.status.url : undefined}>Remote{remote.status.enabled ? ` · ${remote.status.connectedCount} of ${remote.status.deviceCount} connected` : ' · off'}</span>
        <button type="button" role="switch" aria-checked={remote.status.enabled} aria-label="Remote" title={remote.status.enabled ? 'Turn Remote off' : 'Turn Remote on in Settings › Remote'} className={`toggle small ${remote.status.enabled ? 'on' : ''}`} disabled={remoteBusy || remote.status.link === 'starting'}
          onClick={() => {
            if (!remote.status?.enabled) { onOpenRemote?.(); return }
            setRemoteBusy(true)
            void rpc('remote.disable').catch(() => undefined).finally(() => setRemoteBusy(false))
          }}><i /></button>
      </div>}
    </Card>

    <Card id="workspace" title="Workspace">
      <WorkspaceBody session={session} active={active} />
    </Card>

    <Card id="schedules" title="Schedules">
      <ScheduleOverview compact agents={agents} connected={active} scope={isManager ? null : { agentId: session.agentId ?? null, projectId: session.projectId ?? null }} onOpenSession={onOpenSessionById} onOpenSchedules={onOpenSchedules} />
    </Card>

    <Card id="context" title="Context">
      {percent !== null
        ? <>
          <div className="rail-context-line"><b>{percent}% used</b><span>{compact(used)} / {compact(size)}{session.contextEstimated ? ' · estimated' : ''}</span></div>
          <i className={`rail-meter ${percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : ''}`} aria-hidden="true"><b style={{ width: `${percent}%` }} /></i>
        </>
        : <p className="rail-note">The coding agent has not reported this conversation's context size yet.</p>}
      {split && <dl className="rail-split">
        {([['Input', split.input], ['Output', split.output], ['Cache read', split.cacheRead], ['Cache write', split.cacheWrite], ['Reasoning', split.reasoning]] as const).filter(([, value]) => value > 0).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{compact(value)}</dd></div>)}
      </dl>}
    </Card>

    <Card id="outputs" title="Outputs">
      {outputs.length === 0 ? <p className="rail-note">{repository.loading ? 'Looking for new files…' : 'New files in this repository, and files this conversation creates, appear here.'}</p> : <>
        <ul className="rail-files">{visibleOutputs.map((file) => <li key={file.key} className="rail-file"><FileText size={13} aria-hidden="true" /><span className="rail-file-name" title={file.relative ?? file.path}>{file.name}</span>{fileButtons(file)}</li>)}</ul>
        {outputs.length > 5 && <button type="button" className="rail-link" onClick={() => setShowAllOutputs((value) => !value)}>{showAllOutputs ? 'Show less' : `Show ${outputs.length - 5} more`}</button>}
      </>}
    </Card>

    <Card id="changes" title="Changes" aside={changesAside}>
      {repository.loading && !repo && <div className="rail-loading" role="status" aria-busy="true"><span className="sr-only">Reading the repository…</span><Skeleton lines={3} variant="row" /></div>}
      {view.fromRepository && repo && <p className="rail-context" title={repo.repoRoot ?? undefined}><GitBranch size={12} aria-hidden="true" /><span><b>{repo.detached ? 'Detached HEAD' : repo.branch ?? 'No branch'}</b>{repoName ? ` · ${repoName}` : ''}. Every uncommitted change in this repository, not only this conversation's.</span></p>}
      {notRepo && !readFailed && (isManager
        ? <p className="rail-note">The Manager works in its own folder, not in a project, so it has no code changes of its own. The bots it assigns show their changes in their conversations.</p>
        : <p className="rail-note">{folderName ? `${folderName} is not` : 'This folder is not'} a Git repository, so changes cannot be tracked. {view.earlier.length ? 'These are the files the coding agent reported.' : 'Files the coding agent edits appear here with their diff.'}</p>)}
      {readFailed && <p className="rail-note rail-problem" role="alert"><CircleAlert size={12} aria-hidden="true" /><span>{repo?.error ? `Git could not be read here: ${repo.error}` : 'The repository could not be read.'}{view.earlier.length ? ' Showing what the coding agent reported.' : ''} <button type="button" className="rail-link" onClick={repository.refresh}>Try again</button></span></p>}
      {view.fromRepository && repo && repo.files.length === 0 && <p className="rail-note">{repoName ? `No uncommitted changes in ${repoName}.` : 'No uncommitted changes.'}{view.earlier.length ? ' Earlier edits from this conversation are below.' : ''}</p>}
      {!repository.loading && !repo && !repository.failed && total === 0 && <p className="rail-note">Files the coding agent edits appear here with their diff.</p>}
      {view.repository.length > 0 && <ul className="rail-files">{(showAllChanges ? view.repository : view.repository.slice(0, CHANGE_LIMIT)).map(changeRow)}</ul>}
      {view.repository.length > CHANGE_LIMIT && <button type="button" className="rail-link rail-more" onClick={() => setShowAllChanges((value) => !value)}>{showAllChanges ? 'Show fewer' : `Show all ${view.repository.length} files`}</button>}
      {view.fromRepository && repo?.truncated && <p className="rail-note">The repository has more changed files than are listed here. {openFolder ?? 'Open the folder to see all of them.'}</p>}
      {view.earlier.length > 0 && <>
        {view.fromRepository && <h4 className="rail-subhead">Edited earlier in this conversation</h4>}
        <ul className="rail-files">{(showAllChanges ? view.earlier : view.earlier.slice(0, CHANGE_LIMIT)).map(changeRow)}</ul>
        {view.earlier.length > CHANGE_LIMIT && !view.fromRepository && <button type="button" className="rail-link rail-more" onClick={() => setShowAllChanges((value) => !value)}>{showAllChanges ? 'Show fewer' : `Show all ${view.earlier.length} files`}</button>}
      </>}
    </Card>

    <Card id="checkpoints" title="Changes by turn">
      <CheckpointsBody session={session} active={active} onChanged={repository.refresh} />
    </Card>
  </div>
}
