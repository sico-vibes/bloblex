// One source of truth for the companion's Focus mode (C7). When it is on, the
// completion peeks and their cue are suppressed so a person in a meeting is not
// interrupted; approvals and questions still show. The companion's settings view
// and the main Settings sheet both read and write through this module, so the two
// controls can never disagree.

import { emitNative } from '../transport/nativeBridge'
import { rpc } from '../tauri'

export const FOCUS_MODE_KEY = 'companion.focusMode'
/** Carries the boolean Focus-mode switch between windows. */
export const FOCUS_MODE_CHANGED_EVENT = 'bloblex-companion-focus-changed'

export const DEFAULT_FOCUS_MODE = false

let current = DEFAULT_FOCUS_MODE
const listeners = new Set<(enabled: boolean) => void>()

/** The value every control on this window agrees on. */
export function focusMode(): boolean {
  return current
}

/** Replace the shared value and tell every control on this window. */
export function applyFocusMode(next: boolean): boolean {
  const value = next === true
  if (value === current) return current
  current = value
  for (const listener of [...listeners]) listener(current)
  return current
}

export function subscribeFocusMode(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The Focus-mode setting out of a `settings.get` payload, normalized. */
export function focusModeFromSettings(source: unknown): boolean {
  const root = source && typeof source === 'object' ? source as Record<string, unknown> : {}
  const settings = root.settings && typeof root.settings === 'object' ? root.settings as Record<string, unknown> : root
  return settings[FOCUS_MODE_KEY] === true
}

/** Reset to the default; used when the saved settings cannot be read or in tests. */
export function resetFocusMode(): boolean {
  return applyFocusMode(DEFAULT_FOCUS_MODE)
}

/** Save the switch, update the store and tell the other window. */
export async function saveFocusMode(enabled: boolean): Promise<void> {
  await rpc('settings.set', { key: FOCUS_MODE_KEY, value: enabled })
  applyFocusMode(enabled)
  try { await emitNative(FOCUS_MODE_CHANGED_EVENT, enabled) } catch { /* The other window hydrates the saved value on its next connection. */ }
}
