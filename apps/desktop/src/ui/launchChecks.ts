export type LaunchCheckState = 'running' | 'ok' | 'warning' | 'failed'
export type LaunchCheck = { id: string; label: string; state: LaunchCheckState; detail: string }
export type LaunchStep = { id: string; label: string; timeoutMs: number; run: (signal: AbortSignal) => Promise<string> }

export const LAUNCH_TIMEOUTS = { service: 12_000, discovery: 12_000, agent: 1_000, models: 10_000, usage: 8_000, overall: 90_000 } as const
export const LAUNCH_OVERALL_TIMEOUT_REASON = 'launch-overall-timeout'

export function throwIfLaunchAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new DOMException('Launch check aborted.', 'AbortError')
}

export async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string, signal: AbortSignal, onTimeout: () => void): Promise<T> {
  throwIfLaunchAborted(signal)
  let timer: number | undefined
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('Launch check aborted.', 'AbortError'))
    if (signal.aborted) onAbort()
    else {
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    }
  })
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      onTimeout()
      reject(new Error(label + ' timed out.'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([work, timeout, aborted])
  } finally {
    if (timer !== undefined) window.clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

export async function runLaunchChecks(steps: LaunchStep[], onChange: (checks: LaunchCheck[]) => void, signal: AbortSignal, initial: LaunchCheck[] = []) {
  const checks = [...initial]
  const publish = () => onChange(checks.map((check) => ({ ...check })))
  const put = (check: LaunchCheck) => {
    const index = checks.findIndex((item) => item.id === check.id)
    if (index < 0) checks.push(check)
    else checks[index] = check
  }
  const failOverall = () => {
    for (const check of checks) {
      if (check.state === 'running') put({ ...check, state: 'failed', detail: 'Stopped at the overall startup time limit.' })
    }
    put({ id: 'overall', label: 'Overall startup time limit', state: 'failed', detail: 'Startup checks reached their overall time limit.' })
    publish()
  }
  for (const step of steps) {
    if (signal.aborted) {
      if (signal.reason === LAUNCH_OVERALL_TIMEOUT_REASON) failOverall()
      return checks
    }
    put({ id: step.id, label: step.label, state: 'running', detail: 'In progress' })
    publish()
    const stageController = new AbortController()
    const abortStage = () => stageController.abort(signal.reason)
    signal.addEventListener('abort', abortStage, { once: true })
    try {
      throwIfLaunchAborted(signal)
      const detail = await withTimeout(step.run(stageController.signal), step.timeoutMs, step.label, signal, () => stageController.abort(new Error(step.label + ' timed out.')))
      throwIfLaunchAborted(signal)
      put({ id: step.id, label: step.label, state: detail.startsWith('Warning:') ? 'warning' : 'ok', detail })
      publish()
    } catch (error) {
      if (signal.aborted) {
        if (signal.reason === LAUNCH_OVERALL_TIMEOUT_REASON) failOverall()
        return checks
      }
      put({ id: step.id, label: step.label, state: 'failed', detail: error instanceof Error ? error.message : 'This check could not be completed.' })
      publish()
    } finally {
      signal.removeEventListener('abort', abortStage)
      if (!stageController.signal.aborted) stageController.abort(new DOMException('Launch stage finished.', 'AbortError'))
    }
  }
  return checks
}

export function launchWarningsFor(checks: readonly LaunchCheck[], runtimes: readonly { id: string; provider: string; authState?: string }[] = []) {
  const details = checks
    .filter((check) => check.state === 'warning' || check.state === 'failed')
    .filter((check) => {
      if (!check.id.startsWith('auth:')) return true
      const runtimeId = check.id.slice(5)
      const runtime = runtimes.find((item) => item.id === runtimeId)
      if (runtime?.provider.toLowerCase() === 'opencode' && ['authenticated', 'signed_in'].includes(runtime.authState?.toLowerCase() ?? '')) return false
      return !checks.some((item) => item.id === `models:${runtimeId}` && item.state === 'ok')
    })
    .map((check) => check.detail.replace(/^Warning:\s*/, ''))
  const providers = new Map<string, string[]>()
  const other: string[] = []
  for (const detail of details) {
    const match = /^(Claude Code|Codex|OpenCode):\s*(.+)$/i.exec(detail)
    if (!match) { other.push(detail); continue }
    const name = match[1][0].toUpperCase() + match[1].slice(1)
    const message = match[2].replace(/[.\s]+$/, '')
    providers.set(name, [...(providers.get(name) ?? []), message])
  }
  return [...providers].map(([provider, messages]) => `${provider}: ${[...new Set(messages)].join('; ')}` ).concat(other)
}
