import { useEffect, useRef } from 'react'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentColorHex } from './agentColor'
import type { Agent, Runtime } from '../types'
import { type LaunchCheck } from './launchChecks'
import { ProviderLogo } from './providerBrand'

export function LaunchIntro({ checks, runtimes, agent = null, onComplete, onRetry, onContinueOffline, serviceDown, autoComplete = true }: {
  checks: LaunchCheck[]; runtimes: Runtime[]; agent?: Agent | null; onComplete: () => void; onRetry: () => void; onContinueOffline: () => void; serviceDown: boolean; autoComplete?: boolean
}) {
  const completed = useRef(false)
  const onCompleteRef = useRef(onComplete)
  const completionTimer = useRef<number | null>(null)
  const finished = checks.length > 0 && checks.every((check) => check.state !== 'running')
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  useEffect(() => { onCompleteRef.current = onComplete }, [onComplete])
  useEffect(() => {
    if (!autoComplete || !finished || serviceDown || completed.current) return
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
  }, [autoComplete, finished, serviceDown])
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
    {!reducedMotion && <div className="launch-blob-stage"><BlobCanvas color={agent ? agentColorHex(agent.color) : '#b7a7f4'} size={168} mood={finished ? 'idle' : 'thinking'} outfit={agent?.outfit ?? 'auto'} createdAt={agent?.createdAt ?? null} label={agent?.name ?? 'Bloblex greeting'} /></div>}
    <p className="launch-status" role="status" aria-live="polite">{serviceDown ? 'Bloblex could not connect to its service.' : finished ? 'Ready for your next conversation.' : checks.find((check) => check.state === 'running')?.label ?? 'Getting Bloblex ready…'}</p>
    <ol className="launch-checklist" aria-label="Startup checks">{checks.map((check) => {
      const provider = check.id.startsWith('auth:') ? check.id.slice(5) : check.id.startsWith('models:') ? check.id.slice(7) : ''
      const providerId = names.get(provider)
      const stateMark = check.state === 'ok' ? '✓' : check.state === 'warning' ? '!' : '×'
      const detail = check.detail.startsWith('runtime:') ? (names.get(check.detail.slice(8)) ?? 'Coding agent') + ' found' : check.detail.startsWith('models:') ? (names.get(check.detail.slice(7)) ?? 'Coding agent') + ' models unavailable' : check.detail
      return <li key={check.id} data-state={check.state}>
        <span className={`launch-check-icon ${providerId ? 'has-provider' : ''}`} aria-hidden="true">
          {providerId ? <><ProviderLogo provider={providerId} size={16} /><span className="launch-state-indicator">{check.state === 'running' ? <i className="launch-spinner" /> : stateMark}</span></> : check.state === 'running' ? <i className="launch-spinner" /> : <span className="launch-state-mark">{stateMark}</span>}
        </span>
        <span className="launch-check-copy"><strong>{check.label}</strong><small>{detail}</small></span>
      </li>
    })}</ol>
    {serviceDown && <div className="launch-actions"><button className="primary-button" onClick={retry}>Retry</button><button className="secondary-button" onClick={continueOffline}>Continue offline</button></div>}
  </section></main>
}

export function LaunchWarnings({ warnings, onSettings, onDismiss }: { warnings: string[]; onSettings: () => void; onDismiss: () => void }) {
  if (!warnings.length) return null
  return <aside className="launch-warning-notice" role="status"><span>Startup checks need attention: {warnings.join('; ')}.</span><button className="secondary-button small" onClick={onSettings}>Agents settings</button><button className="icon-button small" aria-label="Dismiss agent notice" onClick={onDismiss}>×</button></aside>
}
