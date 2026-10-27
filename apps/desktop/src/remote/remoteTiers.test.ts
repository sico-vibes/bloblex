import { describe, expect, it } from 'vitest'
import {
  authorizeRemoteCall,
  EVENT_POLICY,
  METHOD_RULES,
  redactEventForRemote,
  redactResultForRemote,
  redactSnapshotForRemote,
  renderTierTableMarkdown,
  ruleFor,
  SETTINGS_ALLOWLIST,
  stagedAttachmentRule,
  type DenialCode,
} from './remoteTiers'

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
  // A widened view of the decision so tests can read `code` without narrowing.
  const call = (tier: 'viewer' | 'chat' | 'operator', method: string, approvalsFromRemote = false, params?: unknown, quietHours = false): { allowed: boolean; code?: DenialCode; reason?: string } =>
    authorizeRemoteCall({ tier, method, approvalsFromRemote, params, quietHours })

  it('allows reads at every tier', () => {
    for (const tier of ['viewer', 'chat', 'operator'] as const) {
      expect(call(tier, 'app.snapshot')).toEqual({ allowed: true })
      expect(call(tier, 'session.get')).toEqual({ allowed: true })
    }
  })

  it('requires the chat tier for chat methods', () => {
    expect(call('viewer', 'session.prompt', false, { sessionId: 's', text: 'hi' })).toEqual({
      allowed: false,
      code: 'tier_required',
      reason: 'a viewer device cannot call session.prompt',
    })
    expect(call('chat', 'session.prompt', false, { sessionId: 's', text: 'hi' })).toEqual({ allowed: true })
    expect(call('operator', 'session.cancel')).toEqual({ allowed: true })
  })

  it('requires the operator tier and host consent for approvals', () => {
    expect(call('chat', 'permission.reply', true, { permissionId: 'p', choice: 'allow' })).toEqual({
      allowed: false,
      code: 'approvals_disabled',
      reason: 'a chat device cannot approve on this host',
    })
    expect(call('operator', 'permission.reply', false, { permissionId: 'p', choice: 'allow' })).toEqual({
      allowed: false,
      code: 'approvals_disabled',
      reason: 'approvals from remote are turned off on this host',
    })
    expect(call('operator', 'permission.reply', true, { permissionId: 'p', choice: 'allow' })).toEqual({ allowed: true })
  })

  it('always denies the never class and unknown methods', () => {
    expect(call('operator', 'settings.set', true, { key: 'x', value: 1 })).toEqual({
      allowed: false,
      code: 'forbidden_remote',
      reason: expect.any(String),
    })
    expect(call('operator', 'mcp.memory_search', true).code).toBe('forbidden_remote')
    expect(call('operator', 'session.model.update', true).code).toBe('forbidden_remote')
    // Repository diffs can hold secrets from the host's files, so no tier may read them remotely.
    for (const tier of ['viewer', 'chat', 'operator'] as const) expect(call(tier, 'session.repository', true).code).toBe('forbidden_remote')
    expect(call('operator', 'something.else')).toEqual({
      allowed: false,
      code: 'forbidden_remote',
      reason: 'not on the remote allowlist',
    })
  })

  it('denies every chat and approve method during quiet hours but lets reads pass', () => {
    const quiet = (tier: 'viewer' | 'chat' | 'operator', method: string) => call(tier, method, true, undefined, true)
    for (const method of ['session.cancel', 'session.archive', 'session.rename', 'session.queue.add', 'session.resume', 'session.prompt', 'session.steer']) {
      expect(quiet('operator', method), method).toEqual({
        allowed: false,
        code: 'quiet_hours',
        reason: expect.any(String),
      })
    }
    expect(quiet('operator', 'permission.reply')).toEqual({ allowed: false, code: 'quiet_hours', reason: expect.any(String) })
    for (const method of ['app.snapshot', 'session.get', 'session.list', 'runtime.list']) {
      expect(quiet('viewer', method), method).toEqual({ allowed: true })
    }
  })

  it('rejects raw attachment paths on prompt and queue methods', () => {
    const raw = { sessionId: 's', text: 'hi', attachments: [{ path: 'C:\\secret\\a.png', name: 'a.png' }] }
    expect(call('chat', 'session.prompt', false, raw)).toEqual({
      allowed: false,
      code: 'invalid_params',
      reason: 'attachments must be staged uploads; a raw path is not accepted',
    })
    expect(call('chat', 'session.queue.add', false, raw).code).toBe('invalid_params')
    expect(call('chat', 'session.prompt', false, { sessionId: 's', text: 'hi', attachments: [{ stagedId: 'up_1' }] })).toEqual({ allowed: true })
    expect(call('chat', 'session.queue.add', false, { sessionId: 's', text: 'hi', attachments: [{ stagedId: 'up_1', name: 'a.png' }] })).toEqual({ allowed: true })
    expect(call('chat', 'session.prompt', false, { sessionId: 's', text: 'hi' })).toEqual({ allowed: true })
  })

  it('covers every chat method that takes attachments with the staged-attachment rule', () => {
    // Read from the daemon: `session.prompt` reads params.attachments via
    // `prompt_attachments(&p["attachments"])` (main.rs), and `session.queue.add`
    // reads them via `validate_body` (queue.rs). Every other queue method is
    // covered by the `session.queue.*` family, which carries the same rule.
    const methodsTakingAttachments = ['session.prompt', 'session.queue.add']
    for (const method of methodsTakingAttachments) {
      const rule = ruleFor(method)
      expect(rule?.class, method).toBe('chat')
      expect(rule?.params, method).toBe(stagedAttachmentRule)
      expect(call('chat', method, false, { sessionId: 's', text: 'hi', attachments: [{ path: 'C:\\secret\\a.png' }] }).code, method).toBe('invalid_params')
    }
  })

  it('requires an attachment to carry a stagedId', () => {
    expect(call('chat', 'session.prompt', false, { attachments: [{ name: 'a.png' }] })).toEqual({
      allowed: false,
      code: 'invalid_params',
      reason: 'attachments must carry a stagedId',
    })
  })

  it('requires permissionId and choice for an approval', () => {
    expect(call('operator', 'permission.reply', true, { choice: 'allow' })).toEqual({
      allowed: false,
      code: 'invalid_params',
      reason: 'permission.reply requires a permissionId',
    })
    expect(call('operator', 'permission.reply', true, { permissionId: 'p' })).toEqual({
      allowed: false,
      code: 'invalid_params',
      reason: 'permission.reply requires a choice',
    })
    expect(call('operator', 'permission.reply', true).code).toBe('invalid_params')
  })

  it('rejects refresh on runtime.models: a device may not make the host poll providers', () => {
    expect(call('viewer', 'runtime.models', false, { runtimeId: 'rt', refresh: true })).toEqual({
      allowed: false,
      code: 'invalid_params',
      reason: 'a device may not make the host poll providers (refresh is not accepted)',
    })
    expect(call('viewer', 'runtime.models', false, { runtimeId: 'rt', refresh: false })).toEqual({ allowed: true })
    expect(call('viewer', 'runtime.models', false, { runtimeId: 'rt' })).toEqual({ allowed: true })
  })
})

