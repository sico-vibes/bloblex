import { describe, expect, it } from 'vitest'
import { buildConversationItems, groupConversationActivity } from './conversation'

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

describe('grouped conversation activity', () => {
  it('groups only multiple activity items bounded by messages', () => {
    const items = [
      { kind: 'message', id: 'm1' },
      { kind: 'activity', id: 't1', activityKind: 'tool', activity: { state: 'completed' } },
      { kind: 'activity', id: 'f1', activityKind: 'file', activity: { operation: 'edited' } },
      { kind: 'message', id: 'm2' },
      { kind: 'activity', id: 't2', activityKind: 'tool', activity: { state: 'completed' } },
    ] as const
    const grouped = groupConversationActivity([...items])
    expect(grouped.map((item) => item.kind)).toEqual(['message', 'activity-group', 'message', 'activity'])
    expect(grouped[1]).toMatchObject({ commands: 1, files: 1, failed: 0 })
  })

  it('counts failures and exposes the running item title', () => {
    const grouped = groupConversationActivity([
      { kind: 'message', id: 'm1' },
      { kind: 'activity', id: 't1', activityKind: 'tool', activity: { state: 'failed' } },
      { kind: 'activity', id: 't2', activityKind: 'tool', activity: { state: 'running', title: 'npm test' } },
      { kind: 'message', id: 'm2' },
    ])
    expect(grouped[1]).toMatchObject({ failed: 1, runningTitle: 'npm test' })
  })

  it('groups a trailing live run after a message and exposes its running state', () => {
    const grouped = groupConversationActivity([
      { kind: 'message', id: 'user-message' },
      { kind: 'activity', id: 'tool-1', activityKind: 'tool', activity: { state: 'completed', title: 'Read package' } },
      { kind: 'activity', id: 'tool-2', activityKind: 'tool', activity: { state: 'running', title: 'npm test' } },
    ])
    expect(grouped).toHaveLength(2)
    expect(grouped[1]).toMatchObject({ kind: 'activity-group', commands: 2, runningTitle: 'npm test' })
  })
})
