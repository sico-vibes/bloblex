// UI preferences: density, seen hints and the onboarding tour step. The daemon
// settings are the source of truth; this module keeps an in-window mirror and a
// localStorage first-paint cache so the first paint already matches the last
// value. Values the daemon sends are validated here and ignored when invalid, so
// the mirror never holds something the daemon would refuse. Every storage access
// is guarded: a blocked Storage API only costs the flash-saving cache.

import { useCallback, useSyncExternalStore } from 'react'
import { rpc } from '../tauri'

export type Density = 'compact' | 'default' | 'roomy'

export interface TourState { version: number; done: boolean; step: number }

/** Bumped when the tour changes shape; a stored tour from an older run is ignored. */
export const TOUR_VERSION = 1

const DENSITY_KEY = 'bitbots.density'
const HINTS_KEY = 'bitbots.hints'
const TOUR_KEY = 'bitbots.tour'
/** Mirrors the daemon's cap, so the mirror and the daemon never disagree. */
const MAX_HINTS = 64
const HINT_ID = /^[a-z0-9._-]{1,48}$/
const DEFAULT_TOUR: TourState = { version: 0, done: false, step: 0 }

export function isDensity(value: unknown): value is Density {
  return value === 'compact' || value === 'default' || value === 'roomy'
}

function isHintId(value: unknown): value is string {
  return typeof value === 'string' && HINT_ID.test(value)
}

function normalizeTour(value: unknown): TourState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const version = record.version
  const done = record.done
  const step = record.step
  if (!Number.isInteger(version) || (version as number) < 0 || (version as number) > 999) return null
  if (typeof done !== 'boolean') return null
  if (!Number.isInteger(step) || (step as number) < 0 || (step as number) > 20) return null
  return { version: version as number, done, step: step as number }
}

function writeCache(key: string, value: unknown) {
  try { localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)) } catch { /* The cache only avoids a flash. */ }
}

function readDensity(): Density {
  try { const cached = localStorage.getItem(DENSITY_KEY); if (isDensity(cached)) return cached } catch { /* The cache only avoids a flash. */ }
  return 'default'
}

function readHints(): string[] {
  try {
    const cached = localStorage.getItem(HINTS_KEY)
    if (!cached) return []
    const parsed: unknown = JSON.parse(cached)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isHintId).slice(-MAX_HINTS)
  } catch { return [] }
}

function readTour(): TourState {
  try {
    const cached = localStorage.getItem(TOUR_KEY)
    if (cached) { const parsed = normalizeTour(JSON.parse(cached)); if (parsed) return parsed }
  } catch { /* Fall through to the default. */ }
  return { ...DEFAULT_TOUR }
}

let densityValue = readDensity()
let hints = readHints()
let tour = readTour()
const listeners = new Set<() => void>()

function notify() { for (const listener of listeners) listener() }
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Saves through the daemon; the cache already holds the value, so a failure is swallowed. */
function persist(key: string, value: unknown) {
  void rpc('settings.set', { key, value }).catch(() => undefined)
}

function sameTour(a: TourState, b: TourState) {
  return a.version === b.version && a.done === b.done && a.step === b.step
}

function applyDensityDocument() {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.density = densityValue
}
applyDensityDocument()

export function density(): Density { return densityValue }

export function setDensity(next: Density) {
  if (!isDensity(next) || next === densityValue) return
  densityValue = next
  writeCache(DENSITY_KEY, next)
  applyDensityDocument()
  notify()
  persist('appearance.density', next)
}

/** Applies a value the daemon sent. Invalid values are ignored and never echoed back. */
export function hydrateDensity(value: unknown) {
  if (!isDensity(value) || value === densityValue) return
  densityValue = value
  writeCache(DENSITY_KEY, value)
  applyDensityDocument()
  notify()
}

export function hintSeen(id: string): boolean {
  return isHintId(id) && hints.includes(id)
}

export function markHintSeen(id: string) {
  if (!isHintId(id) || hintSeen(id)) return
  const next = [...hints, id].slice(-MAX_HINTS)
  hints = next
  writeCache(HINTS_KEY, next)
  notify()
  persist('hints.seen', next)
}

export function resetHints() {
  if (hints.length === 0) return
  hints = []
  writeCache(HINTS_KEY, [])
  notify()
  persist('hints.seen', [])
}

/** Applies the daemon's list. Invalid entries are dropped; an empty list clears the mirror. */
export function hydrateHints(value: unknown) {
  if (!Array.isArray(value)) return
  const next = value.filter(isHintId).slice(-MAX_HINTS)
  if (next.length === hints.length && next.every((id, index) => hints[index] === id)) return
  hints = next
  writeCache(HINTS_KEY, next)
  notify()
}

export function tourState(): TourState { return tour }

export function setTourState(next: Partial<TourState>) {
  const merged = normalizeTour({ ...tour, ...next })
  if (!merged || sameTour(merged, tour)) return
  tour = merged
  writeCache(TOUR_KEY, merged)
  notify()
  persist('onboarding.tour', merged)
}

/** Applies a value the daemon sent. Invalid values are ignored. */
export function hydrateTour(value: unknown) {
  const parsed = normalizeTour(value)
  if (!parsed || sameTour(parsed, tour)) return
  tour = parsed
  writeCache(TOUR_KEY, parsed)
  notify()
}

/** Re-renders when the density changes. */
export function useDensity(): Density {
  return useSyncExternalStore(subscribe, density, () => 'default')
}

/** The hint's seen flag plus a marker that adds it and persists. */
export function useHintSeen(id: string): [seen: boolean, mark: () => void] {
  const seen = useSyncExternalStore(subscribe, () => hintSeen(id), () => false)
  const mark = useCallback(() => markHintSeen(id), [id])
  return [seen, mark]
}

/** Re-renders when the tour state changes. */
export function useTourState(): TourState {
  return useSyncExternalStore(subscribe, tourState, () => DEFAULT_TOUR)
}
