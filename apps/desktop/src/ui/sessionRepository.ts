// The rail's view of the conversation's repository: what Git says is different from HEAD right now
// (staged, unstaged and untracked), read through `session.repository`. It is the repository's state,
// not a record of what this conversation did, so edits made through commands show up too and so do
// changes made by someone else. Nothing here writes to the repository (FIX45, 25 October 2026).
import { useCallback, useEffect, useRef, useState } from 'react'
import { rpc } from '../tauri'
import type { Session } from '../types'
import { parseUnifiedDiff } from './diffParser'
import { isDraftSession } from './teamSelectors'

export type RepositoryChange = 'added' | 'modified' | 'deleted' | 'renamed'
export type RepositoryFile = {
  /** Absolute path on this computer. */
  path: string
  /** Path relative to the repository root. */
  repositoryPath: string
  change: RepositoryChange
  addedLines: number | null
  removedLines: number | null
  diff: string | null
  binary: boolean
  truncated: boolean
}
export type RepositoryState = {
  projectPath: string | null
  repoRoot: string | null
  gitRepo: boolean
  branch: string | null
  detached: boolean
  files: RepositoryFile[]
  addedLines: number
  removedLines: number
  /** More files changed than the daemon lists. */
  truncated: boolean
  error: string | null
}

const CHANGES: readonly RepositoryChange[] = ['added', 'modified', 'deleted', 'renamed']
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
const text = (value: unknown) => typeof value === 'string' && value ? value : null

/** Accepts only a well-formed daemon reply; anything else is "unavailable", never a guess. */
export function normalizeRepository(raw: unknown): RepositoryState | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const files: RepositoryFile[] = []
  for (const entry of Array.isArray(value.files) ? value.files : []) {
    if (!entry || typeof entry !== 'object') continue
    const file = entry as Record<string, unknown>
    const path = text(file.path) ?? text(file.repositoryPath)
    if (!path) continue
    const change = CHANGES.includes(file.change as RepositoryChange) ? file.change as RepositoryChange : 'modified'
    files.push({ path, repositoryPath: text(file.repositoryPath) ?? path, change, addedLines: count(file.addedLines), removedLines: count(file.removedLines), diff: text(file.diff), binary: file.binary === true, truncated: file.truncated === true })
  }
  const added = count(value.addedLines) ?? files.reduce((sum, file) => sum + (file.addedLines ?? 0), 0)
  const removed = count(value.removedLines) ?? files.reduce((sum, file) => sum + (file.removedLines ?? 0), 0)
  return { projectPath: text(value.projectPath), repoRoot: text(value.repoRoot), gitRepo: value.gitRepo === true, branch: text(value.branch), detached: value.detached === true, files, addedLines: added, removedLines: removed, truncated: value.truncated === true, error: text(value.error) }
}

const POLL_BUSY_MS = 8_000
const POLL_IDLE_MS = 60_000
const REFRESH_DEBOUNCE_MS = 600
const MIN_GAP_MS = 1_500
// The last reading per conversation, so reopening one shows something at once. Readings carry whole
// diffs, so the cache is a small LRU bounded by entries and by size, never by time alone.
export const CACHE_MAX_ENTRIES = 8
export const CACHE_MAX_CHARS = 3_000_000
const cache = new Map<string, RepositoryState>()
const weight = (data: RepositoryState) => data.files.reduce((sum, file) => sum + 200 + (file.diff?.length ?? 0), 400)
const cacheGet = (id: string) => cache.get(id) ?? null
const cacheHas = (id: string) => cache.has(id)
function cacheSet(id: string, data: RepositoryState) {
  cache.delete(id)
  cache.set(id, data)
  let total = 0
  for (const entry of cache.values()) total += weight(entry)
  // Oldest first; the reading just stored always stays.
  for (const key of cache.keys()) {
    if (cache.size <= CACHE_MAX_ENTRIES && total <= CACHE_MAX_CHARS) break
    if (key === id) break
    total -= weight(cache.get(key)!)
    cache.delete(key)
  }
}
/** Test seam: forget every reading, or read how many are held. */
export const clearRepositoryCache = () => cache.clear()
export const repositoryCacheSize = () => cache.size

export type RepositoryResult = {
  data: RepositoryState | null
  /** First read for this conversation, nothing to show yet. */
  loading: boolean
  /** The latest read failed; `data` is the last good reading, if any. */
  failed: boolean
  refresh: () => void
}

/**
 * Reads `session.repository` for one conversation and keeps it fresh: when the conversation's activity
 * changes (`refreshKey`), when the window regains focus, and on a slow poll while it is visible (faster
 * while a turn is running). Replies for a conversation that is no longer open are dropped.
 */
