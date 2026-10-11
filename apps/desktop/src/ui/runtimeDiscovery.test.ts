// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LAUNCH_TIMEOUTS, runLaunchChecks } from './launchChecks'
import { DISCOVERY_BACKOFF, DISCOVERY_TIMEOUT, RuntimeDiscovery, runtimeProbeDetail } from './runtimeDiscovery'

const runtimes = [{ id: 'codex', provider: 'codex' }]
const scans: RuntimeDiscovery[] = []
function discovery(work: () => Promise<typeof runtimes>) {
  const found = vi.fn(), change = vi.fn()
  const scan = new RuntimeDiscovery(work, found, change)
  scans.push(scan)
  return { scan, found, change }
}
afterEach(() => { scans.splice(0).forEach((scan) => scan.dispose()); vi.useRealTimers() })

describe('coding agent discovery recovery', () => {
  it('lets startup continue on timeout, retries after 3 seconds and accepts recovery', async () => {
    vi.useFakeTimers()
    const work = vi.fn().mockImplementationOnce(() => new Promise(() => undefined)).mockResolvedValue(runtimes)
    const { scan, found } = discovery(work)
    const states = vi.fn()
    const checks = runLaunchChecks([
      { id: 'discovery', label: 'Finding coding agents', timeoutMs: LAUNCH_TIMEOUTS.discovery, run: async () => { await scan.scan(); return 'Found coding agents' } },
      { id: 'usage', label: 'Loading usage', timeoutMs: 1000, run: async () => 'Loaded usage' },
    ], states, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(DISCOVERY_TIMEOUT)
    expect(await checks).toMatchObject([{ id: 'discovery', state: 'failed' }, { id: 'usage', state: 'ok' }])
    expect(scan.status).toMatchObject({ scanning: false, retrying: true, failure: { step: 'Finding coding agents', message: 'Finding coding agents timed out.' } })
    await vi.advanceTimersByTimeAsync(2999)
    expect(work).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(work).toHaveBeenCalledTimes(2)
    expect(found).toHaveBeenCalledWith(runtimes)
    expect(scan.status).toMatchObject({ scanning: false, retrying: false, found: 1, failure: null })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses 3, 10 and 30 second backoff, stops after three retries and hides raw errors', async () => {
    vi.useFakeTimers()
    const work = vi.fn().mockRejectedValue(new Error('PRIVATE_PROVIDER_OUTPUT'))
    const { scan, change } = discovery(work)
    await expect(scan.scan()).rejects.toThrow('Could not complete the scan')
    for (const [index, delay] of DISCOVERY_BACKOFF.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(work).toHaveBeenCalledTimes(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(work).toHaveBeenCalledTimes(index + 2)
    }
    expect(scan.status).toMatchObject({ attempt: 3, scanning: false, retrying: false })
    expect(JSON.stringify(change.mock.calls)).not.toContain('PRIVATE_PROVIDER_OUTPUT')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(work).toHaveBeenCalledTimes(4)
  })

  it('coalesces clicks, replaces scheduled retries with a manual scan and ignores late replies', async () => {
    vi.useFakeTimers()
    let resolve!: (value: typeof runtimes) => void
    const late = new Promise<typeof runtimes>((done) => { resolve = done })
    const work = vi.fn().mockReturnValueOnce(late).mockResolvedValue(runtimes)
    const { scan, found } = discovery(work)
    const first = scan.scan()
    const failure = expect(first).rejects.toThrow('timed out')
    expect(scan.scan()).toBe(first)
    await vi.advanceTimersByTimeAsync(DISCOVERY_TIMEOUT)
    await failure
    await scan.scan()
    resolve([{ id: 'late', provider: 'claude' }])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(work).toHaveBeenCalledTimes(2)
    expect(found).toHaveBeenCalledTimes(1)
    expect(found).toHaveBeenCalledWith(runtimes)
  })

  it('retains partial rows and retries their safe failed probe', async () => {
    vi.useFakeTimers()
    const failed = { id: 'codex', provider: 'codex', probeStep: 'Protocol check', probeError: 'Probe timed out.' }
    const work = vi.fn().mockResolvedValueOnce([failed]).mockResolvedValue(runtimes)
    const { scan, found } = discovery(work)
    await expect(scan.scan()).rejects.toThrow('Codex · Protocol check: Probe timed out.')
    expect(found).toHaveBeenCalledWith([failed])
    expect(scan.status.failure?.step).toBe('Codex · Protocol check')
    await vi.advanceTimersByTimeAsync(3000)
    expect(scan.status.failure).toBeNull()
    expect(runtimeProbeDetail({ ...failed, probeError: 'PRIVATE_PROVIDER_OUTPUT' })?.message).toBe('The coding agent check failed.')
  })

  it('cancels recovery timers and in-flight callbacks on unmount', async () => {
    vi.useFakeTimers()
    const work = vi.fn().mockRejectedValue(new Error('offline'))
    const { scan, change } = discovery(work)
    await expect(scan.scan()).rejects.toThrow()
    scan.dispose()
    const changes = change.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(work).toHaveBeenCalledTimes(1)
    expect(change).toHaveBeenCalledTimes(changes)
    expect(vi.getTimerCount()).toBe(0)
  })
})
