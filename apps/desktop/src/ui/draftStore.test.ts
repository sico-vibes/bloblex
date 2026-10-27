import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DRAFT_STORAGE_KEY, DRAFT_TTL_MS, MAX_DRAFTS, MAX_PERSISTED_CHARS, adoptStored, clearDraft, draftsPersistFailed, flushDraftsForTests, getDraft, holdDraft, parseDrafts, releaseDraft, resetDraftStoreForTests, restoreDraft, setDraft, setDraftFocus, subscribeDrafts } from './draftStore'

class MemoryStorage {
  data = new Map<string, string>()
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, value) }
}

let now = 1_000_000
let storage: MemoryStorage
const boot = (existing: MemoryStorage = storage) => resetDraftStoreForTests({ storage: existing, now: () => now })
beforeEach(() => { vi.useFakeTimers(); now = 1_000_000; storage = new MemoryStorage(); boot() })
afterEach(() => { vi.useRealTimers(); resetDraftStoreForTests() })

describe('draft store', () => {
  it('keeps each conversation and each bot\'s new chat apart, and restores them after a reload', () => {
    setDraft('session-a', 'first thought')
    setDraft('session-b', 'second thought')
    setDraft('draft:agent-1', 'a new chat for bot one')
    expect(getDraft('session-a')).toBe('first thought')
    expect(getDraft('session-b')).toBe('second thought')
    expect(getDraft('draft:agent-1')).toBe('a new chat for bot one')
    expect(getDraft('draft:agent-2')).toBe('')
    flushDraftsForTests()
    boot() // the app was closed and opened again: same storage, new memory
    expect(getDraft('session-a')).toBe('first thought')
    expect(getDraft('session-b')).toBe('second thought')
    expect(getDraft('draft:agent-1')).toBe('a new chat for bot one')
  })

  it('writes after a short pause and on flush, as one versioned record', () => {
    setDraft('s', 'abc')
    expect(storage.getItem(DRAFT_STORAGE_KEY)).toBeNull()
    vi.advanceTimersByTime(300)
    expect(JSON.parse(storage.getItem(DRAFT_STORAGE_KEY)!)).toEqual({ v: 1, drafts: { s: { t: 'abc', at: now } } })
  })

  it('expires a draft two hours after the last edit, by the device clock', () => {
    setDraft('s', 'old words')
    flushDraftsForTests()
    now += DRAFT_TTL_MS - 1_000
    expect(getDraft('s')).toBe('old words')
    boot()
    expect(getDraft('s')).toBe('old words')
    now += 2_000
    expect(getDraft('s')).toBe('')
    boot()
    expect(getDraft('s')).toBe('')
    // Editing again restarts the two hours.
    setDraft('s', 'fresh'); now += DRAFT_TTL_MS - 1_000
    expect(getDraft('s')).toBe('fresh')
  })

  it('tells subscribers when a draft expires without any edit', () => {
    setDraft('s', 'soon gone')
    const seen = vi.fn()
    subscribeDrafts(seen)
    now += DRAFT_TTL_MS + 100
    vi.advanceTimersByTime(DRAFT_TTL_MS + 1_000)
    expect(seen).toHaveBeenCalled()
    expect(getDraft('s')).toBe('')
  })

  it('clears a draft and leaves a marker so the other window clears too', () => {
    setDraft('s', 'text'); flushDraftsForTests()
    now += 10
    clearDraft('s'); flushDraftsForTests()
    expect(getDraft('s')).toBe('')
    expect(JSON.parse(storage.getItem(DRAFT_STORAGE_KEY)!).drafts.s).toMatchObject({ t: '' })
    boot()
    expect(getDraft('s')).toBe('')
  })

  it('survives corrupted, wrong-version and malformed storage without throwing', () => {
    for (const bad of ['{not json', 'null', '[]', '"x"', JSON.stringify({ v: 2, drafts: { s: { t: 'x', at: now } } }), JSON.stringify({ v: 1, drafts: 'oops' }), JSON.stringify({ v: 1, drafts: { s: { t: 5, at: now }, u: { t: 'x' }, w: { t: 'x', at: 'later' }, '': { t: 'x', at: now } } })]) {
      storage.setItem(DRAFT_STORAGE_KEY, bad)
      boot()
      expect(getDraft('s')).toBe('')
      expect(() => setDraft('s', 'works')).not.toThrow()
      expect(getDraft('s')).toBe('works')
    }
    expect(parseDrafts(JSON.stringify({ v: 1, drafts: { good: { t: 'kept', at: now }, bad: { t: 1, at: now } } })).get('good')?.text).toBe('kept')
  })

  it('keeps working in memory when storage is unavailable, blocked or full', () => {
    resetDraftStoreForTests({ storage: null, now: () => now })
    setDraft('s', 'in memory'); flushDraftsForTests()
    expect(getDraft('s')).toBe('in memory')
    const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('quota') } }
    resetDraftStoreForTests({ storage: throwing, now: () => now })
    expect(getDraft('s')).toBe('')
    setDraft('s', 'still here')
    expect(() => flushDraftsForTests()).not.toThrow()
    expect(getDraft('s')).toBe('still here')
    expect(draftsPersistFailed()).toBe(true)
  })

  it('bounds the backup but never cuts what is in the box, and drops the oldest drafts first', () => {
    const big = 'x'.repeat(MAX_PERSISTED_CHARS + 500)
    setDraft('long', big)
    expect(getDraft('long')).toBe(big) // the live text is whole
    flushDraftsForTests()
    expect(JSON.parse(storage.getItem(DRAFT_STORAGE_KEY)!).drafts.long).toBeUndefined() // too large to back up, so not backed up (never half of it)
    for (let index = 0; index < MAX_DRAFTS + 10; index += 1) { now += 1; setDraft(`s-${index}`, `text ${index}`) }
    flushDraftsForTests()
    const stored = JSON.parse(storage.getItem(DRAFT_STORAGE_KEY)!).drafts as Record<string, unknown>
    expect(Object.keys(stored).length).toBeLessThanOrEqual(MAX_DRAFTS)
    expect(getDraft(`s-${MAX_DRAFTS + 9}`)).toBe(`text ${MAX_DRAFTS + 9}`)
    expect(getDraft('s-0')).toBe('')
    setDraft('k'.repeat(500), 'too long a key')
    expect(getDraft('k'.repeat(500))).toBe('')
  })

  it('holds a sent message until it is accepted, and gives it back when it is refused or the app restarts', () => {
    setDraft('s', 'please do this')
    const first = holdDraft('s', 'please do this')
    expect(getDraft('s')).toBe('')
    flushDraftsForTests()
    // Refused: it comes back, unless something new was typed meanwhile.
    expect(restoreDraft('s', first)).toBe(true)
    expect(getDraft('s')).toBe('please do this')
    const second = holdDraft('s', 'please do this')
    setDraft('s', 'something new')
    expect(restoreDraft('s', second)).toBe(false)
    expect(getDraft('s')).toBe('something new')
    // Accepted: nothing to restore, also after a restart.
    clearDraft('s')
    const sent = holdDraft('s', 'sent for real'); flushDraftsForTests()
    releaseDraft('s', sent); flushDraftsForTests()
    boot()
    expect(getDraft('s')).toBe('')
    // The app closed while the daemon had not answered: the message is back in the box.
    holdDraft('s', 'in flight'); flushDraftsForTests()
    boot()
    expect(getDraft('s')).toBe('in flight')
  })

  it('lets an older send\'s answer touch only its own hold, never a newer one in the same box', () => {
    const older = holdDraft('s', 'first message')
    const newer = holdDraft('s', 'second message')
    expect(older).not.toBe(newer)
    releaseDraft('s', older) // the first message is accepted late
    flushDraftsForTests()
    expect(JSON.parse(storage.getItem(DRAFT_STORAGE_KEY)!).drafts.s.h).toEqual([{ id: newer, text: 'second message' }])
    // A stale or unknown id does nothing, and the newer hold still comes back when it is refused.
    releaseDraft('s', older); releaseDraft('s', null); releaseDraft('s', 'nope')
    expect(restoreDraft('s', older)).toBe(false)
    expect(restoreDraft('s', newer)).toBe(true)
    expect(getDraft('s')).toBe('second message')
  })

  it('takes the other window\'s newer draft but never replaces the box being typed in', () => {
    setDraft('s', 'mine'); flushDraftsForTests()
    const other = { v: 1, drafts: { s: { t: 'theirs', at: now + 5 }, t: { t: 'only theirs', at: now + 5 } } }
    setDraftFocus('s', true)
    storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(other))
    adoptStored()
    expect(getDraft('s')).toBe('mine')
    expect(getDraft('t')).toBe('only theirs')
    setDraftFocus('s', false)
    adoptStored()
    expect(getDraft('s')).toBe('theirs')
    // An older copy never wins.
    storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ v: 1, drafts: { s: { t: 'stale', at: now - 50 } } }))
    adoptStored()
    expect(getDraft('s')).toBe('theirs')
  })

  it('does not drop the other window\'s drafts when it writes', () => {
    setDraft('mine', 'a'); flushDraftsForTests()
    storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ v: 1, drafts: { mine: { t: 'a', at: now }, theirs: { t: 'b', at: now } } }))
    now += 5
    setDraft('mine', 'a2'); flushDraftsForTests()
    expect(Object.keys(JSON.parse(storage.getItem(DRAFT_STORAGE_KEY)!).drafts).sort()).toEqual(['mine', 'theirs'])
  })
})
