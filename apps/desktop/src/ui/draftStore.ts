// Unsent message text, kept per conversation and per bot's new-chat draft, so switching bots or
// conversations, closing the app or opening the companion never loses what was typed. One small,
// versioned localStorage record shared by the main window and the companion (FIX45, 25 October 2026).
//
// - Scope: the key is the conversation id, or `draft:<agentId>` for a bot with no conversation yet.
// - Only text is kept. Attached images (their native paths are transient), reply quotes, #references
//   and command chips are never written.
// - A draft expires two hours after it was last edited, by the device clock.
// - Bounded storage: at most MAX_DRAFTS entries, MAX_PERSISTED_CHARS each and MAX_TOTAL_CHARS in all,
//   oldest dropped first. The live text is never cut: a longer draft stays whole in the box for this
//   run and is simply not backed up for a restart.
// - A sent message is "held" until the daemon accepts it: gone from the box at once, but still
//   restorable (after a refusal, or after a reload) until it is accepted. Each hold has its own id,
//   so an older send's answer never clears a newer one.
import { useCallback, useSyncExternalStore } from 'react'

export const DRAFT_STORAGE_KEY = 'bitbots.drafts.v1'
export const DRAFT_TTL_MS = 2 * 60 * 60 * 1000
export const MAX_DRAFTS = 40
export const MAX_PERSISTED_CHARS = 100_000
export const MAX_TOTAL_CHARS = 1_000_000
const MAX_KEY_CHARS = 200
const WRITE_DELAY_MS = 250

type Held = { id: string; text: string }
type Entry = { text: string; held?: Held[]; at: number }
let holdCounter = 0
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

let entries = new Map<string, Entry>()
let loaded = false
let storageOverride: StorageLike | null | undefined
let clock: () => number = () => Date.now()
let writeTimer: ReturnType<typeof setTimeout> | null = null
let expiryTimer: ReturnType<typeof setTimeout> | null = null
let listening = false
const listeners = new Set<() => void>()
const focused = new Map<string, number>()
let persistBroken = false

function storage(): StorageLike | null {
  if (storageOverride !== undefined) return storageOverride
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

const validKey = (key: unknown): key is string => typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_CHARS
const heldText = (entry: Entry) => (entry.held ?? []).map((item) => item.text).join('\n\n')
const expired = (entry: Entry) => clock() - entry.at > DRAFT_TTL_MS || entry.at - clock() > DRAFT_TTL_MS

/** Reads the stored record defensively: anything malformed, expired or oversized is dropped, never thrown. */
export function parseDrafts(raw: string | null): Map<string, Entry> {
  const out = new Map<string, Entry>()
  if (!raw) return out
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return out }
  if (!parsed || typeof parsed !== 'object' || (parsed as { v?: unknown }).v !== 1) return out
  const drafts = (parsed as { drafts?: unknown }).drafts
  if (!drafts || typeof drafts !== 'object' || Array.isArray(drafts)) return out
  for (const [key, value] of Object.entries(drafts as Record<string, unknown>)) {
    if (!validKey(key) || !value || typeof value !== 'object') continue
    const { t, h, at } = value as { t?: unknown; h?: unknown; at?: unknown }
    if (typeof t !== 'string' || t.length > MAX_PERSISTED_CHARS || typeof at !== 'number' || !Number.isFinite(at)) continue
    const held: Held[] = []
    if (typeof h === 'string' && h) held.push({ id: 'stored', text: h })
    else if (Array.isArray(h)) for (const item of h) if (item && typeof item === 'object' && typeof (item as Held).id === 'string' && typeof (item as Held).text === 'string' && (item as Held).text && (item as Held).text.length <= MAX_PERSISTED_CHARS) held.push({ id: (item as Held).id, text: (item as Held).text })
    const entry: Entry = { text: t, at, ...(held.length ? { held } : {}) }
    if (expired(entry)) continue
    out.set(key, entry)
    if (out.size >= MAX_DRAFTS * 2) break
  }
  return out
}

