import { describe, expect, it } from 'vitest'
import type { Agent } from '../types'
import { CLIENT_MESSAGES, createParams, draftFromAgent, duplicateParams, isAgentDirty, messageForDaemonCode, updateParams, validateAgentDraft, type DaemonFailureKind } from './agentForm'

function agent(partial: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-claude', name: 'Claude', description: 'Default', instructions: 'Be brief', color: '#f38c6f', runtimeId: 'runtime-claude',
    model: 'gpt-test', thinking: 'high', serviceTier: 'flex', customArgs: ['--yes'], customEnv: { MODE: 'test' }, maxConcurrency: 2,
    defaultProject: 'C:/work/site', sortOrder: 0, archived: false, createdAt: 't0', updatedAt: 't0', ...partial,
  }
}

describe('agent draft validation', () => {
  const baseline = draftFromAgent(agent())

  it('states every client validation message', () => {
    expect(validateAgentDraft({ ...baseline, name: '   ' }, [])).toMatchObject({ name: CLIENT_MESSAGES.nameEmpty })
    expect(validateAgentDraft({ ...baseline, name: 'A'.repeat(61) }, [])).toMatchObject({ name: CLIENT_MESSAGES.nameLong })
    expect(validateAgentDraft({ ...baseline, description: 'B'.repeat(256) }, [])).toMatchObject({ description: CLIENT_MESSAGES.descriptionLong })
    expect(validateAgentDraft({ ...baseline, instructions: 'keep\0out' }, [])).toMatchObject({ instructions: CLIENT_MESSAGES.instructionsNul })
    expect(validateAgentDraft({ ...baseline, color: 'red' }, [])).toMatchObject({ color: CLIENT_MESSAGES.color })
    expect(validateAgentDraft({ ...baseline, runtimeId: '' }, [])).toMatchObject({ runtimeId: CLIENT_MESSAGES.runtime })
    expect(validateAgentDraft({ ...baseline, name: 'codex' }, ['Codex'])).toMatchObject({ name: CLIENT_MESSAGES.nameTaken })
    expect(validateAgentDraft(baseline, ['Invoice helper'])).toEqual({})
  })

  it('maps every daemon code row to the stable sentence', () => {
    const cases: Array<[string, DaemonFailureKind, { archived?: boolean; sentName?: boolean } | undefined, string]> = [
      ['conflict', 'agent.create', undefined, 'Another blob already uses this name.'],
      ['conflict', 'agent.update', { sentName: true }, 'Another blob already uses this name.'],
      ['conflict', 'agent.update', { archived: true, sentName: true }, 'This blob is archived and cannot be edited.'],
      ['conflict', 'session.new', undefined, 'This blob is archived, so a new session cannot be started.'],
      ['not_found', 'agent.create', undefined, 'That runtime is no longer available. Refresh and choose another.'],
      ['not_found', 'agent.get', undefined, 'That blob is no longer available. Refresh and try again.'],
      ['not_found', 'agent.update', undefined, 'That blob is no longer available. Refresh and try again.'],
      ['not_found', 'agent.delete', undefined, 'That blob is no longer available. Refresh and try again.'],
      ['not_found', 'session.new', undefined, 'That blob is no longer available. Refresh and try again.'],
      ['not_found', 'agent.reorder', undefined, 'That runtime is no longer available.'],
      ['invalid_argument', 'agent.create', undefined, 'Check the name, description, colour, and runtime, then try again.'],
      ['invalid_argument', 'agent.update', undefined, 'Check the name, description, colour, and runtime, then try again.'],
      ['invalid_argument', 'session.new', undefined, 'Choose a project folder that exists on this device.'],
      ['invalid_argument', 'agent.reorder', undefined, 'The roster order is out of date. Refresh and try again.'],
      ['internal', 'agent.update', undefined, 'Bloblex could not save that change. Nothing was applied.'],
      ['unauthorized', 'agent.delete', undefined, 'Bloblex could not reach the local daemon. Reconnect and try again.'],
      ['mystery', 'agent.create', undefined, 'The local daemon request failed.'],
    ]
    for (const [code, kind, options, message] of cases) {
      expect(messageForDaemonCode(code, kind, options)).toBe(message)
    }
  })

  it('treats a migrated hex as the same paint and sends only dirty profile fields', () => {
    expect(isAgentDirty({ ...baseline, color: 'coral' }, baseline)).toBe(false)
    const renamed = { ...baseline, name: 'Claude Prime' }
    expect(isAgentDirty(renamed, baseline)).toBe(true)
    expect(updateParams(baseline.runtimeId && 'agent-claude', renamed, baseline)).toEqual({ agentId: 'agent-claude', name: 'Claude Prime' })
    expect(updateParams('agent-claude', { ...baseline, color: 'coral' }, baseline)).toEqual({ agentId: 'agent-claude' })
    expect(updateParams('agent-claude', { ...baseline, defaultProject: '   ' }, baseline)).toEqual({ agentId: 'agent-claude', defaultProject: null })
    const created = createParams({ ...baseline, name: '  Pink sibling  ', color: '#F0A0C4' })
    expect(created).toEqual({ name: 'Pink sibling', runtimeId: 'runtime-claude', description: 'Default', instructions: 'Be brief', color: 'pink', defaultProject: 'C:/work/site' })
    expect(created).not.toHaveProperty('model')
    expect(created).not.toHaveProperty('customEnv')
    const cancelled = baseline
    expect(cancelled.name).toBe('Claude')
    expect(isAgentDirty(cancelled, baseline)).toBe(false)
  })

  it('copies inert execution fields on duplicate and omits archived', () => {
    const source = agent()
    expect(duplicateParams(source, 'Copy of Claude')).toEqual({
      name: 'Copy of Claude', runtimeId: 'runtime-claude', description: 'Default', instructions: 'Be brief', color: '#f38c6f',
      model: 'gpt-test', thinking: 'high', serviceTier: 'flex', customArgs: ['--yes'], customEnv: { MODE: 'test' }, maxConcurrency: 2, defaultProject: 'C:/work/site',
    })
    expect(duplicateParams(source, 'Copy of Claude')).not.toHaveProperty('archived')
  })
})
