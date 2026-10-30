// Phase 1: Settings › General › Keyboard shortcuts. Press a new shortcut for an
// action; the daemon keeps only what differs from the defaults.
import { useState } from 'react'
import { RotateCcw, X } from 'lucide-react'
import { SettingsGroup } from './SettingsParts'
import { keysFor, normalizeBindings, shortcutConflict, shortcutFromEvent, shortcutProblem, SHORTCUT_ACTIONS, type ShortcutActionId, type ShortcutBindings } from './shortcuts'

export function KeybindingEditor({ bindings, disabled, onSave }: {
  bindings: ShortcutBindings
  disabled: boolean
  /** Stores the new overrides; resolves to an error sentence on failure. */
  onSave: (next: ShortcutBindings) => Promise<string | null | undefined | void>
}) {
  const [recording, setRecording] = useState<ShortcutActionId | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const save = async (next: ShortcutBindings) => {
    const failure = await onSave(normalizeBindings(next))
    if (failure) setProblem(failure)
  }
  const withValue = (id: ShortcutActionId, keys: string | null): ShortcutBindings => {
    const next = { ...bindings }
    const fallback = SHORTCUT_ACTIONS.find((action) => action.id === id)?.keys ?? null
    if (keys === fallback) delete next[id]; else next[id] = keys
    return next
  }
  const onKey = (id: ShortcutActionId, event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (recording !== id) return
    if (event.key === 'Tab') { setRecording(null); return }
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') { setRecording(null); setProblem(null); return }
    const keys = shortcutFromEvent(event.nativeEvent)
    if (!keys) return
    const refused = shortcutProblem(keys)
    if (refused) { setProblem(refused); return }
    const other = shortcutConflict(id, keys, bindings)
    if (other) { setProblem(`${keys} is already used for “${other.label}”.`); return }
    setProblem(null)
    setRecording(null)
    void save(withValue(id, keys))
  }
  return <SettingsGroup title="Keyboard shortcuts">
    <ul className="keybinding-list">
      {SHORTCUT_ACTIONS.map((action) => {
        const keys = keysFor(action.id, bindings)
        const changed = action.id in bindings
        const active = recording === action.id
        return <li key={action.id}>
          <span className="keybinding-label">{action.label}</span>
          <button type="button" className={`keybinding-keys${active ? ' recording' : ''}`} disabled={disabled} aria-label={active ? `Press a new shortcut for ${action.label}. Esc cancels.` : `Change the shortcut for ${action.label}: ${keys ?? 'none'}`} onClick={() => { setProblem(null); setRecording(active ? null : action.id) }} onBlur={() => { if (active) setRecording(null) }} onKeyDown={(event) => onKey(action.id, event)}>
            {active ? 'Press keys…' : keys ? <kbd>{keys}</kbd> : <span className="keybinding-none">None</span>}
          </button>
          <span className="keybinding-actions">
            {keys && <button type="button" className="composer-icon-button" disabled={disabled} aria-label={`Remove the shortcut for ${action.label}`} title="Remove" onClick={() => void save(withValue(action.id, null))}><X size={13} aria-hidden="true" /></button>}
            {changed && <button type="button" className="composer-icon-button" disabled={disabled} aria-label={`Reset the shortcut for ${action.label}`} title="Reset" onClick={() => { const next = { ...bindings }; delete next[action.id]; void save(next) }}><RotateCcw size={13} aria-hidden="true" /></button>}
          </span>
        </li>
      })}
    </ul>
    {problem && <p className="keybinding-problem" role="alert">{problem}</p>}
  </SettingsGroup>
}
