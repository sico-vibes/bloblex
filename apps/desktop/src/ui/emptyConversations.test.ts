import { describe, expect, it } from 'vitest'
import type { Session } from '../types'
import { withoutStaleContextNotices } from './conversation'
import { isEmptyConversation } from './teamSelectors'

const notice = (id: string) => ({ id, role: 'notice', content: 'Started a fresh session.', meta: { kind: 'context_reset' } })
const msg = (id: string, role: 'user' | 'assistant') => ({ id, role, content: id })

describe('fresh-session notices', () => {
  it('drops notices before anything was said and collapses repeats', () => {
    const messages = [notice('n0'), notice('n1'), msg('u1', 'user'), msg('a1', 'assistant'), notice('n2'), notice('n3'), notice('n4'), msg('u2', 'user')]
    expect(withoutStaleContextNotices(messages).map((m) => m.id)).toEqual(['u1', 'a1', 'n2', 'u2'])
  })
})

describe('empty conversations', () => {
  const base = (extra: Partial<Session>): Session => ({ id: 's', runtimeId: 'rt', agentId: 'a', ...extra })
  it('counts only loaded conversations with no user or bot message', () => {
    expect(isEmptyConversation(base({ messages: [] }))).toBe(true)
    expect(isEmptyConversation(base({ messages: [notice('n') as never] }))).toBe(true)
    expect(isEmptyConversation(base({ messages: [msg('u', 'user') as never] }))).toBe(false)
    expect(isEmptyConversation(base({}))).toBe(false)
    expect(isEmptyConversation(base({ messages: [], state: 'working' }))).toBe(false)
    expect(isEmptyConversation(base({ messages: [], link: { kind: 'side' } as never }))).toBe(false)
  })
})
