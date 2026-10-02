import { describe, expect, it } from 'vitest'
import { applyEvent, type DaemonEvent, type Snapshot } from './types'
import {
  instructionNote, outcomeText, parseCapabilities, parseExecSnapshot, parseModelCatalog,
  selectionAfterModelChange, sendGateFor, type CapabilitySetting,
} from './executionContract'
import { newestFirst, parseAutoResolved, parseBypassActive, parsePermissionsPolicy } from './approvalContract'

const setting = (partial: Partial<CapabilitySetting> & Pick<CapabilitySetting, 'supported' | 'enabled'>): CapabilitySetting => ({
  scope: 'turn', evidence: 'successful_turn', ...partial,
})

describe('execution contract parsing', () => {
  it('classifies supported, disabled, gated, and unknown capability rows', () => {
    const parsed = parseCapabilities({
      runtimeId: 'rt-codex',
      settings: {
        model: setting({ supported: true, enabled: true, scope: 'turn', evidence: 'provider_echo' }),
        thinking: setting({ supported: true, enabled: false, reason: 'Gate closed', scope: 'turn', evidence: 'usage_effect' }),
        serviceTier: setting({ supported: false, enabled: false, reason: 'No speed control', scope: 'turn', evidence: 'none' }),
        instructions: setting({ supported: true, enabled: true, scope: 'thread', evidence: 'successful_turn' }),
        customEnv: { supported: true, enabled: true, scope: 'spawn', evidence: 'request_shape', allowedKeys: ['TZ', 'LANG'], secret: 'nope' },
      },
      globalConcurrency: { limit: 4, active: 1 },
      hostDependent: true,
    })
    expect(parsed?.settings.model?.enabled).toBe(true)
    expect(parsed?.settings.thinking?.reason).toBe('Gate closed')
    expect(parsed?.settings.serviceTier?.supported).toBe(false)
    expect(parsed?.settings.customEnv?.allowedKeys).toEqual(['TZ', 'LANG'])
    expect(parsed?.settings.customEnv).not.toHaveProperty('secret')
    expect(parseCapabilities({})).toBeNull()
    expect(parseCapabilities({ runtimeId: 'rt', settings: { model: { supported: 'yes' } } })).toBeNull()
  })

  it('resets thinking and tier to the new model defaults and omits hard-coded tier ids', () => {
    const catalog = parseModelCatalog({
      runtimeId: 'rt-codex', provider: 'codex', fallback: false, source: 'app_server',
      models: [
        { id: 'alpha', displayName: 'Alpha', supportedThinking: ['low', 'high'], defaultThinking: 'high', serviceTiers: [{ id: 'priority', name: 'Priority' }], defaultServiceTier: 'priority', hostDependent: false },
        { id: 'beta', displayName: 'Beta', supportedThinking: ['low'], defaultThinking: 'low', serviceTiers: [{ id: 'flex', name: 'Flex' }], defaultServiceTier: 'flex', hostDependent: true },
        { id: 'plain', displayName: 'Plain', supportedThinking: [], defaultThinking: null, serviceTiers: [], defaultServiceTier: null, hostDependent: false },
      ],
    })
    expect(selectionAfterModelChange('beta', catalog, false)).toEqual({ model: 'beta', thinking: 'low', serviceTier: 'flex' })
    expect(selectionAfterModelChange('plain', catalog, false)).toEqual({ model: 'plain', thinking: null, serviceTier: null })
    expect(selectionAfterModelChange('claude-custom', catalog, true)).toEqual({ model: 'claude-custom', thinking: null, serviceTier: null })
    expect(selectionAfterModelChange('beta', catalog, false).serviceTier).not.toBe('fast')
    expect(selectionAfterModelChange('beta', catalog, false).serviceTier).not.toBe('standard')
    const caps = parseCapabilities({
      runtimeId: 'rt-codex',
      settings: {
        model: setting({ supported: true, enabled: true }),
        thinking: setting({ supported: true, enabled: false }),
        serviceTier: setting({ supported: false, enabled: false }),
        instructions: setting({ supported: true, enabled: true }),
        customEnv: setting({ supported: true, enabled: true }),
      },
    })
    expect(sendGateFor(caps, false)).toEqual({ model: true, thinking: false, serviceTier: false })
    expect(sendGateFor(null, false)).toEqual({ model: false, thinking: false, serviceTier: false })
  })

  it('words instruction timing from the provider and scope without upgrading weak evidence', () => {
    const codex = instructionNote('codex', setting({ supported: true, enabled: true, scope: 'thread', evidence: 'successful_turn' }))
    expect(codex).toContain('Applies to new conversations.')
    const launch = instructionNote('opencode', setting({ supported: true, enabled: true, scope: 'launch', evidence: 'request_shape' }))
    expect(launch).toContain('Applies when the next conversation starts.')
    expect(launch.toLowerCase()).toContain('not confirmed')
    expect(instructionNote('claude', null)).toContain('has not reported')
    expect(instructionNote('claude', setting({ supported: true, enabled: false, reason: 'Instructions are off.', scope: 'launch', evidence: 'none' }))).toBe('Instructions are off.')
  })

  it('never renders an unknown snapshot outcome as applied', () => {
    const snapshot = parseExecSnapshot({
      id: 'snap-1', sessionId: 'sess-1', status: 'partial',
      requested: { model: 'gpt-6', instructionsPresent: true },
      applied: {
        model: { applied: null },
        thinking: { applied: false, reason: 'execution_gate_or_capability_unavailable' },
        serviceTier: { applied: true },
        instructions: 0,
      },
      evidence: { model: { kind: 'none', raw: { secret: true } }, serviceTier: { kind: 'provider_echo', value: 'flex' } },
      adapterFlags: { raw: true },
    })
    expect(snapshot?.outcomes.map((item) => outcomeText(item))).toEqual([
      'Unknown · No evidence',
      'Unsupported · Unknown',
      'Applied · Provider echo',
      'Unknown · Unknown',
    ])
    expect(snapshot?.appliedModelId).toBeNull()
    expect(JSON.stringify(snapshot)).not.toContain('secret')
    const applied = parseExecSnapshot({
      id: 'snap-2', sessionId: 'sess-1', status: 'applied',
      requested: { model: 'gpt-6' },
      applied: { model: { applied: true } },
      evidence: { model: { kind: 'provider_echo' } },
    })
    expect(applied?.appliedModelId).toBe('gpt-6')
    expect(outcomeText(applied!.outcomes[0]!)).toBe('Applied · Provider echo')
    expect(parseExecSnapshot(null)).toBeNull()
    expect(parseExecSnapshot({ applied: { model: true } })).toBeNull()
  })
})