function prune(map: Map<string, Entry>) {
  for (const [key, entry] of map) if (expired(entry)) map.delete(key)
  if (map.size > MAX_DRAFTS) {
    const keep = [...map.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_DRAFTS)
    map.clear()
    for (const [key, entry] of keep) map.set(key, entry)
  }
}

function load() {
  if (loaded) return
  loaded = true
  try { entries = parseDrafts(storage()?.getItem(DRAFT_STORAGE_KEY) ?? null) } catch { entries = new Map() }
  // A held message with an empty box is a send that never finished: bring it back.
  for (const entry of entries.values()) if (!entry.text && entry.held?.length) { entry.text = heldText(entry); delete entry.held }
  prune(entries)
  listen()
  scheduleExpiry()
}

function notify() { for (const listener of [...listeners]) listener() }

function scheduleExpiry() {
  if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null }
  let next = Infinity
  for (const entry of entries.values()) if (entry.text || entry.held) next = Math.min(next, entry.at + DRAFT_TTL_MS)
  if (!Number.isFinite(next)) return
  expiryTimer = setTimeout(() => { expiryTimer = null; prune(entries); persist(); notify(); scheduleExpiry() }, Math.min(2_000_000_000, Math.max(1_000, next - clock() + 50)))
}

function serialise(map: Map<string, Entry>) {
  const drafts: Record<string, { t: string; h?: Held[]; at: number }> = {}
  let total = 0
  // Newest first, so when the budget runs out it is the oldest drafts that are not backed up.
  for (const [key, entry] of [...map.entries()].sort((a, b) => b[1].at - a[1].at)) {
    const held = (entry.held ?? []).filter((item) => item.text.length <= MAX_PERSISTED_CHARS)
    const size = entry.text.length + held.reduce((sum, item) => sum + item.text.length, 0)
    if (entry.text.length > MAX_PERSISTED_CHARS || total + size > MAX_TOTAL_CHARS) continue
    total += size
    drafts[key] = { t: entry.text, ...(held.length ? { h: held } : {}), at: entry.at }
  }
  return JSON.stringify({ v: 1, drafts })
}

/** Writes now, merging with what another window stored so neither window drops the other's drafts. */
function persist() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null }
  const target = storage()
  if (!target) return
  try {
    const stored = parseDrafts(target.getItem(DRAFT_STORAGE_KEY))
    for (const [key, theirs] of stored) {
      const mine = entries.get(key)
      if (!mine || (theirs.at > mine.at && !focused.has(key))) entries.set(key, theirs)
    }
    prune(entries)
    target.setItem(DRAFT_STORAGE_KEY, serialise(entries))
    persistBroken = false
  } catch { persistBroken = true /* quota or blocked storage: the drafts live on in memory for this session */ }
}

function queueWrite() {
  if (writeTimer) return
  writeTimer = setTimeout(persist, WRITE_DELAY_MS)
}

function listen() {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('storage', (event) => {
    if (event.key !== DRAFT_STORAGE_KEY && event.key !== null) return
    adoptStored()
  })
  const flush = () => { if (writeTimer) persist() }
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush() })
}

/** Takes newer drafts written by the other window. The conversation being typed in right now is left alone. */
export function adoptStored() {
  load()
  let incoming: Map<string, Entry>
  try { incoming = parseDrafts(storage()?.getItem(DRAFT_STORAGE_KEY) ?? null) } catch { return }
  let changed = false
  for (const [key, theirs] of incoming) {
    const mine = entries.get(key)
    if (mine && mine.at >= theirs.at) continue
    if (focused.has(key) && mine?.text) continue
    entries.set(key, theirs)
    changed = true
  }
  if (changed) { prune(entries); scheduleExpiry(); notify() }
}

