import { describe, expect, it } from 'vitest'
import type { Agent } from '../types'
import { createParams, draftFromAgent, isAgentDirty, updateParams } from './agentForm'
import { notificationAllowed } from './notificationTransitions'

const agent = (extra: Partial<Agent> = {}): Agent => ({
  id: 'a1', name: 'Codex', description: '', instructions: '', color: 'blue', runtimeId: 'r1', defaultProject: null,
  model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, sortOrder: 0, ...extra,
} as Agent)

describe('per-blob notification level', () => {
  it('lets everything through by default and respects muted and input-only', () => {
    for (const state of ['completed', 'failed', 'approval'] as const) {
      expect(notificationAllowed(undefined, state)).toBe(true)
      expect(notificationAllowed(null, state)).toBe(true)
      expect(notificationAllowed('all', state)).toBe(true)
      expect(notificationAllowed('muted', state)).toBe(false)
    }
    expect(notificationAllowed('input', 'approval')).toBe(true)
    expect(notificationAllowed('input', 'completed')).toBe(false)
    expect(notificationAllowed('input', 'failed')).toBe(false)
  })

  it('reads the level into the draft, treating unknown values as all', () => {
    expect(draftFromAgent(agent()).notificationLevel).toBe('all')
    expect(draftFromAgent(agent({ notificationLevel: 'input' })).notificationLevel).toBe('input')
    expect(draftFromAgent(agent({ notificationLevel: 'muted' })).notificationLevel).toBe('muted')
    expect(draftFromAgent(agent({ notificationLevel: 'loud' as never })).notificationLevel).toBe('all')
  })

  it('marks the draft dirty and sends the level only when it changed', () => {
    const baseline = draftFromAgent(agent())
    expect(isAgentDirty(baseline, baseline)).toBe(false)
    const muted = { ...baseline, notificationLevel: 'muted' as const }
    expect(isAgentDirty(muted, baseline)).toBe(true)
    expect(updateParams('a1', muted, baseline)).toEqual({ agentId: 'a1', notificationLevel: 'muted' })
    expect(updateParams('a1', baseline, muted)).toEqual({ agentId: 'a1', notificationLevel: null })
    expect(updateParams('a1', baseline, baseline)).toEqual({ agentId: 'a1' })
  })

  it('includes a non-default level when creating a blob and omits the default', () => {
    const base = draftFromAgent(agent())
    expect(createParams({ ...base, notificationLevel: 'input' }).notificationLevel).toBe('input')
    expect('notificationLevel' in createParams(base)).toBe(false)
  })
})
