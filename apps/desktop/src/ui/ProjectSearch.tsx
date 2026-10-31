// Phase 3: finding things in a project. `@` in the composer offers files by fuzzy name,
// and the search dialog looks through their contents. The daemon decides the folder from
// the conversation or project named here, and leaves out files that name a secret.
import { useEffect, useMemo, useRef, useState } from 'react'
import { CaseSensitive, Eye, FileText, LoaderCircle, Regex, Search, X } from 'lucide-react'
import { inDesktop, rpc } from '../tauri'
import { useDialogAccessibility } from './dialogFocus'
import { MediaDialog } from './MediaPreview'
import './projectSearch.css'

export type SearchTarget = { sessionId: string } | { projectId: string } | null
export type FileMatch = { path: string; name: string; score: number; matches: number[] }
export type ContentMatch = { path: string; line: number; preview: string }

const DEBOUNCE_MS = 200

/** The target as a stable string, so a new object with the same meaning doesn't search again. */
const targetKey = (target: SearchTarget) => target ? ('sessionId' in target ? `s:${target.sessionId}` : `p:${target.projectId}`) : ''

/** Files matching the text after `@`, newest answer only. Null query means no search is wanted. */
export function useFileMatches(target: SearchTarget, query: string | null): FileMatch[] {
  const [files, setFiles] = useState<FileMatch[]>([])
  const key = targetKey(target)
  useEffect(() => {
    if (!inDesktop || !key || query === null) { setFiles([]); return }
    let live = true
    const timer = window.setTimeout(() => {
      void rpc<{ files?: FileMatch[] }>('project.files.search', { ...target, query, limit: 8 })
        .then((reply) => { if (live) setFiles(Array.isArray(reply?.files) ? reply.files : []) })
        .catch(() => { if (live) setFiles([]) })
    }, DEBOUNCE_MS)
    return () => { live = false; window.clearTimeout(timer) }
    // `key` stands for `target`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, query])
  return files
}

/** The file's path, with the characters the query matched picked out. */
export function HighlightedPath({ path, matches }: { path: string; matches: readonly number[] }) {
  const set = new Set(matches)
  const parts: Array<{ text: string; hit: boolean }> = []
  for (let index = 0; index < path.length; index += 1) {
    const hit = set.has(index)
    const last = parts[parts.length - 1]
    if (last && last.hit === hit) last.text += path[index]
    else parts.push({ text: path[index]!, hit })
  }
  return <>{parts.map((part, index) => part.hit ? <b key={index}>{part.text}</b> : <span key={index}>{part.text}</span>)}</>
}

/** The file rows of the `@` picker. `firstIndex` is where they start in the picker's shared keyboard order. */
export function FileMentionOptions({ files, firstIndex, activeIndex, onPick, onHover }: { files: readonly FileMatch[]; firstIndex: number; activeIndex: number; onPick: (file: FileMatch) => void; onHover: (index: number) => void }) {
  if (!files.length) return null
  return <>
    <div className="mention-picker-heading">Files</div>
    {files.map((file, index) => {
      const position = firstIndex + index
      return <button key={file.path} type="button" role="option" aria-selected={position === activeIndex} title={file.path} className={`mention-option mention-file ${position === activeIndex ? 'active' : ''}`} onMouseDown={(event) => { event.preventDefault(); onPick(file) }} onMouseEnter={() => onHover(position)}>
        <FileText size={14} aria-hidden="true" />
        <span className="mention-file-path"><HighlightedPath path={file.path} matches={file.matches} /></span>
      </button>
    })}
  </>
}

/** Results grouped by file, keeping the order the search returned them in. */
export function groupByFile(results: readonly ContentMatch[]): Array<{ path: string; rows: ContentMatch[] }> {
  const groups = new Map<string, ContentMatch[]>()
  for (const result of results) groups.set(result.path, [...(groups.get(result.path) ?? []), result])
  return [...groups].map(([path, rows]) => ({ path, rows }))
}

export function ProjectSearchDialog({ target, canPreview, onClose, onMention }: { target: SearchTarget; canPreview: boolean; onClose: () => void; onMention: (reference: string) => void }) {
  const { ref, close } = useDialogAccessibility(onClose)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [searching, setSearching] = useState(false)
  const [answer, setAnswer] = useState<{ results: ContentMatch[]; truncated: boolean; reason: string | null; query: string } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const request = useRef(0)
  const key = targetKey(target)
  useEffect(() => {
    const text = query.trim()
    const mine = ++request.current
    if (!text || !key) { setAnswer(null); setSearching(false); setFailure(null); return }
    setSearching(true)
    const timer = window.setTimeout(() => {
      void rpc<{ results?: ContentMatch[]; truncated?: boolean; reason?: string | null }>('project.content.search', { ...target, query: text, caseSensitive, regex, limit: 200 })
        .then((reply) => { if (mine === request.current) { setAnswer({ results: Array.isArray(reply?.results) ? reply.results : [], truncated: reply?.truncated === true, reason: reply?.reason ?? null, query: text }); setFailure(null) } })
        .catch((reason) => { if (mine === request.current) { setAnswer(null); setFailure(reason instanceof Error && reason.message ? reason.message : 'The search could not run.') } })
        .finally(() => { if (mine === request.current) setSearching(false) })
    }, DEBOUNCE_MS * 2)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, regex, key])
  const groups = useMemo(() => groupByFile(answer?.results ?? []), [answer])
  const count = answer?.results.length ?? 0
  return <div className="sheet-backdrop diff-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
    <section ref={ref} className="project-search" role="dialog" aria-modal="true" aria-label="Search this project" tabIndex={-1}>
      <header className="project-search-head">
        <Search size={15} aria-hidden="true" />
        <input data-dialog-initial-focus="" value={query} maxLength={200} spellCheck={false} aria-label="Search for" placeholder={key ? 'Search this project' : 'This conversation has no project folder'} disabled={!key} onChange={(event) => setQuery(event.target.value)} />
        {searching && <LoaderCircle size={14} className="spinning" aria-label="Searching" />}
        <button type="button" className="project-search-toggle" aria-pressed={caseSensitive} title="Match case" aria-label="Match case" onClick={() => setCaseSensitive((value) => !value)}><CaseSensitive size={15} aria-hidden="true" /></button>
        <button type="button" className="project-search-toggle" aria-pressed={regex} title="Regular expression" aria-label="Regular expression" onClick={() => setRegex((value) => !value)}><Regex size={15} aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label="Close search" onClick={close}><X size={16} aria-hidden="true" /></button>
      </header>
      <div className="project-search-body" role="region" aria-label="Search results" tabIndex={0}>
        {failure ? <p className="project-search-note" role="alert">{failure}</p>
          : answer?.reason ? <p className="project-search-note" role="alert">{answer.reason}</p>
            : answer && !count ? <p className="project-search-note" role="status">Nothing found for "{answer.query}".</p>
              : !answer ? <p className="project-search-note">Search file contents. Pick a result to mention that line in your message.</p>
                : groups.map((group) => <section key={group.path} className="project-search-group" aria-label={group.path}>
                  <h3 title={group.path}><span>{group.path}</span>{canPreview && <button type="button" className="icon-button" aria-label={`Preview ${group.path}`} title="Preview" onClick={() => setPreview(group.path)}><Eye size={13} aria-hidden="true" /></button>}</h3>
                  <ul>{group.rows.map((row) => <li key={`${row.path}:${row.line}`}><button type="button" title={`Mention ${row.path}:${row.line}`} onClick={() => { onMention(`${row.path}:${row.line}`); close() }}><span className="project-search-line">{row.line}</span><code>{row.preview}</code></button></li>)}</ul>
                </section>)}
      </div>
      {answer && count > 0 && <footer className="project-search-foot" role="status">{count} {count === 1 ? 'result' : 'results'} in {groups.length} {groups.length === 1 ? 'file' : 'files'}{answer.truncated ? ', and more not shown' : ''}</footer>}
    </section>
    {preview && <MediaDialog path={preview} title={preview} onClose={() => setPreview(null)} />}
  </div>
}
