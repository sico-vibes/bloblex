// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { LAUNCH_TIMEOUTS, launchWarningsFor, runLaunchChecks } from './launchChecks'

describe('runLaunchChecks', () => {
  it('runs checks in order and reports each completed state', async () => {
    const order: string[] = []
    const updates: Array<Array<{ id: string; state: string }>> = []
    const controller = new AbortController()
    const result = await runLaunchChecks([
      { id: 'service', label: 'Service', timeoutMs: LAUNCH_TIMEOUTS.service, run: async () => { order.push('service'); return 'Connected' } },
      { id: 'discovery', label: 'Discovery', timeoutMs: LAUNCH_TIMEOUTS.discovery, run: async () => { order.push('discovery'); return 'Warning: no runtimes' } },
    ], (checks) => updates.push(checks), controller.signal)
    expect(order).toEqual(['service', 'discovery'])
    expect(result.map((check) => check.state)).toEqual(['ok', 'warning'])
    expect(updates.at(-1)?.map((check) => check.state)).toEqual(['ok', 'warning'])
  })

  it('marks a timeout as failed and continues to the next check', async () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    const controller = new AbortController()
    const checks = runLaunchChecks([
      { id: 'slow', label: 'Slow check', timeoutMs: 5, run: () => new Promise<string>(() => undefined) },
      { id: 'next', label: 'Next check', timeoutMs: 50, run: async () => 'Ready' },
    ], onChange, controller.signal)
    await vi.advanceTimersByTimeAsync(6)
    await vi.advanceTimersByTimeAsync(1)
    expect((await checks).map((check) => check.state)).toEqual(['failed', 'ok'])
    vi.useRealTimers()
  })

  it('stops the sequence and clears its timer when the attempt is aborted', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const onChange = vi.fn()
    const later = vi.fn(async () => 'Should not run')
    const result = runLaunchChecks([
      { id: 'discovery', label: 'Discovery', timeoutMs: 1_000, run: (_signal) => new Promise<string>(() => undefined) },
      { id: 'usage', label: 'Usage', timeoutMs: 1_000, run: later },
    ], onChange, controller.signal)
    controller.abort()
    await expect(result).resolves.toHaveLength(1)
    expect(later).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0]?.[0]).toMatchObject([{ id: 'discovery', state: 'running' }])
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('summarizes every failed or warning startup check in the notice', () => {
    expect(launchWarningsFor([
      { id: 'auth:r1', label: 'Sign-in', state: 'failed', detail: 'Version unavailable' },
      { id: 'discovery', label: 'Discovery', state: 'failed', detail: 'Finding coding agents timed out.' },
      { id: 'models:r1', label: 'Models', state: 'warning', detail: 'Warning: no models were returned.' },
      { id: 'usage', label: 'Usage', state: 'failed', detail: 'Usage timed out.' },
      { id: 'overall', label: 'Overall limit', state: 'failed', detail: 'Startup checks reached their overall time limit.' },
      { id: 'service', label: 'Service', state: 'ok', detail: 'Connected' },
    ])).toEqual([
      'Version unavailable',
      'Finding coding agents timed out.',
      'no models were returned.',
      'Usage timed out.',
      'Startup checks reached their overall time limit.',
    ])
  })
})
