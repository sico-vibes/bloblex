import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BlobCanvas } from '../blob/BlobCanvas'
import { hexToRGB } from '../blob/blobEngine'
import { drawGreetingScene, GREETING_BODY, GREETING_END_MS, GREETING_GROWN_MS, GREETING_REFERENCE } from '../blob/greetingScene'
import { agentColorHex } from './agentColor'
import type { Agent, Runtime } from '../types'
import { type LaunchCheck } from './launchChecks'
import { ProviderLogo } from './providerBrand'

/** The working mascot's canvas size; the greeting is scaled so the body matches it. */
const STAGE_SIZE = 150
const GREETING_SCALE = (STAGE_SIZE * 0.4) / GREETING_BODY.radius

type Phase = 'scanning' | 'greeting' | 'ready'

/**
 * Startup checks. The mascot works while Bloblex looks for coding agents,
 * then waves hello once everything is ready; the checks scroll inside a fixed
 * window whose edges fade into the background.
 */
export function LaunchIntro({ checks, runtimes, agent = null, onComplete, onRetry, onContinueOffline, serviceDown, autoComplete = true }: {
  checks: LaunchCheck[]; runtimes: Runtime[]; agent?: Agent | null; onComplete: () => void; onRetry: () => void; onContinueOffline: () => void; serviceDown: boolean; autoComplete?: boolean
}) {
  const completed = useRef(false)
  const onCompleteRef = useRef(onComplete)
  const completionTimer = useRef<number | null>(null)
  const finished = checks.length > 0 && checks.every((check) => check.state !== 'running')
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const [phase, setPhase] = useState<Phase>('scanning')
  const color = agent ? agentColorHex(agent.color) : '#b7a7f4'
  useEffect(() => { onCompleteRef.current = onComplete }, [onComplete])

  const complete = () => {
    if (completed.current) return
    completed.current = true
    onCompleteRef.current()
  }

  useEffect(() => {
    if (!finished || serviceDown) { setPhase('scanning'); return }
    if (!reducedMotion) { setPhase((current) => current === 'scanning' ? 'greeting' : current); return }
    setPhase('ready')
  }, [finished, serviceDown, reducedMotion])

  // Without the greeting (reduced motion), finish shortly after the last check settles.
  useEffect(() => {
    if (!autoComplete || phase !== 'ready' || !reducedMotion || serviceDown || completed.current) return
    const timer = window.setTimeout(() => {
      completionTimer.current = null
      complete()
    }, 220)
    completionTimer.current = timer
    return () => {
      window.clearTimeout(timer)
      if (completionTimer.current === timer) completionTimer.current = null
    }
  }, [autoComplete, phase, reducedMotion, serviceDown])

  const greetingDone = () => {
    setPhase('ready')
    if (autoComplete && !serviceDown) complete()
  }
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
  const running = checks.find((check) => check.state === 'running')
  const status = serviceDown ? 'Bloblex could not connect to its service.' : finished ? 'Ready for your next conversation.' : running?.label ?? 'Getting Bloblex ready…'
  return <main className={`launch-intro${reducedMotion ? ' reduced-motion' : ''}`} data-phase={phase} aria-label="Bloblex launch checks" onPointerDown={() => { if (phase === 'greeting' && autoComplete) complete() }}>
    <section className="launch-intro-content">
      {!reducedMotion && <div className="launch-blob-stage">
        {phase === 'greeting'
          ? <LaunchGreeting color={color} onDone={greetingDone} />
          : <BlobCanvas color={color} size={STAGE_SIZE} mood={serviceDown ? 'error' : phase === 'ready' ? 'idle' : 'working'} label={agent?.name ?? 'Bloblex'} />}
      </div>}
      <p className="launch-status" role="status" aria-live="polite">{status}</p>
      <LaunchChecklist checks={checks} names={names} />
      {serviceDown && <div className="launch-actions"><button className="primary-button" onClick={retry}>Retry</button><button className="secondary-button" onClick={continueOffline}>Continue offline</button></div>}
    </section>
  </main>
}

/** Checks scroll inside a fixed window; the one in progress stays in view. */
function LaunchChecklist({ checks, names }: { checks: LaunchCheck[]; names: Map<string, string> }) {
  const windowRef = useRef<HTMLDivElement>(null)
  const focusIndex = Math.max(0, checks.findIndex((check) => check.state === 'running'))
  const focus = checks.some((check) => check.state === 'running') ? focusIndex : checks.length - 1
  useLayoutEffect(() => {
    const box = windowRef.current
    const row = box?.querySelectorAll<HTMLElement>('li')[focus]
    if (!box || !row) return
    const target = Math.max(0, row.offsetTop - (box.clientHeight - row.offsetHeight) / 2)
    if (typeof box.scrollTo === 'function') box.scrollTo({ top: target, behavior: 'smooth' })
    else box.scrollTop = target
  }, [focus, checks.length])
  return <div className="launch-checklist-window" ref={windowRef}>
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
  </div>
}

/** The companion's welcome wave, without its island card, continuing from the full-size mascot. */
function LaunchGreeting({ color, onDone }: { color: string; onDone: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const doneRef = useRef(onDone)
  useEffect(() => { doneRef.current = onDone }, [onDone])
  // Three reference heights tall, so the halo has room to fade out instead of meeting the canvas edge.
  const width = GREETING_REFERENCE.width * GREETING_SCALE
  const height = GREETING_REFERENCE.height * GREETING_SCALE * 3
  const bodyTop = (height - GREETING_REFERENCE.height * GREETING_SCALE) / 2 + GREETING_BODY.y * GREETING_SCALE
  useEffect(() => {
    const element = canvas.current
    const ctx = element?.getContext('2d')
    if (!element || !ctx) { const timer = window.setTimeout(() => doneRef.current(), GREETING_END_MS - GREETING_GROWN_MS); return () => window.clearTimeout(timer) }
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    element.width = Math.round(width * ratio)
    element.height = Math.round(height * ratio)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    const rgb = hexToRGB(color)
    const start = performance.now()
    let frame = 0
    const draw = (now: number) => {
      const age = Math.min(GREETING_END_MS, GREETING_GROWN_MS + now - start)
      drawGreetingScene(ctx, width, height, age, rgb, { bare: true })
      if (age >= GREETING_END_MS) { doneRef.current(); return }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [color, width, height])
  return <canvas ref={canvas} className="launch-greeting" aria-label="Bloblex waves hello" role="img" style={{
    width, height,
    left: `calc(50% - ${GREETING_BODY.x * GREETING_SCALE}px)`,
    top: `calc(50% - ${bodyTop}px)`,
  }} />
}

export function LaunchWarnings({ warnings, onSettings, onDismiss }: { warnings: string[]; onSettings: () => void; onDismiss: () => void }) {
  if (!warnings.length) return null
  return <aside className="launch-warning-notice" role="status"><span>Startup checks need attention: {warnings.join('; ')}.</span><button className="secondary-button small" onClick={onSettings}>Agents settings</button><button className="icon-button small" aria-label="Dismiss agent notice" onClick={onDismiss}>×</button></aside>
}
