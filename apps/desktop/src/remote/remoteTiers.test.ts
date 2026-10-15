import { describe, expect, it } from 'vitest'
import { authorizeRemoteCall, METHOD_RULES, redactSnapshotForRemote, renderTierTableMarkdown, ruleFor } from './remoteTiers'

describe('remote method rules', () => {
  it('keeps every rule consistent with its class', () => {
    for (const rule of METHOD_RULES) {
      if (rule.class === 'read') expect(rule.minTier, rule.method).toBe('viewer')
      else if (rule.class === 'chat') expect(rule.minTier, rule.method).toBe('chat')
      else if (rule.class === 'approve') expect(rule.minTier, rule.method).toBe('operator')
      else expect(rule.minTier, rule.method).toBeNull()
      expect(rule.why.trim().length, rule.method).toBeGreaterThan(0)
    }
  })

  it('has no duplicate rule names', () => {
    const names = METHOD_RULES.map((rule) => rule.method)
    expect(new Set(names).size).toBe(names.length)
  })

  it('resolves a family rule only through its prefix', () => {
    expect(ruleFor('mcp.some.tool')?.class).toBe('never')
    expect(ruleFor('exec.snapshot.latest')?.class).toBe('read')
    expect(ruleFor('usage.summary')?.class).toBe('read')
    expect(ruleFor('session.queue.anything')?.class).toBe('chat')
    expect(ruleFor('session.delete.schedule')?.class).toBe('never')
    // `session.delete.*` must not swallow the exact `session.delete`.
    expect(ruleFor('session.delete')?.method).toBe('session.delete')
    expect(ruleFor('not.a.method')).toBeNull()
  })
})

describe('authorizeRemoteCall', () => {
  const call = (tier: 'viewer' | 'chat' | 'operator', method: string, approvalsFromRemote = false, params?: unknown) =>
    authorizeRemoteCall({ tier, method, approvalsFromRemote, params })

  it('allows reads at every tier', () => {
    for (const tier of ['viewer', 'chat', 'operator'] as const) {
      expect(call(tier, 'app.snapshot')).toEqual({ allowed: true })
      expect(call(tier, 'session.get')).toEqual({ allowed: true })
    }
  })

  it('requires the chat tier for chat methods', () => {
    expect(call('viewer', 'session.prompt', false, { sessionId: 's', text: 'hi' })).toEqual({
      allowed: false,
      reason: 'a viewer device cannot call session.prompt',
    })
    expect(call('chat', 'session.prompt', false, { sessionId: 's', text: 'hi' })).toEqual({ allowed: true })
    expect(call('operator', 'session.cancel')).toEqual({ allowed: true })
  })

  it('requires the operator tier and host consent for approvals', () => {
    expect(call('chat', 'permission.reply', true, { permissionId: 'p', choice: 'allow' }).allowed).toBe(false)
    expect(call('operator', 'permission.reply', false, { permissionId: 'p', choice: 'allow' })).toEqual({
      allowed: false,
      reason: 'approvals from remote are turned off on this host',
    })
    expect(call('operator', 'permission.reply', true, { permissionId: 'p', choice: 'allow' })).toEqual({ allowed: true })
  })

  it('always denies the never class and unknown methods', () => {
    expect(call('operator', 'settings.set', true, { key: 'x', value: 1 }).allowed).toBe(false)
    expect(call('operator', 'mcp.memory_search', true).allowed).toBe(false)
    expect(call('operator', 'session.model.update', true).allowed).toBe(false)
    expect(call('operator', 'something.else')).toEqual({ allowed: false, reason: 'not on the remote allowlist' })
  })

  it('rejects raw attachment paths on prompt and queue methods', () => {
    const raw = { sessionId: 's', text: 'hi', attachments: [{ path: 'C:\\secret\\a.png', name: 'a.png' }] }
    expect(call('chat', 'session.prompt', false, raw)).toEqual({
      allowed: false,
      reason: 'attachments must be staged uploads; a raw path is not accepted',
    })
    expect(call('chat', 'session.queue.add', false, raw).allowed).toBe(false)
    expect(call('chat', 'session.prompt', false, { sessionId: 's', text: 'hi', attachments: [{ stagedId: 'up_1' }] })).toEqual({ allowed: true })
    expect(call('chat', 'session.queue.add', false, { sessionId: 's', text: 'hi', attachments: [{ stagedId: 'up_1', name: 'a.png' }] })).toEqual({ allowed: true })
    expect(call('chat', 'session.prompt', false, { sessionId: 's', text: 'hi' })).toEqual({ allowed: true })
  })

  it('requires an attachment to carry a stagedId', () => {
    expect(call('chat', 'session.prompt', false, { attachments: [{ name: 'a.png' }] })).toEqual({
      allowed: false,
      reason: 'attachments must carry a stagedId',
    })
  })

  it('requires permissionId and choice for an approval', () => {
    expect(call('operator', 'permission.reply', true, { choice: 'allow' })).toEqual({
      allowed: false,
      reason: 'permission.reply requires a permissionId',
    })
    expect(call('operator', 'permission.reply', true, { permissionId: 'p' })).toEqual({
      allowed: false,
      reason: 'permission.reply requires a choice',
    })
    expect(call('operator', 'permission.reply', true).allowed).toBe(false)
  })
})

