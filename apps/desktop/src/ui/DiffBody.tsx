// Phase 3: one file's diff, unified or side by side. With `onAddComment`, each line
// of code can take a comment for the bot; the comments are shown under their line.
import { useMemo, useState, type ReactNode } from 'react'
import { MessageSquarePlus, X } from 'lucide-react'
import { parseUnifiedDiff, sideBySideRows, type DiffLine } from './diffParser'
import './diffBody.css'

export type DiffMode = 'unified' | 'split'
const MODE_KEY = 'bitbots.diff.mode'

function readMode(): DiffMode {
  try { return localStorage.getItem(MODE_KEY) === 'split' ? 'split' : 'unified' } catch { return 'unified' }
}

/** The owner's choice of view, remembered on this computer. */
export function useDiffMode(): [DiffMode, (mode: DiffMode) => void] {
  const [mode, setMode] = useState<DiffMode>(readMode)
  return [mode, (next) => { setMode(next); try { localStorage.setItem(MODE_KEY, next) } catch { /* preference only */ } }]
}

export function DiffModeSwitch({ mode, onChange }: { mode: DiffMode; onChange: (mode: DiffMode) => void }) {
  return <div className="diff-mode" role="group" aria-label="Diff layout">
    <button type="button" aria-pressed={mode === 'unified'} onClick={() => onChange('unified')}>Unified</button>
    <button type="button" aria-pressed={mode === 'split'} onClick={() => onChange('split')}>Side by side</button>
  </div>
}

/** `removed` means `line` counts in the old file. Old and new numbers overlap, so the number alone can't place it. */
export type LineComment = { id: string; path: string; line: number; removed: boolean; quote: string; text: string }

type CommentProps = {
  path?: string
  comments?: readonly LineComment[]
  onAddComment?: (line: number, removed: boolean, quote: string, text: string) => void
  onRemoveComment?: (id: string) => void
}

/** The line a comment on this diff line refers to: the new file's number, or the old one for a removal. */
const lineNumber = (line: DiffLine) => line.newNumber ?? line.oldNumber
const isRemoved = (line: DiffLine) => line.newNumber === null
const sameLine = (comment: LineComment, line: DiffLine) => comment.line === lineNumber(line) && comment.removed === isRemoved(line)
const codeOf = (line: DiffLine) => line.text.slice(1)

function CommentComposer({ line, onSave, onCancel }: { line: number; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState('')
  const save = () => { if (text.trim()) onSave(text.trim()) }
  return <div className="diff-comment-composer">
    <textarea autoFocus rows={2} value={text} aria-label={`Comment on line ${line}`} placeholder="What should the bot change here?" onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save() }
    }} />
    <div className="diff-comment-actions">
      <button type="button" className="ghost-button small" onClick={onCancel}>Cancel</button>
      <button type="button" className="secondary-button small" disabled={!text.trim()} onClick={save}>Add comment</button>
    </div>
  </div>
}

function CommentList({ comments, onRemove }: { comments: readonly LineComment[]; onRemove?: (id: string) => void }) {
  return <>{comments.map((comment) => <div key={comment.id} className="diff-comment">
    <p>{comment.text}</p>
    {onRemove && <button type="button" className="icon-button" aria-label={`Remove the comment on line ${comment.line}`} onClick={() => onRemove(comment.id)}><X size={12} aria-hidden="true" /></button>}
  </div>)}</>
}

export function DiffBody({ content, mode, path, comments = [], onAddComment, onRemoveComment }: { content: string; mode: DiffMode } & CommentProps) {
  const parsed = useMemo(() => parseUnifiedDiff(content), [content])
  const rows = useMemo(() => mode === 'split' ? sideBySideRows(parsed.lines) : [], [mode, parsed])
  const [drafting, setDrafting] = useState<string | null>(null)
  if (parsed.empty) return <p className="diff-empty">No diff content was reported.</p>
  if (parsed.binary) return <p className="diff-empty">Binary file change. Text lines are unavailable.</p>
  const commentButton = (line: DiffLine, key: string): ReactNode => onAddComment && lineNumber(line) !== null
    ? <button type="button" className="diff-comment-add" aria-label={`Comment on line ${lineNumber(line)}`} title="Comment for the bot" onClick={() => setDrafting(key)}><MessageSquarePlus size={12} aria-hidden="true" /></button>
    : null
  /** Comments and the open comment box belonging to these lines, shown below them. */
  const below = (lines: Array<DiffLine | null>, key: string): ReactNode => {
    const mine = comments.filter((comment) => comment.path === path && lines.some((line) => line && sameLine(comment, line)))
    const target = lines.find((line) => line && drafting === `${key}:${lineNumber(line)}:${isRemoved(line)}`)
    if (!mine.length && !target) return null
    return <div className="diff-comments">
      <CommentList comments={mine} onRemove={onRemoveComment} />
      {target && <CommentComposer line={lineNumber(target) as number} onCancel={() => setDrafting(null)} onSave={(text) => { onAddComment?.(lineNumber(target) as number, isRemoved(target), codeOf(target), text); setDrafting(null) }} />}
    </div>
  }
  if (mode === 'split') {
    const cell = (line: DiffLine | null, side: 'left' | 'right', key: string) => {
      const number = line ? (side === 'left' ? line.oldNumber : line.newNumber) : null
      return <div className={`diff-split-cell ${line ? line.kind : 'blank'}`}>
        <span className="diff-number">{number ?? ''}</span>
        <code>{line ? codeOf(line) : ''}</code>
        {line && commentButton(line, `${key}:${lineNumber(line)}:${isRemoved(line)}`)}
      </div>
    }
    return <div className="diff-split" role="table" aria-label={path ? `Side by side diff for ${path}` : 'Side by side diff'}>
      {rows.map((row, index) => {
        if (row.kind !== 'pair') return <div key={index} className={`diff-line ${row.kind}`}><code>{row.text}</code></div>
        const key = String(index)
        return <div key={index} className="diff-split-group">
          <div className="diff-split-row" role="row">{cell(row.left, 'left', key)}{cell(row.right, 'right', key)}</div>
          {below(row.left === row.right ? [row.right] : [row.left, row.right], key)}
        </div>
      })}
    </div>
  }
  return <pre className={onAddComment ? 'diff-commentable' : undefined}>{parsed.lines.map((line, index) => {
    const key = String(index)
    const coded = line.kind === 'added' || line.kind === 'removed' || line.kind === 'context'
    return <span key={`${index}-${line.text}`} className="diff-unified-group">
      <span className={`diff-line ${line.kind}`}>
        {coded && <span className="diff-number">{line.oldNumber ?? ''}</span>}
        {coded && <span className="diff-number">{line.newNumber ?? ''}</span>}
        <code>{line.text}</code>
        {coded && commentButton(line, `${key}:${lineNumber(line)}:${isRemoved(line)}`)}
      </span>
      {coded && below([line], key)}
    </span>
  })}</pre>
}

/** The message a set of comments becomes. */
export function commentsMessage(comments: readonly LineComment[]): string {
  const lines = comments.map((comment) => {
    const quote = comment.quote.trim().slice(0, 120)
    const place = comment.removed ? `${comment.path}, removed line ${comment.line}` : `${comment.path}:${comment.line}`
    return `- \`${place}\`${quote ? ` (\`${quote.replace(/`/g, "'")}\`)` : ''}: ${comment.text}`
  })
  return `Comments on your changes:\n\n${lines.join('\n')}`
}
