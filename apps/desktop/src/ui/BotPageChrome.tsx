import { useEffect, useRef, useState, type RefObject } from 'react'
import { Check, RotateCcw } from 'lucide-react'
import type { BotSection, ChangedField } from './agentForm'
import { summarizeChanges } from './agentForm'
import './botPageChrome.css'

export interface RailSection { id: string; label: string }

/** Rail entries, in page order. The editor's own sections come from agentForm's BotSection. */
export function railSections(mode: 'create' | 'edit'): RailSection[] {
  const base: RailSection[] = [
    { id: 'look', label: 'Look' },
    { id: 'profile', label: 'Profile' },
    { id: 'team', label: 'Team' },
    { id: 'model', label: 'Model' },
    { id: 'permissions', label: 'Permissions' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'details', label: 'Technical details' },
  ]
  return mode === 'edit' ? [...base, { id: 'conversations', label: 'Conversations' }, { id: 'manage', label: 'Manage' }] : base
}

export function sectionDomId(id: string) { return `bot-section-${id}` }

/** The id of the section currently nearest the top of the scroll area. */
function useSectionSpy(ids: readonly string[], root: RefObject<HTMLElement | null>): string {
  const [active, setActive] = useState(ids[0] ?? '')
  useEffect(() => {
    const container = root.current
    if (!container || typeof IntersectionObserver === 'undefined') return
    const visible = new Map<string, number>()
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = entry.target.id.replace('bot-section-', '')
        if (entry.isIntersecting) visible.set(id, entry.boundingClientRect.top)
        else visible.delete(id)
      }
      const top = [...visible.entries()].sort((a, b) => a[1] - b[1])[0]
      if (top) setActive(top[0])
    }, { root: container, rootMargin: '0px 0px -60% 0px', threshold: [0, 1] })
    for (const id of ids) {
      const element = document.getElementById(sectionDomId(id))
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [ids.join('|'), root])
  return active
}

/**
 * Left rail of the bot editor: one entry per section, a dot where something is
 * changed, the section in view highlighted. On narrow windows it becomes a
 * scrolling row of chips (see botPageChrome.css).
 */
export function BotRail({ sections, changes, scrollRoot }: { sections: readonly RailSection[]; changes: readonly ChangedField[]; scrollRoot: RefObject<HTMLElement | null> }) {
  const active = useSectionSpy(sections.map((item) => item.id), scrollRoot)
  const dirty = new Set<string>(changes.map((item) => item.section as BotSection))
  const go = (id: string) => {
    const element = document.getElementById(sectionDomId(id))
    if (!element) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    element.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
  }
  return <nav className="bot-rail" aria-label="Sections">
    {sections.map((item) => <button key={item.id} type="button" className={`bot-rail-item ${active === item.id ? 'on' : ''}`} aria-current={active === item.id ? 'location' : undefined} onClick={() => go(item.id)}>
      <span>{item.label}</span>
      {dirty.has(item.id) && <i className="bot-rail-dot" role="img" aria-label="has unsaved changes" />}
    </button>)}
  </nav>
}

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
        {saving ? 'Saving…' : mode === 'create' ? `Create ${noun}` : 'Save changes'}<kbd aria-hidden="true">Ctrl S</kbd>
      </button>}
    </div>
  </footer>
}