describe('redactSnapshotForRemote', () => {
  it('reduces runtime and profile executables to a file name and args to a count', () => {
    const snapshot = {
      runtimes: [{ id: 'rt_1', executablePath: 'C:\\Tools\\codex.exe', launchArgs: ['--profile', 'work'] }],
      runtimeProfiles: [{ id: 'p_1', executablePath: '/usr/local/bin/claude', args: ['--x'] }],
      profiles: [{ id: 'p_2', executablePath: 'D:\\node\\node.exe', args: [] }],
    }
    const safe = redactSnapshotForRemote(snapshot) as Record<string, any>
    expect(safe.runtimes[0].executablePath).toBe('codex.exe')
    expect(safe.runtimes[0].launchArgs).toEqual({ argCount: 2 })
    expect(safe.runtimeProfiles[0].executablePath).toBe('claude')
    expect(safe.runtimeProfiles[0].args).toEqual({ argCount: 1 })
    expect(safe.profiles[0].executablePath).toBe('node.exe')
    expect(safe.profiles[0].args).toEqual({ argCount: 0 })
  })

  it('shortens defaultProject, projectPath, project paths and file paths to two segments', () => {
    const snapshot = {
      agents: [{ id: 'a_1', defaultProject: 'C:\\Users\\sam\\repos\\bloblex\\apps\\desktop' }],
      projects: [{ id: 'pr_1', path: 'C:\\Users\\sam\\deep\\project' }],
      sessions: [
        {
          id: 's_1',
          projectPath: 'C:\\Users\\sam\\repos\\bloblex\\apps',
          files: [{ id: 'f_1', path: 'C:\\Users\\sam\\repos\\bloblex\\src\\main.ts' }],
        },
        { id: 's_2', projectPath: 'relative/project' },
      ],
    }
    const safe = redactSnapshotForRemote(snapshot) as Record<string, any>
    expect(safe.agents[0].defaultProject).toBe('apps/desktop')
    expect(safe.projects[0].path).toBe('deep/project')
    expect(safe.sessions[0].projectPath).toBe('bloblex/apps')
    expect(safe.sessions[0].files[0].path).toBe('src/main.ts')
    expect(safe.sessions[1].projectPath).toBe('relative/project')
  })

  it('replaces customArgs with a count, customEnv with {}, and instructions with a marker', () => {
    const snapshot = {
      agents: [
        { id: 'a_1', customArgs: ['--api-key', 'abc'], customEnv: { LANG: 'en_US.UTF-8' }, instructions: 'Do the thing.' },
        { id: 'a_2', customArgs: [], customEnv: {}, instructions: '' },
      ],
    }
    const safe = redactSnapshotForRemote(snapshot) as Record<string, any>
    expect(safe.agents[0].customArgs).toEqual({ argCount: 2 })
    expect(safe.agents[0].customEnv).toEqual({})
    expect(safe.agents[0].instructions).toEqual({ hasInstructions: true })
    expect(safe.agents[1].customArgs).toEqual({ argCount: 0 })
    expect(safe.agents[1].customEnv).toEqual({})
    expect(safe.agents[1].instructions).toBe('')
  })

  it('reduces message attachment paths to a file name and keeps message content', () => {
    const snapshot = {
      sessions: [
        {
          id: 's_1',
          messages: [
            { id: 'm_1', role: 'user', content: 'Please fix the tests', attachments: [{ name: 'a.png', path: 'C:\\Users\\sam\\pics\\a.png' }] },
          ],
        },
      ],
    }
    const safe = redactSnapshotForRemote(snapshot) as Record<string, any>
    expect(safe.sessions[0].messages[0].content).toBe('Please fix the tests')
    expect(safe.sessions[0].messages[0].attachments[0].path).toBe('a.png')
  })

  it('removes tool, turn and file detail by default and restores tool detail only when asked', () => {
    const snapshot = () => ({
      sessions: [
        {
          id: 's_1',
          tools: [{ id: 't_1', detail: { command: 'env', output: 'SECRET=1' } }],
          turns: [{ id: 'turn_1', detail: 'provider failure at C:\\Users\\sam\\deep\\x' }],
          files: [{ id: 'f_1', path: 'C:\\Users\\sam\\deep\\x.ts', detail: { diff: 'a secret diff' } }],
        },
      ],
    })
    const safe = redactSnapshotForRemote(snapshot()) as Record<string, any>
    expect(safe.sessions[0].tools[0].detail).toBeUndefined()
    expect(safe.sessions[0].turns[0].detail).toBeUndefined()
    expect(safe.sessions[0].files[0].detail).toBeUndefined()

    const withOutput = redactSnapshotForRemote(snapshot(), { includeToolOutput: true }) as Record<string, any>
    expect(withOutput.sessions[0].tools[0].detail).toEqual({ command: 'env', output: 'SECRET=1' })
    expect(withOutput.sessions[0].turns[0].detail).toBeUndefined()
    expect(withOutput.sessions[0].files[0].detail).toBeUndefined()
  })

  it('removes providerSessionId and sensitive keys, including the widened spellings', () => {
    const snapshot = {
      sessions: [{ id: 's_1', providerSessionId: 'thread_opaque' }],
      daemon: { state: 'ready', capability: 'mem-secret' },
      agents: [{ id: 'a_1', accessToken: 'tok_123' }],
      permissions: [{ id: 'p_1', credentialRef: 'ghp_x' }],
      extra: { apiKey: 'k', privateKey: 'p', authorization: 'Bearer x', cookie: 'c', bearer_token: 'b' },
    }
    const safe = redactSnapshotForRemote(snapshot) as Record<string, any>
    expect(safe.sessions[0].providerSessionId).toBeUndefined()
    expect(safe.daemon.capability).toBeUndefined()
    expect(safe.agents[0].accessToken).toBeUndefined()
    expect(safe.permissions[0].credentialRef).toBeUndefined()
    expect(safe.extra.apiKey).toBeUndefined()
    expect(safe.extra.privateKey).toBeUndefined()
    expect(safe.extra.authorization).toBeUndefined()
    expect(safe.extra.cookie).toBeUndefined()
    expect(safe.extra.bearer_token).toBeUndefined()
  })

  it('reduces settings to the allowlist', () => {
    const snapshot = {
      settings: {
        'appearance.style': 'dark',
        'appearance.accent': 'amber',
        'appearance.wallpaper': 'lake',
        'appearance.glass': 'solid',
        'appearance.font': 'inter',
        'appearance.monoFont': 'geist-mono',
        'appearance.theme': 'system',
        'appearance.textSize': 'medium',
        'appearance.density': 'comfortable',
        'notifications.enabled': true,
        'permissions.default_mode': 'ask',
        'experimental.memory': false,
        'profile.about': 'a private note',
        apiSecret: 'nope',
      },
    }
    const safe = redactSnapshotForRemote(snapshot) as Record<string, any>
    expect(Object.keys(safe.settings).sort()).toEqual([...SETTINGS_ALLOWLIST].sort())
    expect(safe.settings['appearance.style']).toBe('dark')
    expect(safe.settings['notifications.enabled']).toBe(true)
    expect(safe.settings['profile.about']).toBeUndefined()
    expect(safe.settings.apiSecret).toBeUndefined()
  })

  it('does not mutate its input', () => {
    const snapshot = {
      sequence: 42,
      agents: [{ id: 'a_1', instructions: 'Do the thing.', customEnv: { LANG: 'en_US.UTF-8' }, customArgs: ['--x'] }],
      sessions: [{ id: 's_1', projectPath: 'C:\\Users\\sam\\repos\\bloblex\\apps\\desktop', providerSessionId: 't' }],
      runtimes: [{ id: 'rt_1', executablePath: 'C:\\Tools\\codex.exe', launchArgs: ['--a'] }],
    }
    const safe = redactSnapshotForRemote(snapshot)
    expect(safe).toEqual(expect.anything())
    expect(snapshot.agents[0].instructions).toBe('Do the thing.')
    expect(snapshot.agents[0].customEnv).toEqual({ LANG: 'en_US.UTF-8' })
    expect(snapshot.agents[0].customArgs).toEqual(['--x'])
    expect(snapshot.sessions[0].projectPath).toBe('C:\\Users\\sam\\repos\\bloblex\\apps\\desktop')
    expect(snapshot.sessions[0].providerSessionId).toBe('t')
    expect(snapshot.runtimes[0].executablePath).toBe('C:\\Tools\\codex.exe')
    expect(snapshot.runtimes[0].launchArgs).toEqual(['--a'])
    expect(snapshot.sequence).toBe(42)
  })
})

