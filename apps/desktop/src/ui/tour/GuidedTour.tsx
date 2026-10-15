import { useEffect, useId, useRef, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import { Coachmark } from './Coachmark'
import { useAnchorRect } from './useAnchorRect'
import type { TourStep } from './tourSteps'

export type TourEnd = 'done' | 'skipped'

export interface GuidedTourProps {
  steps: TourStep[]
  /** Index of the current step. */
  step: number
  onStep: (index: number) => void
  onFinish: (reason: TourEnd) => void
  /** A small character shown in the card header so the guide has a face. */
  avatar?: ReactNode
}

/** How long a missing anchor is waited for before the step is skipped. */
const MISSING_ANCHOR_MS = 700

/**
 * The first-run tour: a spotlight on one element at a time and a card that
 * points at it. It never acts for the person; "Next" only moves to the next
 * pointer. Steps whose element is not on screen are skipped. Escape skips the
 * whole tour, the arrow keys move between steps.
 */
export function GuidedTour({ steps, step, onStep, onFinish, avatar }: GuidedTourProps) {
  const current = steps[Math.min(Math.max(step, 0), steps.length - 1)]
  const rect = useAnchorRect(current?.anchor ?? null, { scrollIntoView: true })
  const titleId = useId()
  const bodyId = useId()
  const nextButton = useRef<HTMLButtonElement>(null)
  const direction = useRef<1 | -1>(1)
  const index = steps.indexOf(current)
  const last = index === steps.length - 1

  const go = (delta: 1 | -1) => {
    direction.current = delta
    const target = index + delta
    if (target >= steps.length) { onFinish('done'); return }
    if (target < 0) return
    onStep(target)
  }

  // A step whose anchor never appears is skipped in the direction of travel.
  useEffect(() => {
    if (!current || rect) return
    const timer = window.setTimeout(() => {
      const target = index + direction.current
      if (target >= steps.length) onFinish('done')
      else if (target < 0) onFinish('skipped')
      else onStep(target)
    }, MISSING_ANCHOR_MS)
    return () => window.clearTimeout(timer)
  }, [current, rect, index, steps.length, onStep, onFinish])

  useEffect(() => { if (rect) nextButton.current?.focus({ preventScroll: true }) }, [index, Boolean(rect)])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onFinish('skipped') }
      else if (event.key === 'ArrowRight') { event.preventDefault(); go(1) }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); go(-1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!current) return null
  return <Coachmark target={rect} placement={current.placement} spotlight modal labelledBy={titleId} describedBy={bodyId} className="tour">
    <div className="coach-head">
      {avatar && <span className="coach-avatar" aria-hidden="true">{avatar}</span>}
      <span className="coach-count" aria-live="polite">{index + 1} of {steps.length}</span>
      <button type="button" className="coach-skip" onClick={() => onFinish('skipped')}>Skip tour</button>
    </div>
    <h2 id={titleId} className="coach-title">{current.title}</h2>
    <p id={bodyId} className="coach-body">{current.body}</p>
    {current.tip && <p className="coach-tip">{current.tip}</p>}
    <div className="coach-foot">
      <span className="coach-dots" aria-hidden="true">{steps.map((item, dot) => <i key={item.id} className={dot === index ? 'on' : dot < index ? 'past' : ''} />)}</span>
      <span className="coach-actions">
        {index > 0 && <button type="button" className="ghost-button small" onClick={() => go(-1)}><ArrowLeft size={13} />Back</button>}
        <button ref={nextButton} type="button" className="primary-button small" onClick={() => go(1)}>{last ? <><Check size={13} />Done</> : <>Next<ArrowRight size={13} /></>}</button>
      </span>
    </div>
  </Coachmark>
}

/**
 * The invitation shown to people who already use the app: a small card in the
 * corner, never in the way, that starts the tour or goes away for good.
 */
export function TourInvite({ plural, onStart, onDismiss }: { plural: string; onStart: () => void; onDismiss: () => void }) {
  const titleId = useId()
  return <aside className="tour-invite" role="complementary" aria-labelledby={titleId}>
    <h2 id={titleId}>Take a one-minute tour?</h2>
    <p>Five quick stops that show where your {plural}, the composer and the controls live.</p>
    <div className="coach-actions">
      <button type="button" className="ghost-button small" onClick={onDismiss}>Not now</button>
      <button type="button" className="primary-button small" onClick={onStart}>Start tour</button>
    </div>
  </aside>
}