export function useSessionRepository(session: Session | null, refreshKey: string, busy: boolean, active = true): RepositoryResult {
  const sessionId = session && !isDraftSession(session) ? session.id : null
  const [state, setState] = useState<{ id: string | null; data: RepositoryState | null; loading: boolean; failed: boolean }>(() => ({ id: sessionId, data: sessionId ? cacheGet(sessionId) ?? null : null, loading: !!sessionId && !cacheHas(sessionId), failed: false }))
  const fetchRef = useRef<() => void>(() => undefined)
  /** The same read, skipped when one just ran: for focus changes and the poll, which can arrive in bursts. */
  const softRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    fetchRef.current = () => undefined; softRef.current = () => undefined
    if (!sessionId) { setState({ id: null, data: null, loading: false, failed: false }); return }
    // A hidden rail reads nothing (and keeps its last reading); it reads again the moment it is shown.
    if (!active) return
    const cached = cacheGet(sessionId) ?? null
    setState({ id: sessionId, data: cached, loading: !cached, failed: false })
    const context = { cancelled: false, inFlight: false, again: false, last: 0 }
    const read = () => {
      if (context.cancelled) return
      if (context.inFlight) { context.again = true; return }
      context.inFlight = true
      context.last = Date.now()
      void rpc<unknown>('session.repository', { sessionId }).then((raw) => {
        if (context.cancelled) return
        const data = normalizeRepository(raw)
        if (data) cacheSet(sessionId, data)
        setState({ id: sessionId, data: data ?? cacheGet(sessionId) ?? null, loading: false, failed: !data })
      }).catch(() => {
        if (!context.cancelled) setState((current) => ({ id: sessionId, data: current.id === sessionId ? current.data : cacheGet(sessionId) ?? null, loading: false, failed: true }))
      }).finally(() => {
        context.inFlight = false
        if (context.again && !context.cancelled) { context.again = false; read() }
      })
    }
    fetchRef.current = read
    softRef.current = () => { if (Date.now() - context.last >= MIN_GAP_MS) read() }
    read()
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
    const onFocus = () => { if (visible()) softRef.current() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      context.cancelled = true
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [sessionId, active])

  // The conversation moved (a turn started or ended, a file or command changed): read again shortly.
  const seenKey = useRef(refreshKey)
  useEffect(() => {
    if (!sessionId || !active || seenKey.current === refreshKey) { seenKey.current = refreshKey; return }
    seenKey.current = refreshKey
    const timer = window.setTimeout(() => fetchRef.current(), REFRESH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [refreshKey, sessionId, active])

  // A bounded poll, only while the window is showing: edits made outside the conversation appear too.
  useEffect(() => {
    if (!sessionId || !active) return
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') softRef.current() }, busy ? POLL_BUSY_MS : POLL_IDLE_MS)
    return () => window.clearInterval(timer)
  }, [sessionId, busy, active])

  const refresh = useCallback(() => fetchRef.current(), [])
  // A reply for another conversation never shows here, even for the render before the effect resets it.
  const current = state.id === sessionId
  return { data: current ? state.data : sessionId ? cacheGet(sessionId) ?? null : null, loading: current ? state.loading : !!sessionId && !cacheHas(sessionId), failed: current && state.failed, refresh }
}

/** Changes whenever something that can touch files happens in the conversation. */
export function repositoryRefreshKey(session: Session | null): string {
  if (!session) return ''
  const turns = session.turns ?? []
  const lastTurn = turns[turns.length - 1]
  const tools = session.tools ?? []
  const lastTool = tools[tools.length - 1]
  const files = session.files ?? []
  return [session.state ?? '', turns.length, lastTurn?.id ?? '', lastTurn?.state ?? '', tools.length, lastTool?.id ?? '', lastTool?.state ?? '', files.length, files[files.length - 1]?.id ?? '', session.updatedAt ?? ''].join('|')
}

export type RailFile = {
  key: string
  /** Absolute where known. */
  path: string
  name: string
  /** Relative to the repository root, for display. */
  relative: string | null
  change: string
  added: number | null
  removed: number | null
  diff: string | null
  binary: boolean
  truncated: boolean
  source: 'repository' | 'conversation'
}

const windowsStyle = (path: string) => /^[A-Za-z]:/.test(path) || path.startsWith('\\\\') || path.includes('\\')
const isAbsolute = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('/')

/** A path in one comparable shape: forward slashes, no `.` or `..` parts, no trailing slash. */
function normalizePath(path: string) {
  const slashed = path.replace(/\\/g, '/')
  const unc = slashed.startsWith('//')
  const parts: string[] = []
  for (const part of slashed.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (parts.length && !/^[A-Za-z]:$/.test(parts[parts.length - 1])) parts.pop(); continue }
    parts.push(part)
  }
  return `${unc ? '//' : slashed.startsWith('/') ? '/' : ''}${parts.join('/')}`
}

/**
 * Whether two paths name the same file. A path the coding agent reported relative to the project
 * (`src/a.ts`) is resolved against `root` first, so it matches the absolute one Git reports
 * (`C:/repo/src/a.ts`). Windows-style paths ignore case; others do not.
 */
export function samePath(left: string, right: string, root?: string | null) {
  const resolve = (path: string) => normalizePath(root && !isAbsolute(path) ? `${root}/${path}` : path)
  const a = resolve(left)
  const b = resolve(right)
  return windowsStyle(a) || windowsStyle(b) || (!!root && windowsStyle(root)) ? a.toLowerCase() === b.toLowerCase() : a === b
}
export const isCreated = (change: string) => /^(added|create|created|new)$/i.test(change)

/** What the conversation's own provider events reported: one entry per path (its latest change), newest first. */
export function conversationFiles(session: Session | null): RailFile[] {
  const latest = new Map<string, RailFile>()
  for (const [index, file] of (session?.files ?? []).entries()) {
    const path = String(file.path ?? file.filePath ?? '')
    if (!path) continue
    const diff = typeof file.diff === 'string' ? file.diff : typeof file.patch === 'string' ? file.patch : null
    const parsed = diff ? parseUnifiedDiff(diff) : null
    const added = typeof file.addedLines === 'number' ? file.addedLines : typeof file.additions === 'number' ? file.additions : parsed?.additions ?? null
    const removed = typeof file.removedLines === 'number' ? file.removedLines : typeof file.deletions === 'number' ? file.deletions : parsed?.deletions ?? null
    latest.delete(path)
    latest.set(path, { key: String(file.id ?? `${path}:${index}`), path, name: path.split(/[\\/]/).pop() ?? path, relative: null, change: String(file.change ?? file.kind ?? 'modified'), added, removed, diff, binary: false, truncated: false, source: 'conversation' })
  }
  return [...latest.values()].reverse()
}

function repositoryRailFiles(repository: RepositoryState): RailFile[] {
  return repository.files.map((file) => ({ key: `repo:${file.repositoryPath}`, path: file.path, name: file.repositoryPath.split('/').pop() ?? file.path.split(/[\\/]/).pop() ?? file.path, relative: file.repositoryPath, change: file.change, added: file.addedLines, removed: file.removedLines, diff: file.diff, binary: file.binary, truncated: file.truncated, source: 'repository' as const }))
}

export type RailView = {
  /** Files Git reports as different from HEAD. */
  repository: RailFile[]
  /** Files the conversation reported that Git does not list now (committed, reverted, or no repository). */
  earlier: RailFile[]
  /** New files, from either source, for the Outputs card. */
  created: RailFile[]
  added: number
  removed: number
  /** Whether Git is the source of the list, so the card can say whose changes these are. */
  fromRepository: boolean
}

export function buildRailView(session: Session | null, repository: RepositoryState | null): RailView {
  const root = repository?.repoRoot ?? repository?.projectPath ?? session?.projectPath ?? null
  // The conversation may name a file relative to the project and Git by its absolute path: one file, one row.
  const history: RailFile[] = []
  for (const file of conversationFiles(session)) if (!history.some((seen) => samePath(seen.path, file.path, root))) history.push(file)
  const usable = !!repository && repository.gitRepo && !repository.error
  const repo = usable ? repositoryRailFiles(repository!) : []
  const inRepo = (file: RailFile) => repo.some((entry) => samePath(entry.path, file.path, root))
  const earlier = history.filter((file) => !inRepo(file))
  const created = [...repo.filter((file) => isCreated(file.change)), ...history.filter((file) => isCreated(file.change) && !inRepo(file))]
  const rows = usable ? repo : history
  const added = usable ? repository!.addedLines : rows.reduce((sum, file) => sum + (file.added ?? 0), 0)
  const removed = usable ? repository!.removedLines : rows.reduce((sum, file) => sum + (file.removed ?? 0), 0)
  return { repository: repo, earlier: usable ? earlier : history, created, added, removed, fromRepository: usable }
}

/** The message the Create PR dialog sends once the owner confirms. It is an ordinary request to the coding agent. */
export function pullRequestPrompt(repository: RepositoryState): string {
  const root = repository.repoRoot ?? repository.projectPath ?? 'this repository'
  const branch = repository.detached ? 'a detached HEAD (no branch)' : repository.branch ? `\`${repository.branch}\`` : 'an unknown branch'
  const size = `${repository.files.length}${repository.truncated ? '+' : ''} changed ${repository.files.length === 1 ? 'file' : 'files'}, +${repository.addedLines} −${repository.removedLines}`
  return [
    `Please open a pull request for the uncommitted changes in this repository.`,
    ``,
    `Repository: ${root}`,
    `Current branch: ${branch}`,
    `Changes: ${size}`,
    ``,
    `1. Start by inspecting the working tree (git status and git diff) and read what changed before you do anything else.`,
    `2. Leave unrelated work alone. Stage and commit only the changes that belong in this pull request, and tell me about any file you left out and why.`,
    `3. If the current branch is main, master or the repository's default branch, create a suitably named branch first. Otherwise keep using the current branch.`,
    `4. Commit with a clear message, push the branch and open the pull request with the GitHub CLI (gh) or the provider tooling installed on this computer. If a tool is missing or not signed in, stop and tell me what is needed instead of working around it.`,
    `5. Reply with the pull request link, or with exactly what failed.`,
  ].join('\n')
}
