import { useCallback, useEffect, useRef, useState } from 'react'
import type { Runtime } from '../types'
import { rpc } from '../tauri'
import { withTimeout } from './launchChecks'
import { providerBrand } from './providerBrand'

export const DISCOVERY_BACKOFF = [3_000, 10_000, 30_000] as const
export const DISCOVERY_TIMEOUT = 30_000
export type DiscoveryStatus = {
  scanning: boolean; retrying: boolean; attempt: number; found: number; completedAt: number | null
  failure: { step: string; message: string; at: number } | null
}
export const EMPTY_DISCOVERY_STATUS: DiscoveryStatus = { scanning: false, retrying: false, attempt: 0, found: 0, completedAt: null, failure: null }
const SAFE_PROBE_ERRORS = new Set(['Could not start the coding agent.', 'Could not supervise the coding agent.', 'Could not read the probe result.', 'Probe timed out.', 'Probe exited unsuccessfully.', 'The CLI does not advertise the required protocol.', 'Could not start the sign-in check.', 'Could not supervise the sign-in check.', 'Could not read the sign-in result.', 'Sign-in check timed out.', 'Sign-in status could not be checked.'])
export function runtimeProbeDetail(runtime: Runtime) {
  if (!runtime.probeError) return null
  const step = ['Version check', 'Protocol check', 'Sign-in check'].includes(runtime.probeStep ?? '') ? runtime.probeStep : 'Probe'
  const message = SAFE_PROBE_ERRORS.has(runtime.probeError) ? runtime.probeError : 'The coding agent check failed.'
  return { step: providerBrand(runtime.provider).name + ' · ' + step, message }
}
export function discoveryResultText(status: DiscoveryStatus) {
  return 'Found ' + status.found + (status.found === 1 ? ' coding agent' : ' coding agents')
}
export function scanTime(at: number) {
  return Date.now() - at < 60_000 ? 'just now' : new Date(at).toLocaleString()
}
class ProbeFailure extends Error {
  constructor(readonly step: string, message: string) { super(message) }
}

/** One scan for launch, settings and retries; late replies cannot replace newer results. */
export class RuntimeDiscovery {
  status = { ...EMPTY_DISCOVERY_STATUS }
  private pending: Promise<Runtime[]> | null = null
  private timer: number | undefined
  private controller: AbortController | null = null
  private generation = 0
  private disposed = false
  constructor(private work: () => Promise<Runtime[]>, private onFound: (runtimes: Runtime[]) => void, private onChange: (status: DiscoveryStatus) => void) {}
  private publish(update: Partial<DiscoveryStatus>) {
    this.status = { ...this.status, ...update }
    this.onChange(this.status)
  }
  resume() { this.disposed = false }
  dispose() {
    this.disposed = true
    this.generation += 1
    window.clearTimeout(this.timer)
    this.controller?.abort()
    this.pending = null
  }
  scan = (attempt = 0): Promise<Runtime[]> => {
    if (this.pending) return this.pending
    window.clearTimeout(this.timer)
    const generation = ++this.generation
    const controller = new AbortController()
    this.controller = controller
    this.publish({ scanning: true, retrying: attempt > 0, attempt })
    const current = () => !this.disposed && generation === this.generation
    const run = async () => {
      try {
        const runtimes = await withTimeout(this.work(), DISCOVERY_TIMEOUT, 'Finding coding agents', controller.signal, () => controller.abort(new Error('Finding coding agents timed out.')))
        if (!current()) throw new DOMException('Scan cancelled.', 'AbortError')
        this.onFound(runtimes)
        const failed = runtimes.map(runtimeProbeDetail).find((detail) => detail !== null)
        if (failed) throw new ProbeFailure(failed.step, failed.message)
        this.publish({ scanning: false, retrying: false, found: runtimes.length, completedAt: Date.now(), failure: null })
        return runtimes
      } catch (error) {
        if (!current()) throw error
        const timedOut = controller.signal.aborted && controller.signal.reason instanceof Error && controller.signal.reason.message === 'Finding coding agents timed out.'
        const failure = { step: error instanceof ProbeFailure ? error.step : 'Finding coding agents', message: error instanceof ProbeFailure ? error.message : timedOut ? 'Finding coding agents timed out.' : 'Could not complete the scan. Check the Bitbots service and try again.', at: Date.now() }
        const retrying = attempt < DISCOVERY_BACKOFF.length
        this.publish({ scanning: false, retrying, failure, completedAt: Date.now() })
        if (retrying) this.timer = window.setTimeout(() => { if (current()) void this.scan(attempt + 1).catch(() => undefined) }, DISCOVERY_BACKOFF[attempt])
        throw new Error(failure.step + ': ' + failure.message)
      } finally {
        if (generation === this.generation) { this.pending = null; this.controller = null }
      }
    }
    this.pending = run()
    return this.pending
  }
}

export function useRuntimeDiscovery(onFound: (runtimes: Runtime[]) => void) {
  const [status, setStatus] = useState<DiscoveryStatus>(EMPTY_DISCOVERY_STATUS)
  const foundRef = useRef(onFound)
  foundRef.current = onFound
  const discoveryRef = useRef<RuntimeDiscovery | null>(null)
  if (!discoveryRef.current) discoveryRef.current = new RuntimeDiscovery(async () => {
    const result = await rpc<Runtime[] | { runtimes: Runtime[] }>('runtime.refresh')
    const runtimes = Array.isArray(result) ? result : result?.runtimes
    if (!Array.isArray(runtimes)) throw new Error('Invalid scan result')
    return runtimes
  }, (runtimes) => foundRef.current(runtimes), setStatus)
  useEffect(() => { const discovery = discoveryRef.current!; discovery.resume(); return () => discovery.dispose() }, [])
  const scan = useCallback(() => discoveryRef.current!.scan(), [])
  return { status, scan }
}
