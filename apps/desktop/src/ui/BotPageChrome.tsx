import { useRef } from 'react'
import { Check, RotateCcw } from 'lucide-react'
import type { ChangedField } from './agentForm'
import { summarizeChanges } from './agentForm'
import './botPageChrome.css'

export function sectionDomId(id: string) { return `bot-section-${id}` }

/**
 * The bar at the foot of the editor. Edit mode shows it only while there is
 * something to save: how many things changed and which, with Discard and Save.
 * Create mode keeps it as the one place to press Create. A short "Saved" shows
 * after a save so the click is never silent.
 */
export function BotSaveBar({ mode, noun, dirty, saving, changes, invalidCount, saved, canSubmit, onSave, onDiscard }: {
  mode: 'create' | 'edit'
  noun: string
  dirty: boolean
  saving: boolean
  changes: readonly ChangedField[]
  invalidCount: number
  saved: boolean
  canSubmit: boolean
  onSave: () => void
  onDiscard: () => void
}) {
  const showBar = mode === 'create' || dirty || saved
  const savedRef = useRef(saved)
  savedRef.current = saved
  if (!showBar) return null
  const count = changes.length
  return <footer className="bot-savebar" role="region" aria-label="Save changes" data-state={saved && !dirty ? 'saved' : dirty ? 'dirty' : 'create'}>
    <div className="bot-savebar-copy" aria-live="polite">
      {saved && !dirty
        ? <span className="bot-savebar-saved"><Check size={14} aria-hidden="true" />Saved</span>
        : mode === 'create'
          ? <span>{invalidCount > 0 ? `${invalidCount} ${invalidCount === 1 ? 'thing needs' : 'things need'} attention before you can create this ${noun}.` : `Ready to create this ${noun}.`}</span>
          : <span><b>{count} {count === 1 ? 'change' : 'changes'}</b> <span className="bot-savebar-list">{summarizeChanges(changes)}</span>{invalidCount > 0 && <span className="bot-savebar-warn"> · {invalidCount} to fix</span>}</span>}
    </div>
    <div className="bot-savebar-actions">
      {mode === 'edit' && dirty && <button type="button" className="ghost-button small" onClick={onDiscard} disabled={saving}><RotateCcw size={13} aria-hidden="true" />Discard</button>}
      {(mode === 'create' || dirty) && <button type="button" className="primary-button small" onClick={onSave} disabled={saving || !canSubmit} aria-keyshortcuts="Control+S" aria-label={mode === 'create' ? `Create ${noun}` : 'Save changes'}>
        {saving ? 'Saving…' : mode === 'create' ? `Create ${noun}` : 'Save changes'}
      </button>}
    </div>
  </footer>
}