describe('approval events and policy', () => {
  const base = (): Snapshot => ({ sequence: 4, sessions: [], permissions: [] })
  const event = (type: string, sequence: number, payload: Record<string, unknown>): DaemonEvent => ({ type, sequence, payload })

  it('keeps only known auto-resolved fields and orders newest first', () => {
    const parsed = parseAutoResolved({
      permissionId: 'p-1', sessionId: 's-1', turnId: 't-1', agentId: 'a-1', mode: 'auto', decision: 'allow', category: 'READ', summary: 'Read src/main.ts', secret: 'hide',
    }, 8)
    expect(parsed).toEqual({ permissionId: 'p-1', sessionId: 's-1', turnId: 't-1', agentId: 'a-1', mode: 'auto', decision: 'allow', category: 'READ', summary: 'Read src/main.ts', sequence: 8 })
    expect(parsed).not.toHaveProperty('secret')
    expect(parseAutoResolved({ mode: 'ask', summary: 'no' }, 1)).toBeNull()
    expect(parseAutoResolved({ mode: 'auto', summary: '   ' }, 1)).toBeNull()
    expect(parseBypassActive({ sessionId: 's-1', agentId: 'a-1', providerMode: 'never', raw: {} }, 3)?.providerMode).toBe('never')
    expect(parseBypassActive({ providerMode: 'never' }, 3)).toBeNull()
    const policy = parsePermissionsPolicy({ defaultMode: 'bypass', perAgent: [{ agentId: 'a-1', mode: null, effectiveMode: 'auto', extra: 1 }, { agentId: '', mode: 'ask', effectiveMode: 'ask' }], token: 'no' })
    expect(policy.defaultMode).toBe('ask')
    expect(policy.perAgent).toEqual([{ agentId: 'a-1', mode: null, effectiveMode: 'auto' }])
    expect(policy).not.toHaveProperty('token')
    const first = applyEvent(base(), event('permission.auto_resolved', 5, { permissionId: 'p-1', agentId: 'a-1', mode: 'auto', category: 'READ', summary: 'Read file' }))
    const second = applyEvent(first, event('permission.auto_resolved', 6, { permissionId: 'p-2', agentId: 'a-1', mode: 'bypass', category: 'EDIT', summary: 'Edit file', contents: 'secret' }))
    expect(newestFirst(second.autoApprovals ?? []).map((item) => item.summary)).toEqual(['Edit file', 'Read file'])
    expect(JSON.stringify(second.autoApprovals)).not.toContain('secret')
    const bypass = applyEvent(second, event('permission.bypass_active', 7, { sessionId: 's-1', agentId: 'a-1', providerMode: 'never' }))
    expect(bypass.bypassNotices?.[0]).toMatchObject({ sessionId: 's-1', providerMode: 'never' })
    const unknown = applyEvent(base(), event('provider.raw_payload', 5, { secret: 'must not be rendered' }))
    expect(unknown.autoApprovals).toBeUndefined()
    expect(unknown.sequence).toBe(5)
  })
})
