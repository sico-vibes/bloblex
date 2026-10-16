// The right-hand rail for the open conversation: where it works, how full its
// context is, what it produced and what it changed. Each card collapses and
// remembers that. Values are only what the daemon reported; nothing is guessed.
import { useEffect, useState, type ReactNode } from 'react'
import { Bot, ChevronDown, ChevronRight, Code2, Copy, FileText, FolderOpen, GitBranch, Monitor } from 'lucide-react'
import type { JsonRecord, Session } from '../types'
import { rpc } from '../tauri'
import { parseUnifiedDiff } from './diffParser'
import { HelpTip } from './SettingsParts'
import { usePlatform } from '../transport/platform'
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

type FileChange = { key: string; path: string; name: string; change: string; added: number | null; removed: number | null; diff: string | null }

/** One entry per path (its latest change), newest first, with +/− counts where a diff or count was reported. */
export function fileChanges(session: Session | null): FileChange[] {
  const latest = new Map<string, FileChange>()
  for (const [index, file] of (session?.files ?? []).entries()) {
    const path = String(file.path ?? file.filePath ?? '')
    if (!path) continue
    const diff = typeof file.diff === 'string' ? file.diff : typeof file.patch === 'string' ? file.patch : null
    const parsed = diff ? parseUnifiedDiff(diff) : null
    const added = typeof file.addedLines === 'number' ? file.addedLines : typeof file.additions === 'number' ? file.additions : parsed?.additions ?? null
    const removed = typeof file.removedLines === 'number' ? file.removedLines : typeof file.deletions === 'number' ? file.deletions : parsed?.deletions ?? null
    latest.delete(path)
    latest.set(path, { key: String(file.id ?? `${path}:${index}`), path, name: path.split(/[\\/]/).pop() ?? path, change: String(file.change ?? file.kind ?? 'modified'), added, removed, diff })
  }
  return [...latest.values()].reverse()
}

export function SessionRail({ session, usage, appliedModel, onOpenFile, onRevealFile, onCopyPath, onDiff, onOpenFolder, runtimeFacts }: {
  session: Session | null
  usage: readonly JsonRecord[]
  /** The model the coding agent last reported actually using, when known. */
  appliedModel?: string | null
  onOpenFile: (path: string) => void
  onRevealFile: (path: string) => void
  onCopyPath: (path: string) => void
  onDiff: (path: string, diff: string) => void
  onOpenFolder: (path: string) => void
  /** Coding agent facts (version, sign-in, executable) for the Environment card's "?" tip. */
  runtimeFacts?: string
}) {
  const platform = usePlatform()
  const environment = useEnvironment(session?.id ?? null)
  const [showAllOutputs, setShowAllOutputs] = useState(false)
  if (!session) return <div className="rail-empty">Open a conversation to see where it works and what it changed.</div>
  const projectPath = environment?.projectPath ?? session.projectPath ?? null
  const folderName = typeof session.workspaceLabel === 'string' && session.workspaceLabel ? session.workspaceLabel : projectPath?.split(/[\\/]/).filter(Boolean).pop() ?? null
  const used = num(session.contextUsed)
  const size = num(session.contextSize)
  const percent = size > 0 ? Math.min(100, Math.round((used / size) * 100)) : null
  const split = sessionTokenSplit(session, usage)
  const changes = fileChanges(session)
  const outputs = changes.filter((file) => /^(added|create|created|new)$/i.test(file.change))
  const visibleOutputs = showAllOutputs ? outputs : outputs.slice(0, 5)
  const totalAdded = changes.reduce((sum, file) => sum + (file.added ?? 0), 0)
  const totalRemoved = changes.reduce((sum, file) => sum + (file.removed ?? 0), 0)
  const fileButtons = (file: FileChange) => <span className="rail-file-actions">
    {platform.editor && <button type="button" title="Open in editor" aria-label={`Open ${file.path} in editor`} onClick={() => onOpenFile(file.path)}><Code2 size={12} /></button>}
    {platform.editor && <button type="button" title="Reveal in File Explorer" aria-label={`Reveal ${file.path} in File Explorer`} onClick={() => onRevealFile(file.path)}><FolderOpen size={12} /></button>}
    <button type="button" title="Copy path" aria-label={`Copy ${file.path}`} onClick={() => onCopyPath(file.path)}><Copy size={12} /></button>
  </span>

  return <div className="session-rail">
    <Card id="environment" title="Environment" aside={runtimeFacts ? <HelpTip text={runtimeFacts} align="end" placement="bottom" /> : undefined}>
      <div className="rail-row"><Monitor size={13} aria-hidden="true" /><span className="rail-row-main">{environment?.host ?? 'This computer'}</span></div>
      {folderName && <div className="rail-row"><FolderOpen size={13} aria-hidden="true" /><span className="rail-row-main" title={projectPath ?? undefined}>{folderName}</span>{projectPath && platform.editor && <button type="button" className="rail-link" onClick={() => onOpenFolder(projectPath)}>Open</button>}</div>}
      {appliedModel && <div className="rail-row"><Bot size={13} aria-hidden="true" /><span className="rail-row-main" title="The model the coding agent reported using">{appliedModel}</span></div>}
      {environment?.gitRepo && environment.branch && <div className="rail-row"><GitBranch size={13} aria-hidden="true" /><span className="rail-row-main">{environment.branch}</span>{environment.detached && <span className="rail-tag">detached</span>}</div>}
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
      {outputs.length === 0 ? <p className="rail-note">Files this conversation creates appear here.</p> : <>
        <ul className="rail-files">{visibleOutputs.map((file) => <li key={file.key} className="rail-file"><FileText size={13} aria-hidden="true" /><span className="rail-file-name" title={file.path}>{file.name}</span>{fileButtons(file)}</li>)}</ul>
        {outputs.length > 5 && <button type="button" className="rail-link" onClick={() => setShowAllOutputs((value) => !value)}>{showAllOutputs ? 'Show less' : `Show ${outputs.length - 5} more`}</button>}
      </>}
    </Card>

    <Card id="changes" title="Changes" aside={changes.length > 0 ? <span className="rail-diffstat"><em>+{totalAdded}</em> <i>−{totalRemoved}</i></span> : undefined}>
      {changes.length === 0 ? <p className="rail-note">Files the coding agent edits appear here with their diff.</p>
        : <ul className="rail-files">{changes.map((file) => <li key={file.key} className="rail-file">
          <button type="button" className="rail-file-open" title={file.diff ? `View the diff for ${file.path}` : file.path} disabled={!file.diff} onClick={() => file.diff && onDiff(file.path, file.diff)}>
            <FileText size={13} aria-hidden="true" /><span className="rail-file-name">{file.name}</span>
          </button>
          {file.added !== null && <em className="rail-add">+{file.added}</em>}
          {file.removed !== null && <i className="rail-del">−{file.removed}</i>}
          {fileButtons(file)}
        </li>)}</ul>}
    </Card>
  </div>
}
