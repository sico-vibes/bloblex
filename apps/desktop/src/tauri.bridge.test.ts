import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(), emit: vi.fn() }))

import { daemonAnalyticsWire } from './ui/analyticsFixtures'
import { execSnapshotLatest, fetchUsageAnalytics, permissionsPolicyGet, runtimeCapabilities, runtimeModels } from './tauri'

beforeEach(() => invoke.mockReset())

describe('permissions policy bridge', () => {
  it('calls permissions.policy.get and drops unknown fields', async () => {
    invoke.mockResolvedValue({ defaultMode: 'auto', perAgent: [{ agentId: 'a-1', mode: 'bypass', effectiveMode: 'bypass' }], token: 'no' })
    const policy = await permissionsPolicyGet()
    expect(invoke).toHaveBeenCalledWith('daemon_rpc', { method: 'permissions.policy.get', params: {} })
    expect(policy).toEqual({ defaultMode: 'auto', perAgent: [{ agentId: 'a-1', mode: 'bypass', effectiveMode: 'bypass' }] })
    expect(policy).not.toHaveProperty('token')
  })

  it('requests a catalog refresh only when asked and keeps catalog fields', async () => {
    invoke.mockResolvedValue({
      runtimeId: 'rt-1', provider: 'codex', fallback: false, source: 'app_server',
      fetchedAt: '2026-10-02T12:00:00.000Z', expiresAt: '2026-10-02T12:01:00.000Z',
      models: [{ id: 'alpha', displayName: 'Alpha', supportedThinking: [], defaultThinking: null, serviceTiers: [], defaultServiceTier: null, hostDependent: false }],
    })
    await runtimeModels('rt-1', true)
    expect(invoke).toHaveBeenCalledWith('daemon_rpc', { method: 'runtime.models', params: { runtimeId: 'rt-1', refresh: true } })
    invoke.mockResolvedValueOnce({
      runtimeId: 'rt-1', provider: 'codex', fallback: false, source: 'app_server',
      fetchedAt: '2026-10-02T12:00:00.000Z', expiresAt: '2026-10-02T12:01:00.000Z',
      models: [{ id: 'alpha', displayName: 'Alpha', supportedThinking: [], defaultThinking: null, serviceTiers: [], defaultServiceTier: null, hostDependent: false, secret: 'no' }],
    })
    const catalog = await runtimeModels('rt-1', false)
    expect(invoke).toHaveBeenLastCalledWith('daemon_rpc', { method: 'runtime.models', params: { runtimeId: 'rt-1' } })
    expect(catalog?.models[0]?.id).toBe('alpha')
    expect(JSON.stringify(catalog)).not.toContain('secret')
  })

  it('parses capabilities, the latest snapshot, and analytics through the bridge', async () => {
    invoke.mockResolvedValueOnce({
      runtimeId: 'rt-codex',
      settings: {
        model: { supported: true, enabled: true, scope: 'spawn', evidence: 'provider_echo' },
        customEnv: { supported: true, enabled: true, scope: 'process', evidence: 'request_shape', allowedKeys: ['TZ'] },
      },
      globalConcurrency: { limit: 4, active: 0 },
      agentConcurrency: { configuredMaxConcurrency: 1, effectiveMaxConcurrency: 1, active: 0 },
      agentConcurrencies: [],
      hostDependent: true,
    })
    const caps = await runtimeCapabilities('rt-codex', 'agent-1')
    expect(invoke).toHaveBeenCalledWith('daemon_rpc', { method: 'runtime.capabilities', params: { runtimeId: 'rt-codex', agentId: 'agent-1' } })
    expect(caps?.agentConcurrency?.effectiveMaxConcurrency).toBe(1)
    expect(caps?.agentConcurrencies).toEqual([])

    invoke.mockResolvedValueOnce(null)
    expect(await execSnapshotLatest('sess-1')).toBeNull()
    expect(invoke).toHaveBeenLastCalledWith('daemon_rpc', { method: 'exec.snapshot.latest', params: { sessionId: 'sess-1' } })

    invoke.mockResolvedValueOnce(daemonAnalyticsWire)
    const analytics = await fetchUsageAnalytics({ from: '2026-03-28T00:00:00.000Z', to: '2026-03-31T00:00:00.000Z', bucket: 'day', tz: 'Europe/London' })
    expect(analytics.errors[1]?.failureClass).toBe('context')
    expect(JSON.stringify(analytics)).not.toContain('SECRET_PROMPT')
    invoke.mockResolvedValueOnce({ nope: true })
    await expect(fetchUsageAnalytics({ from: '2026-03-28T00:00:00.000Z', to: '2026-03-31T00:00:00.000Z', bucket: 'day', tz: 'Europe/London' })).rejects.toThrow(/internal/)
  })
})
