import { describe, expect, it } from 'vitest'
import { activitySummary, buildConversationItems, groupConversationActivity, type ActivityGroup } from './conversation'

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

describe('conversation timeline across a delegation', () => {
  it('follows the daemon sequence even when live messages arrive without timestamps, and puts a turn activity under its reply', () => {
    const result = buildConversationItems({
      id: 'lead', runtimeId: 'rt',
      messages: [
        { id: 'ask', role: 'user', sequence: 5, turnId: 't1', createdAt: '2026-10-10T16:00:20Z' },
        { id: 'notice', role: 'notice', sequence: 6, createdAt: '2026-10-10T16:00:28Z', meta: { kind: 'delegation' } },
        // Arrived through a live event, with no createdAt.
        { id: 'asked', role: 'assistant', sequence: 7, turnId: 't1' },
        { id: 'reply', role: 'user', sequence: 8, turnId: 't2', createdAt: '2026-10-10T16:00:34Z', meta: { kind: 'blob_reply' } },
        { id: 'answer', role: 'assistant', sequence: 9, turnId: 't2' },
      ],
      tools: [
        { id: 'r1', kind: 'reasoning', turnId: 't1', state: 'completed' },
        { id: 'list', kind: 'mcpToolCall', turnId: 't1', state: 'completed' },
        { id: 'send', kind: 'mcpToolCall', turnId: 't1', state: 'completed' },
      ],
    })
    expect(result.map((item) => item.id)).toEqual(['message:ask', 'message:notice', 'message:asked', 'tool:list', 'tool:send', 'message:reply', 'message:answer'])
  })

  it('shows a running turn activity after its prompt until the reply lands', () => {
    const result = buildConversationItems({
      id: 's', runtimeId: 'rt',
      messages: [{ id: 'ask', role: 'user', sequence: 1, turnId: 't1' }],
      tools: [{ id: 'cmd', kind: 'commandExecution', turnId: 't1', state: 'running' }],
    })
    expect(result.map((item) => item.id)).toEqual(['message:ask', 'tool:cmd'])
  })
})

describe('grouped conversation activity', () => {
  it('turns every run of activity into one line, keeping failed turns separate', () => {
    const grouped = groupConversationActivity([
      { kind: 'message', id: 'm1' },
      { kind: 'activity', id: 't1', activityKind: 'tool', activity: { state: 'completed', kind: 'commandExecution' } },
      { kind: 'activity', id: 'f1', activityKind: 'file', activity: { operation: 'edited' } },
      { kind: 'message', id: 'm2' },
      { kind: 'activity', id: 't2', activityKind: 'tool', activity: { state: 'completed', kind: 'mcpToolCall' } },
      { kind: 'activity', id: 'turn', activityKind: 'turn', activity: { state: 'failed' } },
    ])
    expect(grouped.map((item) => item.kind)).toEqual(['message', 'activity-group', 'message', 'activity-group', 'activity'])
    expect(grouped[1]).toMatchObject({ commands: 1, files: 1, tools: 0, failed: 0 })
    expect(activitySummary(grouped[1] as ActivityGroup)).toBe('Ran 1 command · edited 1 file')
    expect(activitySummary(grouped[3] as ActivityGroup)).toBe('Used 1 tool')
  })

  it('counts failures and exposes the running item title', () => {
    const grouped = groupConversationActivity([
      { kind: 'message', id: 'm1' },
      { kind: 'activity', id: 't1', activityKind: 'tool', activity: { state: 'failed', kind: 'commandExecution' } },
      { kind: 'activity', id: 't2', activityKind: 'tool', activity: { state: 'running', title: 'npm test', kind: 'commandExecution' } },
      { kind: 'message', id: 'm2' },
    ])
    expect(grouped[1]).toMatchObject({ failed: 1, commands: 2, runningTitle: 'npm test' })
  })
})