describe('redactResultForRemote', () => {
  it('reduces settings.get to the allowlist', () => {
    const safe = redactResultForRemote('settings.get', { 'appearance.style': 'dark', 'profile.about': 'private', apiSecret: 'x' }) as Record<string, unknown>
    expect(safe).toEqual({ 'appearance.style': 'dark' })
  })

  it('keeps memory.get and memory.list as they are', () => {
    const record = { id: 'mem_1', title: 'Dark mode', body: 'the user prefers dark mode' }
    const got = { record }
    expect(redactResultForRemote('memory.get', got)).toBe(got)
    const listed = { records: [record] }
    expect(redactResultForRemote('memory.list', listed)).toBe(listed)
  })

  it('redacts a session.get result (providerSessionId, tool detail, attachment path)', () => {
    const session = {
      id: 's_1',
      providerSessionId: 'thread_opaque',
      projectPath: 'C:\\Users\\sam\\repos\\bloblex\\apps\\desktop',
      messages: [{ id: 'm_1', content: 'hello', attachments: [{ name: 'a.png', path: 'C:\\pics\\a.png' }] }],
      tools: [{ id: 't_1', detail: { output: 'SECRET=1' } }],
    }
    const safe = redactResultForRemote('session.get', session) as Record<string, any>
    expect(safe.providerSessionId).toBeUndefined()
    expect(safe.projectPath).toBe('apps/desktop')
    expect(safe.messages[0].content).toBe('hello')
    expect(safe.messages[0].attachments[0].path).toBe('a.png')
    expect(safe.tools[0].detail).toBeUndefined()
  })

  it('redacts an agent.get result through the agent policy', () => {
    const agent = { id: 'a_1', instructions: 'x', customArgs: ['--api-key', 'k'], customEnv: { LANG: 'en' }, defaultProject: 'C:\\Users\\sam\\deep\\proj' }
    const safe = redactResultForRemote('agent.get', { agent }) as Record<string, any>
    expect(safe.agent.instructions).toEqual({ hasInstructions: true })
    expect(safe.agent.customArgs).toEqual({ argCount: 2 })
    expect(safe.agent.customEnv).toEqual({})
    expect(safe.agent.defaultProject).toBe('deep/proj')
  })

  it('redacts runtime.profile.list executables and args', () => {
    const safe = redactResultForRemote('runtime.profile.list', {
      profiles: [{ id: 'p_1', executablePath: 'C:\\Tools\\codex.exe', args: ['--profile', 'work'] }],
    }) as Record<string, any>
    expect(safe.profiles[0].executablePath).toBe('codex.exe')
    expect(safe.profiles[0].args).toEqual({ argCount: 2 })
  })

  it('keeps an automation.get prompt and drops sensitive keys', () => {
    const safe = redactResultForRemote('automation.get', {
      automation: { id: 'au_1', prompt: 'Summarise the repository', apiKey: 'nope' },
    }) as Record<string, any>
    expect(safe.automation.prompt).toBe('Summarise the repository')
    expect(safe.automation.apiKey).toBeUndefined()
  })

  it('sends an unrouted read through the field watcher, never raw', () => {
    const safe = redactResultForRemote('project.list', {
      projects: [{ id: 'pr_1', path: 'C:\\Users\\sam\\repos\\bloblex\\deep\\proj', secret: 'x' }],
    }) as Record<string, any>
    expect(safe.projects[0].path).toBe('deep/proj')
    expect(safe.projects[0].secret).toBeUndefined()
  })

  it('leaves a non-read method result unchanged', () => {
    const result = { ok: true, path: 'C:\\Users\\sam\\deep\\x' }
    expect(redactResultForRemote('session.prompt', result)).toBe(result)
  })
})

