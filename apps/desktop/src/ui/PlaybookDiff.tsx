// Shows what a playbook change does, line by line, with unchanged stretches
// folded. Used by the proposal card and Settings › Manager.
import { useEffect, useState } from 'react'
import { rpc } from '../tauri'
import { foldDiff, lineDiff } from './lineDiff'
import './managerPage.css'

export function PlaybookDiff({ before, after, label = 'Changes to the playbook' }: { before: string; after: string; label?: string }) {
  const rows = foldDiff(lineDiff(before, after))
  const changed = rows.some((row) => row.kind === 'add' || row.kind === 'del')
  if (!changed) return <p className="playbook-diff-none">No changes.</p>
  return <div className="playbook-diff" role="region" aria-label={label}>
    {rows.map((row, index) => row.kind === 'fold'
      ? <div key={index} className="playbook-diff-fold">{row.count} unchanged line{row.count === 1 ? '' : 's'}</div>
      : <div key={index} className={`playbook-diff-line ${row.kind}`}>
        <span aria-hidden="true">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}</span>
        <span className="sr-only">{row.kind === 'add' ? 'Added: ' : row.kind === 'del' ? 'Removed: ' : ''}</span>
        <code>{row.text || ' '}</code>
      </div>)}
  </div>
}

/** The proposal card's view: the proposed text against the current playbook, once it loads. */
export function ProposedPlaybook({ text }: { text: string }) {
  const [current, setCurrent] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void rpc<{ playbook?: { text?: string } }>('manager.playbook.get')
      .then((result) => { if (alive) setCurrent(typeof result?.playbook?.text === 'string' ? result.playbook.text : null) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [])
  if (current === null) return <pre className="proposal-preview">{text}</pre>
  return <PlaybookDiff before={current} after={text} />
}
