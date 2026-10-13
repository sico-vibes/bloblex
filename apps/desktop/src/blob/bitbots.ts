// Bitbots mode: one switch for the pixel-robot re-skin. The setting lives in
// the daemon (`experimental.bitbots`); this module is the in-window mirror
// that the character renderer and the document theme read from. The last
// value is cached so the first paint already matches (no flash of blobs).

import { useSyncExternalStore } from 'react'
import type { BlobMood } from './characterState'
import type { RobotHeadState } from '../vendor/robot-heads'

const CACHE_KEY = 'bloblex.bitbots'

function readCache(): boolean {
  try { return localStorage.getItem(CACHE_KEY) === '1' } catch { return false }
}

let enabled = readCache()
let themeLoad: Promise<unknown> | null = null
const listeners = new Set<() => void>()

/** The theme's stylesheet and fonts are only fetched once Bitbots is switched on. */
function loadTheme() {
  themeLoad ??= Promise.all([
    import('@fontsource/doto/latin-700.css'),
    import('@fontsource/doto/latin-900.css'),
    import('@fontsource/dm-mono/latin-400.css'),
    import('@fontsource/dm-mono/latin-500.css'),
    import('../ui/bitbots.css'),
  ]).catch(() => { themeLoad = null })
  return themeLoad
}

function applyDocument() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (enabled) { root.dataset.bitbots = 'on'; void loadTheme() } else delete root.dataset.bitbots
}

applyDocument()

export function bitbotsEnabled() { return enabled }

export function setBitbotsEnabled(next: boolean) {
  if (next === enabled) return
  enabled = next
  try { localStorage.setItem(CACHE_KEY, next ? '1' : '0') } catch { /* The cache only avoids a flash. */ }
  applyDocument()
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Re-renders when the mode flips. Always false outside the browser/desktop shell. */
export function useBitbots(): boolean {
  return useSyncExternalStore(subscribe, bitbotsEnabled, () => false)
}

// A robot has one face per state, so the many blob moods collapse onto the
// nine robot states. Anything unlisted rests as idle.
const STATE_FOR_MOOD: Record<BlobMood, RobotHeadState> = {
  idle: 'idle',
  online: 'idle',
  thinking: 'thinking',
  working: 'working',
  tool_activity: 'searching',
  file_activity: 'working',
  file_drop: 'listening',
  file_preparing: 'working',
  file_ready: 'happy',
  file_sending: 'working',
  file_error: 'error',
  permission: 'listening',
  success: 'happy',
  error: 'error',
  offline: 'sleeping',
  listening: 'listening',
  rate_limited: 'sleeping',
  sleeping: 'sleeping',
}

export function robotStateFor(mood: BlobMood): RobotHeadState {
  return STATE_FOR_MOOD[mood] ?? 'idle'
}