/** The text saved for a conversation, or '' when none, expired or the key is empty. */
export function getDraft(key: string | null | undefined): string {
  if (!validKey(key)) return ''
  load()
  const entry = entries.get(key)
  return entry && !expired(entry) ? entry.text : ''
}

function touch(key: string, update: (entry: Entry) => void) {
  load()
  const entry = entries.get(key) ?? { text: '', at: clock() }
  update(entry)
  entry.at = clock()
  entries.set(key, entry)
  prune(entries)
  scheduleExpiry()
  queueWrite()
  notify()
}

/** Saves the text for a conversation. Empty text clears it (and leaves a marker so the other window clears too). */
export function setDraft(key: string | null | undefined, text: string) {
  if (!validKey(key)) return
  load()
  if (text === getDraft(key)) return
  touch(key, (entry) => { entry.text = text })
}

export function clearDraft(key: string | null | undefined) {
  if (!validKey(key)) return
  load()
  if (!entries.has(key)) return
  touch(key, (entry) => { entry.text = ''; delete entry.held })
}

const withoutHold = (entry: Entry, id: string | null | undefined) => { const rest = (entry.held ?? []).filter((item) => item.id !== id); if (rest.length) entry.held = rest; else delete entry.held }

/** A message is on its way: it leaves the box but stays recoverable until the daemon accepts it. */
export function holdDraft(key: string | null | undefined, text: string): string | null {
  if (!validKey(key)) return null
  const id = text.trim() ? `${clock()}-${++holdCounter}` : null
  touch(key, (entry) => { entry.text = ''; if (id) entry.held = [...(entry.held ?? []), { id, text }] })
  return id
}

/** The daemon accepted that message: its held copy is gone. Any newer hold in the same box stays. */
export function releaseDraft(key: string | null | undefined, id: string | null | undefined) {
  if (!validKey(key) || !id) return
  load()
  const entry = entries.get(key)
  if (!entry?.held?.some((item) => item.id === id)) return
  touch(key, (target) => withoutHold(target, id))
}

/** The daemon refused the message: put it back unless something new was typed meanwhile. Returns whether it came back. */
export function restoreDraft(key: string | null | undefined, id: string | null | undefined): boolean {
  if (!validKey(key) || !id) return false
  load()
  const entry = entries.get(key)
  const held = entry?.held?.find((item) => item.id === id)
  if (!entry || !held) return false
  const empty = !entry.text.trim()
  touch(key, (target) => { if (empty) target.text = held.text; withoutHold(target, id) })
  return empty
}

/** Marks a conversation's box as being typed in, so the other window's newer copy does not replace it. */
export function setDraftFocus(key: string | null | undefined, on: boolean) {
  if (!validKey(key)) return
  if (on) focused.set(key, clock()); else focused.delete(key)
}

export function subscribeDrafts(listener: () => void) {
  load()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Whether the last write failed (blocked or full storage). The drafts still work for this run. */
export const draftsPersistFailed = () => persistBroken

/** The saved text for a conversation as React state. The setter is bound to the key it was made for. */
export function useDraft(key: string | null | undefined): [string, (next: string | ((current: string) => string)) => void] {
  const text = useSyncExternalStore(subscribeDrafts, () => getDraft(key), () => '')
  const set = useCallback((next: string | ((current: string) => string)) => {
    setDraft(key, typeof next === 'function' ? next(getDraft(key)) : next)
  }, [key])
  return [text, set]
}

/** Test seam: a fresh store over the given storage and clock. */
export function resetDraftStoreForTests(options: { storage?: StorageLike | null; now?: () => number } = {}) {
  if (writeTimer) clearTimeout(writeTimer)
  if (expiryTimer) clearTimeout(expiryTimer)
  writeTimer = null; expiryTimer = null
  entries = new Map(); loaded = false; persistBroken = false
  focused.clear()
  storageOverride = options.storage
  clock = options.now ?? (() => Date.now())
}

/** Test seam: write pending changes now. */
export const flushDraftsForTests = persist
