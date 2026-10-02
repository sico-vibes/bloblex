import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(), emit: vi.fn() }))

import { permissionsPolicyGet, runtimeModels } from './tauri'

beforeEach(() => invoke.mockReset())

describe('permissions policy bridge', () => {
  it('calls permissions.policy.get and drops unknown fields', async () => {
    invoke.mockResolvedValue({ defaultMode: 'auto', perAgent: [{ agentId: 'a-1', mode: 'bypass', effectiveMode: 'bypass' }], token: 'no' })
    const policy = await permissionsPolicyGet()
    expect(invoke).toHaveBeenCalledWith('daemon_rpc', { method: 'permissions.policy.get', params: {} })
    expect(policy).toEqual({ defaultMode: 'auto', perAgent: [{ agentId: 'a-1', mode: 'bypass', effectiveMode: 'bypass' }] })
    expect(policy).not.toHaveProperty('token')
  })

  it('requests a catalog refresh only when asked', async () => {
    invoke.mockResolvedValue({})
    await runtimeModels('rt-1', true)
    expect(invoke).toHaveBeenCalledWith('daemon_rpc', { method: 'runtime.models', params: { runtimeId: 'rt-1', refresh: true } })
  })
})
