// Phase 1: the app's rebindable shortcuts and the send shortcut. The daemon stores
// `shortcuts.bindings` (only what differs from the defaults) and `composer.sendShortcut`.
// Dictation and the companion's global shortcut are registered natively and aren't here.
import { useEffect } from 'react'

export const SHORTCUT_ACTIONS = [
  { id: 'app.quickSwitcher', label: 'Open the quick switcher', keys: 'Ctrl+K' },
  { id: 'conversation.new', label: 'New conversation', keys: null },
  { id: 'conversation.togglePanel', label: 'Show or hide conversations', keys: null },
  { id: 'app.terminal', label: 'Show or hide the terminal', keys: 'Ctrl+`' },
  { id: 'app.askSeveral', label: 'Ask several bots', keys: null },
  { id: 'app.searchProject', label: 'Search this project', keys: 'Ctrl+Shift+F' },
  { id: 'app.settings', label: 'Open Settings', keys: null },
  { id: 'app.shortcutSheet', label: 'Show keyboard shortcuts', keys: 'Ctrl+/' },
] as const
export type ShortcutActionId = typeof SHORTCUT_ACTIONS[number]['id']
export type ShortcutBindings = Partial<Record<ShortcutActionId, string | null>>

const ACTION_IDS = new Set<string>(SHORTCUT_ACTIONS.map((action) => action.id))

/** Keeps only known actions with a string or null, from whatever the daemon stored. */
export function normalizeBindings(raw: unknown): ShortcutBindings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: ShortcutBindings = {}
  for (const [id, keys] of Object.entries(raw)) {
    if (ACTION_IDS.has(id) && (keys === null || (typeof keys === 'string' && keys))) out[id as ShortcutActionId] = keys as string | null
  }
  return out
}

/** The action's current shortcut, or null for none. */
export function keysFor(id: ShortcutActionId, bindings: ShortcutBindings): string | null {
  if (id in bindings) return bindings[id] ?? null
  return SHORTCUT_ACTIONS.find((action) => action.id === id)?.keys ?? null
}

type KeyEventLike = Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'code' | 'key'>

const CODE_NAMES: Record<string, string> = { Backquote: '`', Slash: '/', Backslash: '\\', Comma: ',', Period: '.', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Space: 'Space', Enter: 'Enter', Tab: 'Tab', Escape: 'Esc', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }

/** The main key's name, from its position so Shift doesn't change it. */
function keyName(event: KeyEventLike): string | null {
  const code = event.code ?? ''
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-2])$/.test(code)) return code
  if (CODE_NAMES[code]) return CODE_NAMES[code]
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return null
  return event.key?.length === 1 ? event.key.toUpperCase() : null
}

/** "Ctrl+Shift+K" for a key press, or null for a modifier on its own. ⌘ counts as Ctrl. */
export function shortcutFromEvent(event: KeyEventLike): string | null {
  const key = keyName(event)
  if (!key) return null
  return [event.ctrlKey || event.metaKey ? 'Ctrl' : null, event.altKey ? 'Alt' : null, event.shiftKey ? 'Shift' : null, key].filter(Boolean).join('+')
}

export function matchesShortcut(event: KeyEventLike, keys: string | null | undefined): boolean {
  return !!keys && shortcutFromEvent(event) === keys
}

/** Text editing and the browser's own keys, which a shortcut must not take over. */
const RESERVED = new Set(['Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Y', 'Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+F', 'Ctrl+P', 'Ctrl+R', 'Ctrl+W', 'Ctrl+Enter', 'Ctrl+Shift+Enter', 'Shift+Enter', 'Ctrl+E', 'Ctrl+Alt+B'])

/** Why these keys can't be a shortcut, or null. */
export function shortcutProblem(keys: string): string | null {
  if (RESERVED.has(keys)) return `${keys} is already used for typing or by Bitbots itself.`
  const hasModifier = keys.startsWith('Ctrl+') || keys.startsWith('Alt+')
  if (!hasModifier && !/(^|\+)F([1-9]|1[0-2])$/.test(keys)) return 'Include Ctrl or Alt, or use a function key.'
  return null
}

/** The other action already using these keys, if any. */
export function shortcutConflict(id: ShortcutActionId, keys: string, bindings: ShortcutBindings) {
  return SHORTCUT_ACTIONS.find((action) => action.id !== id && keysFor(action.id, bindings) === keys) ?? null
}

/** Runs the matching action. `handlers` may leave out an action that isn't available right now. */
export function useShortcutActions(enabled: boolean, bindings: ShortcutBindings, handlers: Partial<Record<ShortcutActionId, () => void>>) {
  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      for (const action of SHORTCUT_ACTIONS) {
        const run = handlers[action.id]
        if (run && matchesShortcut(event, keysFor(action.id, bindings))) { event.preventDefault(); run(); return }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [enabled, bindings, handlers])
}

export type SendShortcut = 'enter' | 'ctrl+enter' | 'shift+enter'
export const SEND_SHORTCUTS: ReadonlyArray<{ value: SendShortcut; label: string }> = [
  { value: 'enter', label: 'Enter' },
  { value: 'ctrl+enter', label: 'Ctrl+Enter' },
  { value: 'shift+enter', label: 'Shift+Enter' },
]

export function normalizeSendShortcut(value: unknown): SendShortcut {
  return value === 'ctrl+enter' || value === 'shift+enter' ? value : 'enter'
}

/**
 * What Enter does in the message box. "opposite" sends the other way while a bot is
 * working (steer or queue). `null` lets the box add a new line as usual.
 */
export function composerEnterAction(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey'> & { isComposing?: boolean }, shortcut: SendShortcut): 'send' | 'opposite' | null {
  if (event.key !== 'Enter' || event.isComposing) return null
  const ctrl = event.ctrlKey || event.metaKey
  if (shortcut === 'enter') return event.shiftKey ? null : ctrl ? 'opposite' : 'send'
  if (ctrl && event.shiftKey) return 'opposite'
  if (shortcut === 'ctrl+enter') return ctrl ? 'send' : null
  return event.shiftKey ? 'send' : null
}

/** The keys that send the other way, for tooltips and hints. */
export function oppositeKeys(shortcut: SendShortcut): string {
  return shortcut === 'enter' ? 'Ctrl+Enter' : 'Ctrl+Shift+Enter'
}

/** The send and new line rows of the shortcut sheet. */
export function sendRows(shortcut: SendShortcut): string[][] {
  const send = SEND_SHORTCUTS.find((item) => item.value === shortcut)?.label ?? 'Enter'
  return [[send, 'Send a prompt'], [shortcut === 'enter' ? 'Shift+Enter' : 'Enter', 'New line']]
}
