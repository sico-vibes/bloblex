import { describe, expect, it } from 'vitest'
import type { Session } from '../types'
import { conversationsToLoad, hydrationOrder } from './teamSelectors'

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

  // 2026-11-01: opening is what loads a conversation. The prefetch is bounded by
  // recency so it cannot slide into loading the whole list in the background.
  it('loads the open conversation, and only the newest few behind it', () => {
    const sessions = [
      s('open', 'a', '2026-10-01T00:00:00Z', { messages: [], partial: true }),
      s('a-new', 'a', '2026-10-17T00:00:00Z', { messages: [], partial: true }),
      s('a-next', 'a', '2026-10-16T00:00:00Z', { messages: [], partial: true }),
      s('a-third', 'a', '2026-10-15T00:00:00Z', { messages: [], partial: true }),
      s('b-new', 'b', '2026-10-18T00:00:00Z', { messages: [], partial: true }),
      s('a-loaded', 'a', '2026-10-05T00:00:00Z', { messages: [] }),
    ]
    const planned = conversationsToLoad(sessions, 'a', ['open'], { prefetch: 2 })
    expect(planned.open.map((session) => session.id)).toEqual(['open'])
    expect(planned.ahead.map((session) => session.id)).toEqual(['a-new', 'a-next'])
    // The companion loads only what it shows, and no bot selected means no prefetch.
    expect(conversationsToLoad(sessions, 'a', ['open'], { companion: true }).ahead).toEqual([])
    expect(conversationsToLoad(sessions, null, ['open']).ahead).toEqual([])
    expect(conversationsToLoad(sessions, 'a', [], { prefetch: 0 }).ahead).toEqual([])
  })
})
