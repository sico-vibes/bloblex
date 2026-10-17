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
})
