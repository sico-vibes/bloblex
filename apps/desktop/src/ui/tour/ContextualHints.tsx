import { useEffect, useState } from 'react'
import { useThemeStyle } from '../../blob/bitbots'
import { useHintSeen } from '../uiPrefs'
import { entityNoun } from '../vocabulary'
import { Hint } from './Hint'
import { anchorSelector } from './useAnchorRect'

/** The hints in the order they win when more than one anchor is on screen. */
export const HINT_PRIORITY = ['approval.first', 'plan.first', 'context.high', 'team.first'] as const
type HintId = typeof HINT_PRIORITY[number]
const ANCHORS: Record<HintId, string> = {
  'approval.first': 'approval',
  'plan.first': '.plan-card',
  'context.high': 'context-ring-high',
  'team.first': '.team-chip',
}

/** Which anchors exist right now, polled twice a second (they come and go with React). */
function usePresence(enabled: boolean): Record<HintId, boolean> {
  const [present, setPresent] = useState<Record<HintId, boolean>>({ 'approval.first': false, 'plan.first': false, 'context.high': false, 'team.first': false })
  useEffect(() => {
    if (!enabled) return
    const check = () => {
      const next = Object.fromEntries(HINT_PRIORITY.map((id) => [id, Boolean(document.querySelector(anchorSelector(ANCHORS[id])))])) as Record<HintId, boolean>
      setPresent((previous) => HINT_PRIORITY.every((id) => previous[id] === next[id]) ? previous : next)
    }
    check()
    const timer = window.setInterval(check, 500)
    return () => window.clearInterval(timer)
  }, [enabled])
  return present
}

/** True while the guided tour (or any modal coach layer) is on screen. */
function useTourActive(enabled: boolean) {
  const [active, setActive] = useState(false)
  useEffect(() => {
    if (!enabled) { setActive(false); return }
    const check = () => setActive(Boolean(document.querySelector('.coach.modal')))
    check()
    const timer = window.setInterval(check, 400)
    return () => window.clearInterval(timer)
  }, [enabled])
  return active
}

/**
 * One-time pointers for the moments that matter: the first permission request,
 * the first plan, a nearly full context window and the first bot-to-bot message.
 * One hint at a time (highest priority first), each only when its anchor is on
 * screen, only once, and never over the guided tour. Dismissing marks it seen
 * on this device.
 */
export function ContextualHints({ enabled }: { enabled: boolean }) {
  const noun = entityNoun(useThemeStyle())
  const tourActive = useTourActive(enabled)
  const present = usePresence(enabled && !tourActive)
  const [approvalSeen, markApproval] = useHintSeen('approval.first')
  const [planSeen, markPlan] = useHintSeen('plan.first')
  const [contextSeen, markContext] = useHintSeen('context.high')
  const [teamSeen, markTeam] = useHintSeen('team.first')
  const seen: Record<HintId, boolean> = { 'approval.first': approvalSeen, 'plan.first': planSeen, 'context.high': contextSeen, 'team.first': teamSeen }
  const active = enabled && !tourActive ? HINT_PRIORITY.find((id) => present[id] && !seen[id]) ?? null : null
  return <>
    <Hint anchor={ANCHORS['approval.first']} when={active === 'approval.first'} seen={approvalSeen} onDismiss={markApproval} placement="top"
      title={`A ${noun} is asking permission`} body="Press Enter to allow this one request or Esc to deny it. Nothing runs until you choose." />
    <Hint anchor={ANCHORS['plan.first']} when={active === 'plan.first'} seen={planSeen} onDismiss={markPlan} placement="top"
      title="This is the plan" body="Read the steps first. Nothing changes until you approve, and you can reply with edits instead." />
    <Hint anchor={ANCHORS['context.high']} when={active === 'context.high'} seen={contextSeen} onDismiss={markContext} placement="top"
      title="Context is getting full" body="Long conversations get slower and cost more. Start a new conversation to keep answers sharp." />
    <Hint anchor={ANCHORS['team.first']} when={active === 'team.first'} seen={teamSeen} onDismiss={markTeam} placement="top"
      title={`${noun === 'bot' ? 'Bots' : 'Blobs'} can work together`} body={`This marks a message between ${noun}s. Open it to see what was asked and what came back.`} />
  </>
}
