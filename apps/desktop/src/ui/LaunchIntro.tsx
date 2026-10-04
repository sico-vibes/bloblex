import { useEffect, useRef, useState } from 'react'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentColorHex } from './agentColor'
import type { Agent, Runtime } from '../types'
import { LAUNCH_TIMEOUTS, type LaunchCheck } from './launchChecks'

export function LaunchIntro({ checks, runtimes, agent = null, onComplete, onRetry, onContinueOffline, serviceDown }: {
  checks: LaunchCheck[]; runtimes: Runtime[]; agent?: Agent | null; onComplete: () => void; onRetry: () => void; onContinueOffline: () => void; serviceDown: boolean
}) {
  const [greetingDone, setGreetingDone] = useState(false)
  const completed = useRef(false)
  const onCompleteRef = useRef(onComplete)
  const completionTimer = useRef<number | null>(null)
  const finished = checks.length > 0 && checks.every((check) => check.state !== 'running')
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  useEffect(() => { onCompleteRef.current = onComplete }, [onComplete])
  useEffect(() => {
    if (reducedMotion) setGreetingDone(true)
  }, [reducedMotion])
  useEffect(() => {
    if (greetingDone) return
    const timer = window.setTimeout(() => setGreetingDone(true), LAUNCH_TIMEOUTS.overall)
    return () => window.clearTimeout(timer)
  }, [greetingDone])
  useEffect(() => {
    if (!finished || !greetingDone || serviceDown || completed.current) return
    const timer = window.setTimeout(() => {
      completionTimer.current = null
      if (completed.current) return
      completed.current = true
      onCompleteRef.current()
    }, 220)
    completionTimer.current = timer
    return () => {
      window.clearTimeout(timer)
      if (completionTimer.current === timer) completionTimer.current = null
    }
  }, [finished, greetingDone, serviceDown])
  const continueOffline = () => {
    if (completionTimer.current !== null) window.clearTimeout(completionTimer.current)
    completionTimer.current = null
    completed.current = true
    onContinueOffline()
  }
  const retry = () => {
    if (completionTimer.current !== null) window.clearTimeout(completionTimer.current)
    completionTimer.current = null
    completed.current = false
    onRetry()
  }
  const names = new Map(runtimes.map((runtime) => [runtime.id, runtime.provider]))
  return <main className={reducedMotion ? 'launch-intro reduced-motion' : 'launch-intro'} aria-label="Bloblex launch checks"><section className="launch-intro-content">
    {!reducedMotion && <BlobCanvas color={agent ? agentColorHex(agent.color) : '#b7a7f4'} size={300} mood={finished ? 'idle' : 'thinking'} greeting outfit={agent?.outfit ?? 'auto'} createdAt={agent?.createdAt ?? null} onGreetingComplete={() => setGreetingDone(true)} label={agent?.name ?? 'Bloblex greeting'} />}
    <p className="launch-status" role="status" aria-live="polite">{serviceDown ? 'Bloblex could not connect to its service.' : finished ? 'Ready for your next conversation.' : checks.find((check) => check.state === 'running')?.label ?? 'Getting Bloblex ready…'}</p>
    <ol className="launch-checklist" aria-label="Startup checks">{checks.map((check) => <li key={check.id} data-state={check.state}><span className="launch-check-mark" aria-hidden="true">{check.state === 'running' ? '·' : check.state === 'ok' ? '✓' : check.state === 'warning' ? '!' : '×'}</span><span><strong>{check.label}</strong><small>{check.detail.startsWith('runtime:') ? (names.get(check.detail.slice(8)) ?? 'Coding agent') + ' found' : check.detail.startsWith('models:') ? (names.get(check.detail.slice(7)) ?? 'Coding agent') + ' models unavailable' : check.detail}</small></span></li>)}</ol>
    {serviceDown && <div className="launch-actions"><button className="primary-button" onClick={retry}>Retry</button><button className="secondary-button" onClick={continueOffline}>Continue offline</button></div>}
  </section></main>
}

export function LaunchWarnings({ warnings, onSettings, onDismiss }: { warnings: string[]; onSettings: () => void; onDismiss: () => void }) {
  if (!warnings.length) return null
  return <aside className="launch-warning-notice" role="status"><span>Startup checks need attention: {warnings.join('; ')}.</span><button className="secondary-button small" onClick={onSettings}>Agents settings</button><button className="icon-button small" aria-label="Dismiss agent notice" onClick={onDismiss}>×</button></aside>
}
