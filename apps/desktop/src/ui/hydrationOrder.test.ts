import { describe, expect, it } from 'vitest'
import type { Session } from '../types'
import { hydrationOrder } from './teamSelectors'

const s = (id: string, agentId: string, updatedAt: string, extra: Partial<Session> = {}): Session => ({ id, agentId, runtimeId: 'rt', updatedAt, ...extra })

describe('background conversation loading order', () => {
  it('loads the selected bot first, newest first, and skips loaded or archived ones', () => {
    const sessions = [
      s('a-old', 'a', '2026-10-10T00:00:00Z'),
      s('b-new', 'b', '2026-10-16T00:00:00Z'),
      s('a-new', 'a', '2026-10-15T00:00:00Z'),
      s('a-loaded', 'a', '2026-10-17T00:00:00Z', { messages: [] }),
      s('a-archived', 'a', '2026-10-17T00:00:00Z', { archived: true }),
    ]
    expect(hydrationOrder(sessions, 'a').map((session) => session.id)).toEqual(['a-new', 'a-old', 'b-new'])
    expect(hydrationOrder(sessions, null).map((session) => session.id)).toEqual(['b-new', 'a-new', 'a-old'])
  })

  // Wave 13: a lazy snapshot's partial conversation still loads, and an open one goes first.
  it('loads partial conversations, the open one before everything else', () => {
    const sessions = [
      s('a-full', 'a', '2026-10-17T00:00:00Z', { messages: [] }),
      s('b-partial', 'b', '2026-10-12T00:00:00Z', { messages: [], partial: true }),
      s('a-partial', 'a', '2026-10-11T00:00:00Z', { messages: [], partial: true }),
    ]
    expect(hydrationOrder(sessions, 'a').map((session) => session.id)).toEqual(['a-partial', 'b-partial'])
    expect(hydrationOrder(sessions, 'a', ['b-partial']).map((session) => session.id)).toEqual(['b-partial', 'a-partial'])
  })
})
