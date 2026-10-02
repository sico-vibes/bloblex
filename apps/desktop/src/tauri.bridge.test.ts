import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(), emit: vi.fn() }))

import { daemonAnalyticsWire } from './ui/analyticsFixtures'
import { execSnapshotLatest, fetchUsageAnalytics, listenForUpdateAvailable, listenForUpdateProgress, permissionsPolicyGet, runtimeCapabilities, runtimeModels, updatesCheck, updatesGetState, updatesInstall, updatesSetPreferences } from './tauri'
import { listen } from '@tauri-apps/api/event'

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

describe('updates bridge', () => {
  beforeEach(() => { vi.mocked(listen).mockReset() })

  it('calls the four updater commands with exact arguments and drops unknown fields', async () => {
    invoke.mockResolvedValueOnce({
      currentVersion: '0.1.0', channel: 'beta', autoCheck: true, lastCheckedAt: null, available: null, devBuild: false, token: 'SECRET_STATE',
    })
    const state = await updatesGetState()
    expect(invoke).toHaveBeenCalledWith('updates_get_state')
    expect(state).toEqual({ currentVersion: '0.1.0', channel: 'beta', autoCheck: true, lastCheckedAt: null, available: null, devBuild: false })
    expect(JSON.stringify(state)).not.toContain('SECRET_STATE')

    invoke.mockResolvedValueOnce(null)
    expect(await updatesGetState()).toBeNull()

    invoke.mockResolvedValueOnce({ currentVersion: '0.1.0', channel: 'stable', autoCheck: true, lastCheckedAt: null, available: null, devBuild: false, password: 'SECRET_PREF' })
    await updatesSetPreferences({ channel: 'stable' })
    expect(invoke).toHaveBeenLastCalledWith('updates_set_preferences', { channel: 'stable' })

    invoke.mockResolvedValueOnce({ currentVersion: '0.1.0', channel: 'stable', autoCheck: false, lastCheckedAt: null, available: null, devBuild: false })
    await updatesSetPreferences({ autoCheck: false })
    expect(invoke).toHaveBeenLastCalledWith('updates_set_preferences', { autoCheck: false })

    invoke.mockResolvedValueOnce({ currentVersion: '0.1.0', channel: 'beta', autoCheck: true, lastCheckedAt: null, available: null, devBuild: false })
    await updatesSetPreferences({ channel: 'nightly' as 'beta' })
    expect(invoke).toHaveBeenLastCalledWith('updates_set_preferences', {})

    invoke.mockResolvedValueOnce({ status: 'error', checkedAt: '2026-10-02T00:00:00.000Z', error: 'disk SECRET_STACK', message: 'SECRET_STACK' })
    const failed = await updatesCheck()
    expect(invoke).toHaveBeenCalledWith('updates_check')
    expect(failed).toEqual({ status: 'error', checkedAt: '2026-10-02T00:00:00.000Z' })
    expect(JSON.stringify(failed)).not.toContain('SECRET')

    invoke.mockRejectedValueOnce({ code: 'signature', message: 'bad sig SECRET_PATH' })
    const rejection = await updatesInstall().then(() => null, (error: unknown) => error)
    expect(invoke).toHaveBeenCalledWith('updates_install')
    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toBe('The update signature could not be verified.')
    expect((rejection as Error).message).not.toContain('SECRET_PATH')
  })

  it('listens for update events and ignores payloads that are not updates', async () => {
    let available: ((event: { payload: unknown }) => void) | undefined
    let progress: ((event: { payload: unknown }) => void) | undefined
    vi.mocked(listen).mockImplementation(((name: string, handler: (event: { payload: unknown }) => void) => {
      if (name === 'bloblex-update-available') available = handler
      if (name === 'bloblex-update-progress') progress = handler
      return Promise.resolve(() => undefined)
    }) as typeof listen)
    const seenInfo: unknown[] = []
    const seenProgress: unknown[] = []
    await listenForUpdateAvailable((info) => seenInfo.push(info))
    await listenForUpdateProgress((item) => seenProgress.push(item))
    expect(vi.mocked(listen).mock.calls.map((call) => call[0])).toEqual(['bloblex-update-available', 'bloblex-update-progress'])
    available?.({ payload: { version: '1.2.0', notes: null, pubDate: null, channel: 'stable', token: 'SECRET_EVENT' } })
    available?.({ payload: { nope: true } })
    available?.({ payload: null })
    progress?.({ payload: { phase: 'downloading', downloadedBytes: 5, totalBytes: null, token: 'SECRET_PROGRESS' } })
    progress?.({ payload: { phase: 'extracting', downloadedBytes: 1, totalBytes: 2 } })
    expect(seenInfo).toEqual([{ version: '1.2.0', notes: null, pubDate: null, channel: 'stable' }])
    expect(seenProgress).toEqual([{ phase: 'downloading', downloadedBytes: 5, totalBytes: null }])
    expect(JSON.stringify(seenInfo)).not.toContain('SECRET_EVENT')
    expect(JSON.stringify(seenProgress)).not.toContain('SECRET_PROGRESS')
  })
})
