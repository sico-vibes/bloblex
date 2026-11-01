import type { JsonRecord, Session, Snapshot } from '../types'
import { entityNoun } from './vocabulary'
import { themeStyle } from '../blob/bitbots'
import { keysFor, sendRows, SHORTCUT_ACTIONS, type SendShortcut, type ShortcutBindings } from './shortcuts'

// Optional features. They used to live on an Experimental tab; each now sits on the Settings tab it belongs to
// (owner, 31 October 2026). The stored keys stay `experimental.<name>` so nobody's choices change.
export const EXPERIMENTS = [
  { name: 'changeReview', label: 'Change review', help: () => 'Keep or revert the files a turn changed, below its reply.' },
  { name: 'messageActions', label: 'Message actions', help: () => 'Reaction, Reply and Copy on a message, and Retry or Edit on a right-click.' },
  { name: 'search', label: 'Search all conversations', help: () => 'Search messages from the quick switcher. Archived conversations are left out.' },
  { name: 'autoTitles', label: 'Automatic titles', help: () => 'Name a conversation from its first prompt. Titles you set are kept.' },
  { name: 'undo', label: 'Undo', help: () => `Eight seconds to undo archiving a ${entityNoun(themeStyle())} or deleting a conversation.` },
  { name: 'shortcuts', label: 'Shortcut list', help: () => 'Opens with Ctrl+/ and from the profile menu.' },
  { name: 'resumeAfterUsageLimits', label: 'Resume after usage limits', help: () => 'Pick up a limited conversation once, when the provider\'s next window opens.' },
  { name: 'autoRetry', label: 'Automatic retry', help: () => 'After a temporary failure, send "Please continue." up to three times. Your message is never resent.' },
  { name: 'memory', label: 'Memory', help: () => `${entityNoun(themeStyle(), { plural: true, capital: true })} save and recall short notes across conversations. Shared notes wait for your approval.` },
  { name: 'approvalBadge', label: 'Taskbar badge', help: () => `Show waiting ${entityNoun(themeStyle(), { plural: true })} on the Windows taskbar and tray.` },
  { name: 'sidebarModel', label: 'Model and effort under the name', help: () => 'Shown in place of the last message while nothing is running.' },
  { name: 'botLock', label: 'Lock a bot', help: () => `Adds Lock to a ${entityNoun(themeStyle())}'s right-click menu. Nobody can change a locked ${entityNoun(themeStyle())}, the Manager included, until you unlock it.` },
] as const
export type ExperimentName = typeof EXPERIMENTS[number]['name']
export type Experiments = Record<ExperimentName, boolean>
/** On unless the owner turned them off: a stored `false` stays off, and no stored value means on. */
const ON_BY_DEFAULT = new Set<string>(['resumeAfterUsageLimits', 'memory', 'search', 'changeReview', 'undo', 'messageActions', 'autoTitles', 'autoRetry'])
export const DEFAULT_EXPERIMENTS = Object.fromEntries(EXPERIMENTS.map(({ name }) => [name, ON_BY_DEFAULT.has(name)])) as Experiments

export function filesUnderReply(session: Session, message: JsonRecord): JsonRecord[] {
  if (message.role !== 'assistant' || typeof message.turnId !== 'string') return []
  const turn = session.turns?.find((t) => t.id === message.turnId)
  const live = ['working', 'starting', 'running', 'cancelling', 'waiting_permission']
  if (turn ? live.includes(String(turn.state)) : live.includes(String(session.state))) return []
  const replies = (session.messages ?? []).filter((m) => m.role === 'assistant' && m.turnId === message.turnId)
  if (replies.at(-1)?.id !== message.id) return []
  return (session.files ?? []).filter((f) => f.turnId === message.turnId)
}

export function waitingBlobCount(snapshot: Snapshot | null, now: number): number {
  const sessions = snapshot?.sessions ?? []
  const active = new Set((snapshot?.agents ?? []).filter((a) => !a.archived).map((a) => a.id))
  const waiting = new Set<string>()
  for (const p of snapshot?.permissions ?? []) {
    if (p.status !== 'pending' || (typeof p.expiresAt === 'string' && Date.parse(p.expiresAt) <= now)) continue
    const session = sessions.find((s) => s.id === p.sessionId)
    if (session?.agentId && active.has(session.agentId)) waiting.add(session.agentId)
  }
  for (const session of sessions) if (session.state === 'waiting_permission' && session.agentId && active.has(session.agentId)) waiting.add(session.agentId)
  return waiting.size
}

export function shortcutRows(speechEnabled: boolean, bindings: ShortcutBindings = {}, sendShortcut: SendShortcut = 'enter') {
  const bound = SHORTCUT_ACTIONS.flatMap((action) => { const keys = keysFor(action.id, bindings); return keys ? [[keys === 'Ctrl+K' ? 'Ctrl+K / ⌘K' : keys, action.label]] : [] })
  const [send, newLine] = sendRows(sendShortcut)
  return [
    ...bound,
    ...(speechEnabled ? [['Ctrl+E', 'Start or stop dictation']] : []),
    ['Ctrl+Alt+B', 'Show or hide companion (when its shortcut is enabled)'],
    [send[0], `${send[1]}; Enter also chooses a highlighted mention or reference`],
    newLine,
    ['@', 'Mention a teammate in the composer'],
    ['#', 'Reference a side conversation in the composer'],
    ['↑ / ↓', 'Navigate switcher, mention and reference results'],
    ['Tab', 'Choose a highlighted mention or reference'],
    ['Esc', 'Close a dialog, menu, mention or reference picker'],
  ]
}
