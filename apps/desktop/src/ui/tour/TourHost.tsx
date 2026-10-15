import { useCallback, useEffect, useMemo, useState } from 'react'
import { BlobCanvas } from '../../blob/BlobCanvas'
import { useThemeStyle } from '../../blob/bitbots'
import { TOUR_VERSION, setTourState, useTourState } from '../uiPrefs'
import { entityNoun } from '../vocabulary'
import { GuidedTour, TourInvite, type TourEnd } from './GuidedTour'
import { tourSteps } from './tourSteps'
import { anchorSelector } from './useAnchorRect'
import { START_TOUR_EVENT } from './startTour'

/**
 * Owns when the tour appears. It auto-starts once right after first-run
 * onboarding, offers itself (never forces itself) to people who already use the
 * app, and can be replayed at any time. It waits for the composer to exist, so a
 * tour never starts over an empty window, and it never runs while `enabled` is
 * false (launch screen, a dialog, the companion window).
 */
export function TourHost({ enabled, justOnboarded, agentColor }: { enabled: boolean; justOnboarded: boolean; agentColor: string }) {
  const state = useTourState()
  const look = useThemeStyle()
  const noun = entityNoun(look)
  const plural = entityNoun(look, { plural: true })
  const steps = useMemo(() => tourSteps(noun, plural), [noun, plural])
  const [running, setRunning] = useState(false)
  const [step, setStep] = useState(0)
  const [composerReady, setComposerReady] = useState(false)
  const finished = state.done && state.version >= TOUR_VERSION

  useEffect(() => {
    if (!enabled || finished || running) { setComposerReady(false); return }
    const check = () => setComposerReady(Boolean(document.querySelector(anchorSelector('composer'))))
    check()
    const timer = window.setInterval(check, 500)
    return () => window.clearInterval(timer)
  }, [enabled, finished, running])

  const begin = useCallback(() => {
    setStep(0)
    setTourState({ step: 0 })
    setRunning(true)
  }, [])

  // Right after onboarding the tour starts by itself, once the composer is on screen.
  useEffect(() => {
    if (enabled && justOnboarded && !finished && !running && composerReady) {
      const timer = window.setTimeout(begin, 700)
      return () => window.clearTimeout(timer)
    }
  }, [enabled, justOnboarded, finished, running, composerReady, begin])

  // Replay request from the profile menu.
  useEffect(() => {
    const onStart = () => { if (enabled) begin() }
    window.addEventListener(START_TOUR_EVENT, onStart)
    return () => window.removeEventListener(START_TOUR_EVENT, onStart)
  }, [enabled, begin])

  const finish = (reason: TourEnd) => {
    void reason
    setRunning(false)
    setTourState({ done: true, version: TOUR_VERSION, step: 0 })
  }

  if (!enabled) return null
  if (running) {
    return <GuidedTour steps={steps} step={step}
      onStep={(next) => { setStep(next); setTourState({ step: next }) }}
      onFinish={finish}
      avatar={<BlobCanvas color={agentColor} size={30} mini decorative label="Tour guide" />} />
  }
  // People who already use the app are invited, not interrupted.
  if (!finished && !justOnboarded && composerReady) {
    return <TourInvite plural={plural} onStart={begin} onDismiss={() => setTourState({ done: true, version: TOUR_VERSION, step: 0 })} />
  }
  return null
}
