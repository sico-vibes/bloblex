import { describe, expect, it } from 'vitest'
import { detectFinished, nextPeek, peekText, PEEK_WINDOW_MS } from './companionPeek'

describe('detectFinished', () => {
  const cases: Array<{ name: string; prev: Array<{ id: string; state: string }>; next: Array<{ id: string; state: string }>; focused: string | null; expected: string[] }> = [
    { name: 'working to idle', prev: [{ id: 'a', state: 'working' }], next: [{ id: 'a', state: 'idle' }], focused: null, expected: ['a'] },
    { name: 'starting to completed', prev: [{ id: 'a', state: 'starting' }], next: [{ id: 'a', state: 'completed' }], focused: null, expected: ['a'] },
    { name: 'never reports the focused bot', prev: [{ id: 'a', state: 'working' }], next: [{ id: 'a', state: 'idle' }], focused: 'a', expected: [] },
    { name: 'ignores a failed turn', prev: [{ id: 'a', state: 'working' }], next: [{ id: 'a', state: 'error' }], focused: null, expected: [] },
    { name: 'ignores a bot that was already idle', prev: [{ id: 'a', state: 'idle' }], next: [{ id: 'a', state: 'idle' }], focused: null, expected: [] },
    { name: 'ignores waiting for permission', prev: [{ id: 'a', state: 'working' }], next: [{ id: 'a', state: 'waiting_permission' }], focused: null, expected: [] },
    { name: 'ignores a new bot with no previous state', prev: [], next: [{ id: 'a', state: 'idle' }], focused: null, expected: [] },
    { name: 'reports several in next order', prev: [{ id: 'a', state: 'working' }, { id: 'b', state: 'starting' }], next: [{ id: 'a', state: 'completed' }, { id: 'b', state: 'idle' }], focused: null, expected: ['a', 'b'] },
    { name: 'state compare is case-insensitive', prev: [{ id: 'a', state: 'Working' }], next: [{ id: 'a', state: 'Completed' }], focused: null, expected: ['a'] },
  ]
  for (const item of cases) {
    it(item.name, () => {
      expect(detectFinished(item.prev, item.next, item.focused)).toEqual(item.expected)
    })
  }
})

describe('nextPeek', () => {
  it('returns null while nothing has finished', () => {
    expect(nextPeek(null, [], 1000)).toBeNull()
    expect(nextPeek({ ids: ['a'], at: 1000 }, [], 5000)).toEqual({ ids: ['a'], at: 1000 })
  })

  it('opens a new window when the previous one has closed', () => {
    expect(nextPeek({ ids: ['a'], at: 0 }, ['b'], PEEK_WINDOW_MS)).toEqual({ ids: ['b'], at: PEEK_WINDOW_MS })
  })

  it('folds later finishes into the window that is still open, without duplicates', () => {
    const first = nextPeek(null, ['a'], 0)!
    expect(first).toEqual({ ids: ['a'], at: 0 })
    expect(nextPeek(first, ['b', 'a'], 3_000)).toEqual({ ids: ['a', 'b'], at: 0 })
    expect(nextPeek(first, ['a'], 9_999)).toEqual({ ids: ['a'], at: 0 })
  })
})

describe('peekText', () => {
  it('names one bot and counts several', () => {
    expect(peekText([], 'bots')).toBe('')
    expect(peekText(['Claude'], 'bots')).toBe('Claude finished.')
    expect(peekText(['Claude', 'Codex'], 'bots')).toBe('2 bots finished.')
    expect(peekText(['Claude', 'Codex', 'Ops'], 'blobs')).toBe('3 blobs finished.')
  })
})
