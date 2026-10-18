// A small stale-while-revalidate store for the model catalog and capability
// reads (`runtime.models`, `runtime.capabilities`). Pickers read it
// synchronously, so switching models and efforts never shows a loader once the
// app has warmed it at boot; a background request keeps it current. Values are
// mirrored to localStorage so a cold start paints the last known lists at once.
// Only these two read-only methods are cached; nothing here sends or changes.

import { useEffect, useSyncExternalStore } from 'react'
import { rpc } from '../tauri'
import { parseModelCatalog, type CatalogModel } from '../executionContract'

export type CachedMethod = 'runtime.models' | 'runtime.capabilities'

type Entry = { value: unknown; at: number }

/** A value younger than this is served without a background check. */
export const CATALOG_FRESH_MS = 5 * 60_000
/** At most this many entries are mirrored to localStorage. */
const MAX_PERSISTED = 40
const STORAGE_KEY = 'bitbots.catalogCache.v1'

const entries = new Map<string, Entry>()
const inflight = new Map<string, Promise<unknown>>()
/** The last failure per key, shown only when there is no value to fall back on. */
const listeners = new Set<() => void>()
let version = 0

function keyOf(method: CachedMethod, params: Record<string, unknown>) {
  const sorted = Object.keys(params).sort().filter((name) => params[name] !== undefined && params[name] !== null).map((name) => [name, params[name]])
  return `${method}:${JSON.stringify(sorted)}`
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Record<string, Entry>
    for (const [key, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.at === 'number') entries.set(key, entry)
    }
  } catch { /* The mirror only avoids a cold first paint. */ }
}

function persist() {
  try {
    const newest = [...entries.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_PERSISTED)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(newest)))
  } catch { /* Quota or private mode: the in-memory cache still works. */ }
}

/** Suggested (fallback) or unvalidated catalogs are shown but always re-checked, like the daemon's 60 s rule. */
function provisional(value: unknown) {
  if (!value || typeof value !== 'object') return false
  const catalog = value as { fallback?: unknown; validated?: unknown }
  return catalog.fallback === true || catalog.validated === false
}

function isFresh(entry: Entry | undefined, now = Date.now()) {
  return !!entry && now - entry.at <= CATALOG_FRESH_MS && !provisional(entry.value)
}

function notify() {
  version += 1
  for (const listener of listeners) listener()
}

load()

/** The cached answer, fresh or stale, without a request. */
export function readCached<T = unknown>(method: CachedMethod, params: Record<string, unknown>): T | undefined {
  return entries.get(keyOf(method, params))?.value as T | undefined
}

/**
 * FIX39 item 12: the runtime's cached model list, parsed for a synchronous
 * display name. Null before the boot warm-up has an answer for this runtime, so
 * the caller can fall back to the saved model id.
 */
export function readCachedCatalogModels(runtimeId: string): CatalogModel[] | null {
  const value = readCached('runtime.models', { runtimeId })
  if (value === undefined) return null
  return parseModelCatalog(value)?.models ?? null
}

/** True when there is no answer, or it is older than the fresh window. */
export function isStale(method: CachedMethod, params: Record<string, unknown>, now = Date.now()) {
  return !isFresh(entries.get(keyOf(method, params)), now)
}

/**
 * Ask the daemon (once per key at a time) and cache the answer. `force` skips
 * the fresh-window shortcut. Errors reject but leave any cached value in place.
 */
export function fetchCached<T = unknown>(method: CachedMethod, params: Record<string, unknown>, options: { force?: boolean } = {}): Promise<T> {
  const key = keyOf(method, params)
  const entry = entries.get(key)
  if (!options.force && isFresh(entry)) return Promise.resolve(entry!.value as T)
  const running = inflight.get(key)
  if (running) return running as Promise<T>
  const request = rpc<T>(method, params).then((value) => {
    entries.set(key, { value, at: Date.now() })
    persist()
    notify()
    return value
  }).finally(() => { inflight.delete(key) })
  inflight.set(key, request)
  return request
}

/** Forget answers for one runtime (or all), so the next read asks again. Values stay until replaced. */
export function invalidateCatalog(runtimeId?: string) {
  let changed = false
  for (const [key, entry] of entries) {
    if (!runtimeId || key.includes(JSON.stringify(['runtimeId', runtimeId]))) { entries.set(key, { ...entry, at: 0 }); changed = true }
  }
  if (changed) { persist(); notify() }
}

/** Test hook: start from nothing. */
export function resetCatalogCacheForTests() {
  entries.clear(); inflight.clear(); version = 0
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
}

/**
 * FIX39 item 12 / P5 audit S7: re-render when the shared catalog cache changes,
 * so a model line that was first painted before the catalog arrived shows the
 * display name as soon as it does. The value itself is read synchronously.
 */
export function useCatalogVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Read a cached answer and keep it current. Returns the cached value at once
 * (or the `fallback` key's value, for example the runtime-wide catalog while a
 * conversation-specific one loads), then refreshes it in the background when it
 * is missing or stale. `revalidate` values force a background refresh when they
 * change (a new model, a workflows switch). `error` is set only when there is
 * nothing to show.
 */
export function useCachedRpc<T = unknown>(method: CachedMethod, params: Record<string, unknown> | null, options: { fallback?: Record<string, unknown>; revalidate?: readonly unknown[] } = {}): { value: T | undefined; error: unknown; loading: boolean } {
  useSyncExternalStore(subscribe, () => version, () => version)
  const key = params ? keyOf(method, params) : ''
  const exact = params ? readCached<T>(method, params) : undefined
  const fallback = !exact && options.fallback ? readCached<T>(method, options.fallback) : undefined
  const errorKey = `${key}#error`
  useEffect(() => {
    if (!params) return
    const stale = isStale(method, params)
    errors.delete(errorKey)
    if (!stale && !(options.revalidate?.length)) return
    void fetchCached(method, params, { force: !stale }).catch((reason) => {
      errors.set(errorKey, reason)
      notify()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...(options.revalidate ?? [])])
  const value = exact ?? fallback
  return { value, error: value === undefined ? errors.get(errorKey) : undefined, loading: value === undefined && !errors.has(errorKey) && !!params }
}

const errors = new Map<string, unknown>()

/**
 * Warm the catalog for every runtime at boot, two at a time, so the first
 * model or effort menu opens from cache. Failures are ignored here: the pickers
 * show their own state if a catalog is missing.
 */
export async function prefetchCatalogs(runtimeIds: readonly string[]) {
  const queue = [...runtimeIds]
  const worker = async () => {
    while (queue.length) {
      const runtimeId = queue.shift()!
      await fetchCached('runtime.models', { runtimeId }).catch(() => undefined)
      await fetchCached('runtime.capabilities', { runtimeId }).catch(() => undefined)
    }
  }
  await Promise.all([worker(), worker()])
}
