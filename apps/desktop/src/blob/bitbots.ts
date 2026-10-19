// Theme style and user accent: the in-window mirror of the daemon's
// `appearance.style` / appearance settings. The character renderer and
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
const WALLPAPER_KEY = 'bitbots.wallpaper'
const GLASS_KEY = 'bitbots.glass'

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
let legacyFontLoad: Promise<unknown> | undefined
let customWallpaperUrl = ''
const listeners = new Set<() => void>()

function loadLegacyFonts() {
  if (legacyFontLoad) return legacyFontLoad
  legacyFontLoad = Promise.all([
    import('@fontsource/doto/latin-700.css'), import('@fontsource/doto/latin-900.css'),
    import('@fontsource/dm-mono/latin-400.css'), import('@fontsource/dm-mono/latin-500.css'),
  ]).catch(() => { legacyFontLoad = undefined })
  return legacyFontLoad
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
  if (style === 'legacy') root.dataset.bitbots = 'on'; else delete root.dataset.bitbots
  if (style === 'legacy') void loadLegacyFonts()
  root.dataset.wallpaper = readWallpaper()
  root.dataset.glass = readGlass()
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

/**
 * Re-reads the style another window saved (the dictation bubble and the
 * companion are separate windows that never see the main window's setting
 * events). Returns true when it changed.
 */
export function syncThemeStyleFromCache(): boolean {
  const cached = readStyle()
  if (cached === style) return false
  setThemeStyle(cached)
  return true
}

// Another window changed the look: follow it at once.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STYLE_KEY || event.key === null) syncThemeStyleFromCache()
  })
}

export function legacyPixelEnabled() { return style === 'legacy' }
/** @deprecated Use legacyPixelEnabled. */
export function bitbotsEnabled() { return style === 'legacy' }

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

/** Re-renders when the legacy pixel style flips.
 * @deprecated Use useLegacyPixel.
 */
export function useBitbots(): boolean {
  return useLegacyPixel()
}

export function useLegacyPixel(): boolean { return useSyncExternalStore(subscribe, legacyPixelEnabled, () => false) }

function readWallpaper(): string {
  try { const value = localStorage.getItem(WALLPAPER_KEY); return ['lake', 'dusk', 'bloom', 'sand', 'custom'].includes(value ?? '') ? value! : 'lake' } catch { return 'lake' }
}
function readGlass(): string {
  try { const value = localStorage.getItem(GLASS_KEY); return ['solid', 'balanced', 'clear'].includes(value ?? '') ? value! : 'solid' } catch { return 'solid' }
}
export function setWallpaper(value: 'lake' | 'dusk' | 'bloom' | 'sand' | 'custom') {
  try { localStorage.setItem(WALLPAPER_KEY, value) } catch { /* The cache only avoids a flash. */ }
  if (typeof document !== 'undefined') document.documentElement.dataset.wallpaper = value
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('bitbots-wallpaper-changed'))
  for (const listener of listeners) listener()
}
export function setCustomWallpaperUrl(url: string) { customWallpaperUrl = url; if (typeof window !== 'undefined') window.dispatchEvent(new Event('bitbots-wallpaper-changed')) }
export function getCustomWallpaperUrl() { return customWallpaperUrl }
export function setGlass(value: 'solid' | 'balanced' | 'clear') {
  try { localStorage.setItem(GLASS_KEY, value) } catch { /* The cache only avoids a flash. */ }
  if (typeof document !== 'undefined') document.documentElement.dataset.glass = value
  for (const listener of listeners) listener()
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
