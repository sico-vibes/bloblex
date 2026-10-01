import { describe, expect, it } from 'vitest'
import { findApplicableBudget } from './budgetPresentation'

describe('applicable budget selection', () => {
  const runtime = { id: 'runtime-1', provider: 'codex', hostId: 'host-1' }
  const session = { id: 'session-1', runtimeId: 'runtime-1', projectPath: 'C:/work/project' }
  const policies = [
    { id: 'global', scopeType: 'global', enabled: true, remaining: 100 },
    { id: 'host', scopeType: 'host', scopeId: 'host-1', enabled: true, remaining: 80 },
    { id: 'project', scopeType: 'project', scopeId: 'C:/work/project', enabled: true, remaining: 20 },
    { id: 'paused', scopeType: 'session', scopeId: 'session-1', enabled: false, remaining: 1 },
  ]
  it('chooses the most specific enabled policy and excludes paused policies', () => {
    expect(findApplicableBudget(policies, runtime, session, 'host-1')?.id).toBe('project')
  })
  it('does not apply a scope for another runtime', () => {
    expect(findApplicableBudget([{ id: 'other', scopeType: 'runtime', scopeId: 'other', enabled: true }], runtime, session)).toBeNull()
  })
})
