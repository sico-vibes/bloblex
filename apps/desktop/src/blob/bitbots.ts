// Theme style and user accent: the in-window mirror of the daemon's
// `appearance.style` / `appearance.accent` settings. The character renderer and
// the document theme read from here. The last values are cached so the first
// paint already matches (no flash of the wrong look).

import { useSyncExternalStore } from 'react'
import type { BlobMood } from './characterState'
import type { RobotHeadState } from '../vendor/robot-heads'
import { accentTokens, isThemeStyle, normalizeAccent, type ThemeStyle } from '../ui/appearance'

const STYLE_KEY = 'bitbots.style'
/** The pre-style key; read once for migration, never written. */
const LEGACY_KEY = 'bloblex.bitbots'
const ACCENT_KEY = 'bitbots.accent'

function readStyle(): ThemeStyle {
  try {
    const cached = localStorage.getItem(STYLE_KEY)
    if (isThemeStyle(cached)) return cached
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (legacy === '1') return 'bitbots'
    if (legacy === '0') return 'blobots'
  } catch { /* The cache only avoids a flash. */ }
  return 'bitbots'
}

function readAccent(): string {
  try { return normalizeAccent(localStorage.getItem(ACCENT_KEY)) } catch { return '' }
}

let style = readStyle()
let accent = readAccent()
let themeLoad: Promise<unknown> | null = null
const listeners = new Set<() => void>()

/** The theme's stylesheet and fonts are only fetched once Bitbots is the style. */
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

function applyAccent(root: HTMLElement) {
  if (accent) {
    const tokens = accentTokens(accent)
    root.style.setProperty('--user-accent', tokens.accent)
    root.style.setProperty('--user-accent-pressed', tokens.pressed)
    root.style.setProperty('--user-accent-soft', tokens.soft)
    root.style.setProperty('--user-accent-ink', tokens.ink)
    root.dataset.accent = 'custom'
    return
  }
  root.style.removeProperty('--user-accent')
  root.style.removeProperty('--user-accent-pressed')
  root.style.removeProperty('--user-accent-soft')
  root.style.removeProperty('--user-accent-ink')
  delete root.dataset.accent
}

function applyDocument() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.style = style
  if (style === 'bitbots') { root.dataset.bitbots = 'on'; void loadTheme() } else delete root.dataset.bitbots
  applyAccent(root)
}

applyDocument()

export function themeStyle(): ThemeStyle { return style }

export function setThemeStyle(next: ThemeStyle) {
  style = next
  try { localStorage.setItem(STYLE_KEY, next) } catch { /* The cache only avoids a flash. */ }
  applyDocument()
  for (const listener of listeners) listener()
}

/** True while Bitbots (the pixel-robot theme) is the current style. */
export function bitbotsEnabled() { return style === 'bitbots' }

export function setBitbotsEnabled(next: boolean) { setThemeStyle(next ? 'bitbots' : 'blobots') }

export function accentColor(): string { return accent }

export function setAccentColor(hex: string) {
  const next = normalizeAccent(hex)
  accent = next
  try { if (next) localStorage.setItem(ACCENT_KEY, next); else localStorage.removeItem(ACCENT_KEY) } catch { /* The cache only avoids a flash. */ }
  if (typeof document !== 'undefined') applyAccent(document.documentElement)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Re-renders when the style flips. */
export function useThemeStyle(): ThemeStyle {
  return useSyncExternalStore(subscribe, themeStyle, () => 'bitbots')
}

/** Re-renders when the mode flips. Always false outside the browser/desktop shell. */
export function useBitbots(): boolean {
  return useSyncExternalStore(subscribe, bitbotsEnabled, () => false)
}

/** Re-renders when the accent changes. */
export function useAccentColor(): string {
  return useSyncExternalStore(subscribe, accentColor, () => '')
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
