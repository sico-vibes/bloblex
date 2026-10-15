import { describe, expect, it } from 'vitest'
import { changedFields, createDraft, isAgentDirty, summarizeChanges, type AgentDraft } from './agentForm'
import type { Runtime } from '../types'

const runtime = { id: 'rt', provider: 'codex', authState: 'authenticated' } as unknown as Runtime
const saved: AgentDraft = { ...createDraft([runtime], 'rt'), name: 'Atlas', description: 'Reviews code', role: 'Reviewer', model: 'gpt-6', thinking: 'high' }
const base = (): AgentDraft => ({ ...saved })

describe('changedFields', () => {
  it('is empty for an unchanged draft and agrees with isAgentDirty', () => {
    const draft = base()
    expect(changedFields(draft, base())).toEqual([])
    expect(isAgentDirty(draft, base())).toBe(false)
  })

  it('reports each changed field with a label and its section', () => {
    const draft = { ...base(), name: 'Atlas 2', model: 'gpt-6-luna', approvalMode: 'auto' as const, role: 'CTO' }
    const result = changedFields(draft, base())
    expect(result.map((item) => item.field)).toEqual(['name', 'role', 'model', 'approvalMode'])
    expect(result.find((item) => item.field === 'name')?.section).toBe('profile')
    expect(result.find((item) => item.field === 'model')?.section).toBe('model')
    expect(result.find((item) => item.field === 'approvalMode')?.section).toBe('permissions')
    expect(isAgentDirty(draft, base())).toBe(true)
  })

  it('treats whitespace-only role changes as no change', () => {
    expect(changedFields({ ...base(), role: ' Reviewer ' }, base())).toEqual([])
  })
})

describe('summarizeChanges', () => {
  const item = (label: string) => ({ field: label, label, section: 'profile' as const })
  it('reads naturally for 1, 2, 3 and many', () => {
    expect(summarizeChanges([item('Name')])).toBe('Name')
    expect(summarizeChanges([item('Name'), item('Model')])).toBe('Name and Model')
    expect(summarizeChanges([item('Name'), item('Model'), item('Effort')])).toBe('Name, Model and Effort')
    expect(summarizeChanges([item('A'), item('B'), item('C'), item('D'), item('E')])).toBe('A, B, C and 2 more')
    expect(summarizeChanges([])).toBe('')
  })
})
