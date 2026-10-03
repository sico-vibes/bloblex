import { describe, expect, it } from 'vitest'
import { applyEvent, type Session } from '../types'
import { initialiseSeen, isUnread, markSeen, pruneSeen, unreadNeedsApproval } from './sessionSeen'

const session = (id: string, updatedAt: string, state = 'idle'): Session => ({ id, runtimeId: 'r', provider: 'codex', title: id, state, updatedAt } as Session)

describe('session seen state', () => {
  it('compares timestamps and marks sessions seen immutably', () => {
    const seen = { a: '2026-01-01T00:00:00Z' }
    expect(isUnread(session('a', '2026-01-02T00:00:00Z'), seen)).toBe(true)
    expect(isUnread(session('a', '2026-01-01T00:00:00Z'), seen)).toBe(false)
    expect(markSeen(seen, 'a', '2026-01-02T00:00:00Z')).toEqual({ a: '2026-01-02T00:00:00Z' })
    expect(seen.a).toBe('2026-01-01T00:00:00Z')
  })

  it('marks existing sessions seen on first run and prunes removed ids', () => {
    expect(initialiseSeen([session('a', '2026-01-01T00:00:00Z')], null)).toEqual({ a: '2026-01-01T00:00:00Z' })
    expect(pruneSeen({ a: 'x', old: 'y' }, [session('a', '2026-01-01T00:00:00Z')])).toEqual({ a: 'x' })
  })

  it('flags only unread approval sessions for attention colour', () => {
    const waiting = session('a', '2026-01-02T00:00:00Z', 'waiting_permission')
    expect(unreadNeedsApproval(waiting, { a: '2026-01-01T00:00:00Z' })).toBe(true)
    expect(unreadNeedsApproval(waiting, { a: '2026-01-02T00:00:00Z' })).toBe(false)
  })

  it('derives unread finish and approval states from persisted seen time and session.changed timestamps', () => {
    const opened = session('a', '2026-01-02T10:00:00.000Z', 'working')
    const seen = initialiseSeen([opened], { a: '2026-01-02T10:00:00.000Z' })
    const initial = { sequence: 4, sessions: [opened] }
    const completed = applyEvent(initial, {
      v: 1,
      type: 'session.changed',
      sequence: 5,
      payload: { session: { id: 'a', state: 'completed', updatedAt: '2026-01-02T10:00:00.001Z' } },
    })
    expect(isUnread(completed.sessions![0]!, seen)).toBe(true)
    const waiting = applyEvent(initial, {
      v: 1,
      type: 'session.changed',
      sequence: 5,
      payload: { session: { id: 'a', state: 'waiting_permission', updatedAt: '2026-01-02T10:00:00.002Z' } },
    })
    expect(unreadNeedsApproval(waiting.sessions![0]!, seen)).toBe(true)
  })
})
