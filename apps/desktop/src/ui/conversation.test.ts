import { describe, expect, it } from 'vitest'
import { buildConversationItems } from './conversation'

describe('conversation timeline', () => {
  it('keeps daemon messages, tools, and file changes in sequence order with stable IDs', () => {
    const result = buildConversationItems({
      id: 'session-a', runtimeId: 'runtime-a',
      messages: [{ id: 'message-1', role: 'user', sequence: 1 }, { id: 'message-2', role: 'assistant', sequence: 5 }],
      tools: [{ id: 'tool-1', sequence: 3, state: 'completed' }],
      files: [{ id: 'file-1', sequence: 4, path: 'src/app.ts' }],
    })
    expect(result.map((item) => item.id)).toEqual(['message:message-1', 'tool:tool-1', 'file:file-1', 'message:message-2'])
    expect(result[1]).toMatchObject({ kind: 'activity', activityKind: 'tool' })
    expect(result[2]?.activity?.path).toBe('src/app.ts')
  })

  it('uses ordered turns when messages are nested and retains failed turns', () => {
    const result = buildConversationItems({
      id: 'session-a', runtimeId: 'runtime-a',
      turns: [
        { id: 'turn-1', state: 'completed', sequence: 1, messages: [{ id: 'message-1', role: 'assistant', sequence: 2 }] },
        { id: 'turn-2', state: 'failed', sequence: 4 },
      ],
    })
    expect(result.map((item) => item.id)).toEqual(['message:message-1', 'turn-error:turn-2'])
  })

  it('does not compare event sequence numbers with epoch timestamps', () => {
    const result = buildConversationItems({
      id: 'session-a', runtimeId: 'runtime-a',
      messages: [
        { id: 'old', role: 'assistant', createdAt: '2026-09-30T10:00:00Z' },
        { id: 'new', role: 'assistant', sequence: 12 },
      ],
      tools: [{ id: 'tool', sequence: 11, state: 'completed' }],
    })
    expect(result.map((item) => item.id)).toEqual(['message:old', 'tool:tool', 'message:new'])
  })
})