describe('redactEventForRemote', () => {
  it('returns null for event types that are not on the allowlist', () => {
    for (const type of ['tool.changed', 'hook.observed', 'exec.options.changed', 'exec.options.rejected', 'settings.changed', 'file.changed', 'session.context.reset']) {
      expect(redactEventForRemote({ type, payload: {} }), type).toBeNull()
    }
    expect(redactEventForRemote({ type: 'some.new.event', payload: {} })).toBeNull()
    expect(redactEventForRemote({ payload: {} })).toBeNull()
    expect(redactEventForRemote(null)).toBeNull()
  })

  it('drops raw and providerPayload from message.completed', () => {
    const event = {
      v: 1,
      type: 'message.completed',
      payload: { sessionId: 's', content: 'hello', raw: { provider: 'x' }, providerPayload: { secret: 'y' } },
    }
    const safe = redactEventForRemote(event) as Record<string, any>
    expect(safe.type).toBe('message.completed')
    expect(safe.payload.content).toBe('hello')
    expect(safe.payload.raw).toBeUndefined()
    expect(safe.payload.providerPayload).toBeUndefined()
  })

  it('trims turn.error message text to 200 characters and reduces absolute paths', () => {
    const long = 'x'.repeat(500)
    const safe = redactEventForRemote({
      type: 'turn.error',
      payload: { sessionId: 's', message: long, detail: 'C:\\Users\\sam\\deep\\proj\\file.ts failed' },
    }) as Record<string, any>
    expect(safe.payload.message).toHaveLength(200)
    expect(safe.payload.detail).toBe('proj/file.ts failed')
  })

  it('keeps the permission.requested command text but reduces absolute paths', () => {
    const safe = redactEventForRemote({
      type: 'permission.requested',
      payload: { sessionId: 's', title: 'Run tests', detail: 'pnpm test', path: 'C:\\Users\\sam\\repos\\bloblex\\src\\a.ts' },
    }) as Record<string, any>
    expect(safe.payload.title).toBe('Run tests')
    expect(safe.payload.detail).toBe('pnpm test')
    expect(safe.payload.path).toBe('src/a.ts')
  })

  it('sends agent.changed through the agent policy', () => {
    const safe = redactEventForRemote({
      type: 'agent.changed',
      payload: { action: 'updated', agentId: 'a_1', customArgs: ['--api-key', 'k'], customEnv: { LANG: 'en' } },
    }) as Record<string, any>
    expect(safe.payload.agentId).toBe('a_1')
    expect(safe.payload.customArgs).toEqual({ argCount: 2 })
    expect(safe.payload.customEnv).toEqual({})
  })

  it('passes allowed informational events with their payloads', () => {
    for (const type of ['message.delta', 'session.changed', 'session.deleted', 'turn.completed', 'turn.cancelled', 'permission.resolved', 'queue.changed', 'usage.updated', 'quota.updated', 'daemon.health', 'events.replay.complete', 'replay.gap']) {
      const safe = redactEventForRemote({ type, payload: { sessionId: 's' } }) as Record<string, any>
      expect(safe?.type, type).toBe(type)
      expect(safe?.payload.sessionId, type).toBe('s')
    }
  })

  it('classifies every EVENT_POLICY entry as allow or drop', () => {
    for (const [type, policy] of Object.entries(EVENT_POLICY)) {
      expect(['allow', 'drop'], type).toContain(policy)
    }
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