describe('redactSnapshotForRemote', () => {
  const fixture = () => ({
    snapshotVersion: 1,
    sequence: 42,
    daemon: { state: 'ready', version: '0.1.0-beta.28', capability: 'mem-secret-capability' },
    agents: [
      {
        id: 'agent_1',
        name: 'Codex',
        instructions: 'Do the thing.\nThen check the tests.',
        customEnv: { LANG: 'en_US.UTF-8', TZ: 'Europe/Berlin' },
        model: 'gpt-x',
        accessToken: 'tok_123',
      },
      { id: 'agent_2', name: 'Blank', instructions: '', customEnv: {} },
    ],
    sessions: [
      {
        id: 'sess_1',
        agentId: 'agent_1',
        title: 'Fix tests',
        projectPath: 'C:\\Users\\sam\\repos\\bloblex\\apps\\desktop',
        turns: [{ id: 'turn_1', password: 'hunter2' }],
      },
      { id: 'sess_2', agentId: 'agent_2', projectPath: 'relative/project', title: 'Local' },
    ],
    permissions: [{ id: 'perm_1', sessionId: 'sess_1', credentialRef: 'ghp_xxx' }],
    settings: { 'notifications.enabled': true, apiSecret: 'nope' },
  })

  it('removes secrets, env values, instruction text and path depth', () => {
    const snapshot = fixture()
    const safe = redactSnapshotForRemote(snapshot) as Record<string, any>

    expect((safe.daemon as Record<string, unknown>).capability).toBeUndefined()
    expect(safe.agents[0].instructions).toEqual({ hasInstructions: true })
    expect(safe.agents[0].customEnv).toEqual({})
    expect(safe.agents[0].accessToken).toBeUndefined()
    expect(safe.agents[0].model).toBe('gpt-x')
    expect(safe.agents[1].instructions).toBe('')
    expect(safe.sessions[0].projectPath).toBe('apps/desktop')
    expect(safe.sessions[0].turns[0].password).toBeUndefined()
    expect(safe.sessions[1].projectPath).toBe('relative/project')
    expect(safe.permissions[0].credentialRef).toBeUndefined()
    expect(safe.settings.apiSecret).toBeUndefined()
    expect(safe.settings['notifications.enabled']).toBe(true)
    expect(safe.sequence).toBe(42)
  })

  it('does not mutate its input', () => {
    const snapshot = fixture()
    redactSnapshotForRemote(snapshot)
    expect(snapshot.agents[0].instructions).toBe('Do the thing.\nThen check the tests.')
    expect(snapshot.agents[0].customEnv).toEqual({ LANG: 'en_US.UTF-8', TZ: 'Europe/Berlin' })
    expect(snapshot.sessions[0].projectPath).toBe('C:\\Users\\sam\\repos\\bloblex\\apps\\desktop')
  })
})

describe('renderTierTableMarkdown', () => {
  it('renders one row per rule with the four columns', () => {
    const table = renderTierTableMarkdown()
    const rows = table.split('\n')
    expect(rows[0]).toBe('| Method | Class | Minimum tier | Why |')
    expect(rows[1]).toBe('| --- | --- | --- | --- |')
    expect(rows).toHaveLength(METHOD_RULES.length + 2)
    expect(table).toContain('| `permission.reply` | approve | operator |')
    expect(table).toContain('| `mcp.*` | never | — |')
  })
})
