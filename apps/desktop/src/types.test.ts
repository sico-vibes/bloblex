import { describe, expect, it } from 'vitest'
import { applyEvent, isPermissionReplyAllowed, type DaemonEvent, type Snapshot } from './types'

const base = (): Snapshot => ({
  sequence: 4,
  runtimes: [{ id: 'rt-a', provider: 'codex' }],
  sessions: [{
    id: 's-a', runtimeId: 'rt-a', state: 'working',
    messages: [{ id: 'm-a', role: 'assistant', content: 'Hello', turnId: 't-a' }],
    files: [{ id: 'f-a', path: 'src/a.ts' }],
    tools: [{ id: 'tool-a', state: 'running' }],
  }],
  permissions: [], usage: [], budgets: [],
})

const event = (type: string, sequence: number, payload: Record<string, unknown>): DaemonEvent => ({ v: 1, type, sequence, payload })

describe('daemon event reconciliation', () => {
  it('replaces the runtime roster when background discovery completes', () => {
    const next = applyEvent(base(), event('runtime.changed', 5, {
      runtimes: [{ id: 'rt-claude', provider: 'claude' }],
    }))
    expect(next.runtimes).toEqual([{ id: 'rt-claude', provider: 'claude' }])
  })

  it('appends message deltas by stable message ID and ignores duplicate sequences', () => {
    const first = applyEvent(base(), event('message.delta', 5, { sessionId: 's-a', messageId: 'm-a', role: 'assistant', delta: ' there' }))
    expect(first.sessions?.[0].messages?.[0].content).toBe('Hello there')
    const duplicate = applyEvent(first, event('message.delta', 5, { sessionId: 's-a', messageId: 'm-a', delta: ' there' }))
    expect(duplicate.sessions?.[0].messages?.[0].content).toBe('Hello there')
  })

  it('finalizes the streamed assistant bubble from daemon DTOs without invented IDs', () => {
    const delta = applyEvent(base(), event('message.delta', 6, { sessionId: 's-a', turnId: 't-a', role: 'assistant', delta: 'hello' }))
    const completed = applyEvent(delta, event('message.completed', 7, { sessionId: 's-a', turnId: 't-a', role: 'assistant', content: 'hello world' }))
    expect(completed.sessions?.[0].messages).toHaveLength(1)
    expect(completed.sessions?.[0].messages?.[0].content).toBe('hello world')
  })

  it('attaches provider failure detail to its turn without losing the failure class', () => {
    const initial = base()
    initial.sessions![0]!.turns = [{ id: 't-a', state: 'working' }]
    const failed = applyEvent(initial, event('turn.error', 5, {
      sessionId: 's-a', turnId: 't-a', failureClass: 'provider_error', detail: '429 rate limit exceeded; retry later',
    }))
    expect(failed.sessions?.[0].turns?.[0]).toMatchObject({
      id: 't-a', state: 'error', failureClass: 'provider_error', detail: '429 rate limit exceeded; retry later',
    })
  })

  it('normalizes the daemon policies wrapper before budget events', () => {
    const withPolicies = { ...base(), budgets: { policies: [] } }
    const next = applyEvent(withPolicies, event('budget.warning', 8, { budget: { id: 'b-a', remaining: 12 } }))
    expect(Array.isArray(next.budgets)).toBe(true)
    const rows = next.budgets as { remaining: number }[]
    expect(rows[0].remaining).toBe(12)
  })

  it('merges session changes without dropping previously hydrated activity', () => {
    const next = applyEvent(base(), event('session.changed', 5, { session: { id: 's-a', runtimeId: 'rt-a', title: 'Updated', state: 'idle' } }))
    expect(next.sessions?.[0]).toMatchObject({ title: 'Updated', state: 'idle' })
    expect(next.sessions?.[0].messages).toHaveLength(1)
    expect(next.sessions?.[0].files).toHaveLength(1)
    expect(next.sessions?.[0].tools).toHaveLength(1)
  })

  it('does not resurrect a session after a later session.changed event', () => {
    const deleted = applyEvent(base(), event('session.deleted', 5, { sessionId: 's-a' }))
    const late = applyEvent(deleted, event('session.changed', 6, { id: 's-a', runtimeId: 'rt-a', title: 'Late provider output', state: 'idle' }))
    expect(late.sessions).toEqual([])
    expect(late.deletedSessionIds).toContain('s-a')
  })

  it('upserts tool and file activity and records usage and budget events', () => {
    let next = applyEvent(base(), event('tool.changed', 5, { sessionId: 's-a', tool: { id: 'tool-a', state: 'completed' } }))
    next = applyEvent(next, event('file.changed', 6, { sessionId: 's-a', file: { id: 'f-b', path: 'src/b.ts', addedLines: 4 } }))
    next = applyEvent(next, event('usage.updated', 7, { sessionId: 's-a', usage: { id: 'u-a', inputTokens: 30, valuation: { basis: 'unknown', amountMinor: null } } }))
    next = applyEvent(next, event('budget.warning', 8, { id: 'budget-a', remaining: 12 }))
    expect(next.sessions?.[0].tools?.[0].state).toBe('completed')
    expect(next.sessions?.[0].files).toHaveLength(2)
    expect(next.usage?.[0].valuation).toEqual({ basis: 'unknown', amountMinor: null })
    expect((next.budgets as { remaining: number }[] | undefined)?.[0]?.remaining).toBe(12)
  })

  it('adds and resolves permissions that have no session reference', () => {
    let next = applyEvent(base(), event('permission.requested', 5, { permission: { id: 'p-a', choices: ['allow_once', 'deny'], status: 'pending' } }))
    expect(next.permissions).toHaveLength(1)
    expect(isPermissionReplyAllowed(next.permissions![0], 'allow_once')).toBe(true)
    expect(isPermissionReplyAllowed(next.permissions![0], 'allow_session')).toBe(false)
    next = applyEvent(next, event('permission.resolved', 6, { permissionId: 'p-a', choice: 'deny' }))
    expect(next.permissions).toHaveLength(0)
  })

  it('preserves the authoritative view when an event type is unknown', () => {
    const original = base()
    const next = applyEvent(original, event('provider.raw_payload', 5, { secret: 'must not be rendered' }))
    expect(next).toEqual({ ...original, sequence: 5 })
  })

  it('projects agent changes, keeps archived rows, and deduplicates their sequence', () => {
    const initial = { ...base(), agents: [{ id: 'agent-a', name: 'A', description: '', instructions: '', color: 'mint', runtimeId: 'rt-a', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: 't0', updatedAt: 't0' }] }
    const changed = applyEvent(initial, event('agent.changed', 5, { action: 'archived', agentId: 'agent-a', runtimeId: 'rt-a', updatedAt: 't1', archived: true, sortOrder: 0 }))
    expect(changed.agents?.[0]).toMatchObject({ id: 'agent-a', archived: true, updatedAt: 't1' })
    expect(applyEvent(changed, event('agent.changed', 5, { agentId: 'agent-a', archived: false })).agents).toEqual(changed.agents)
    const inserted = applyEvent(changed, event('agent.changed', 6, { action: 'created', agentId: 'agent-b', runtimeId: 'rt-a', updatedAt: 't2', archived: false, sortOrder: 1 }))
    expect(inserted.agents?.map((agent) => agent.id)).toEqual(['agent-a', 'agent-b'])
  })
})
