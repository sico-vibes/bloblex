import type { JsonRecord, Session, Snapshot } from '../types'
import { entityNoun } from './vocabulary'
import { themeStyle } from '../blob/bitbots'

export const EXPERIMENTS = [
  { name: 'changeReview', label: 'Change review', hint: () => 'Review, keep or revert the files changed by a turn.', help: () => 'Shows saved file diffs below each completed reply. Keep dismisses a file. Revert confirms and reverses only a complete patch that still applies cleanly.' },
  { name: 'messageActions', label: 'Message actions', hint: () => 'React, reply to, or copy a user or assistant message.', help: () => 'Hover or focus a user or assistant message for Reaction, Reply and Copy. Reply quotes the selected message as untrusted context. Right-click a user message for Retry or Edit. Hidden in read-only side conversations.' },
  { name: 'search', label: 'Search all conversations', hint: () => 'Find messages across your saved, active conversations.', help: () => 'Choose Search messages in the quick switcher. Search returns up to 50 matching messages. Open a result to jump to its message. Archived conversations are excluded.' },
  { name: 'autoTitles', label: 'Automatic titles', hint: () => 'Name a main conversation from its first prompt.', help: () => `The first user prompt supplies a short title if the conversation still has the ${entityNoun(themeStyle())}’s default name. Custom titles and side conversations are preserved.` },
  { name: 'undo', label: 'Undo', hint: () => `Undo archiving a ${entityNoun(themeStyle())} or deleting a conversation for eight seconds.`, help: () => 'Conversation deletion is queued in the daemon database for eight seconds. Closing a window does not cancel it. Quitting ends Undo and finishes pending deletions; an unexpected exit is recovered on the next launch.' },
  { name: 'shortcuts', label: 'Shortcut sheet', hint: () => 'Open the keyboard shortcut list with Ctrl+/.', help: () => 'Adds Keyboard shortcuts to the profile menu and Ctrl+/ to open the list. Dictation appears only when enabled.' },
  { name: 'resumeAfterUsageLimits', label: 'Resume after usage limits', hint: () => 'Pick up a limited conversation when the provider’s next window opens.', help: () => 'On by default. Bitbots resumes once at a known reset time. Unknown or expired windows wait for you; repeated recovery is bounded. Turn this off to resume manually.' },
  { name: 'autoRetry', label: 'Automatic retry', hint: () => 'Continue a turn by itself after a temporary provider failure.', help: () => 'After a temporary process, stream or server failure, Bitbots uses a jittered delay and at most three retries. It sends “Please continue.” once, in the same conversation. It never resends your original message, never retries sign-in or billing errors, and you can cancel a pending retry from the notice.' },
  { name: 'memory', label: 'Memory', hint: () => `Let ${entityNoun(themeStyle(), { plural: true })} save and recall short notes across conversations.`, help: () => `When on, ${entityNoun(themeStyle(), { plural: true })} can save short notes (preferences, decisions, facts) and see a list of them at the start of each message. Notes a ${entityNoun(themeStyle())} saves for a project or for everyone stay unused until you approve them in Settings → Memory. Notes never contain passwords or keys, and you can edit or delete any of them.` },
  { name: 'approvalBadge', label: 'Approval badge', hint: () => `See waiting ${entityNoun(themeStyle(), { plural: true })} on the Windows taskbar and tray.`, help: () => `Adds a taskbar overlay for ${entityNoun(themeStyle(), { plural: true })} needing approval or an answer. The tray tooltip shows the count. Clears when nobody is waiting or this switch is off.` },
  { name: 'sidebarModel', label: 'Model and effort under the name', hint: () => 'Show each bot’s model and effort in place of the conversation preview.', help: () => `While nothing is running, the line under a ${entityNoun(themeStyle())}’s name reads “Sonnet 5.5 · High” instead of the last message. A working or waiting ${entityNoun(themeStyle())} still shows its status, and a ${entityNoun(themeStyle())} with no model shows “Default model”.` },
  { name: 'botLock', label: 'Lock a bot', hint: () => `Keep a ${entityNoun(themeStyle())}’s settings from changing until you unlock it.`, help: () => `Adds “Lock ${entityNoun(themeStyle())}” to a bot’s right-click menu. A locked ${entityNoun(themeStyle())} shows a lock badge, its settings, model, effort, permissions and instructions cannot change, and the Manager cannot change it either. Unlock is always offered, even when this switch is off, so a bot can never be stuck. The Manager can be neither locked nor unlocked.` },
] as const
export type ExperimentName = typeof EXPERIMENTS[number]['name']
export type Experiments = Record<ExperimentName, boolean>
export const DEFAULT_EXPERIMENTS = Object.fromEntries(EXPERIMENTS.map(({ name }) => [name, name === 'resumeAfterUsageLimits'])) as Experiments

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

export function shortcutRows(speechEnabled: boolean) {
  return [
    ['Ctrl+K / ⌘K', 'Quick switcher'],
    ...(speechEnabled ? [['Ctrl+E', 'Start or stop dictation']] : []),
    ['Ctrl+Alt+B', 'Show or hide companion (when its shortcut is enabled)'],
    ['Ctrl+/', 'Keyboard shortcuts'],
    ['Enter', 'Send a prompt; choose a highlighted mention or reference'],
    ['Shift+Enter', 'New line'],
    ['@', 'Mention a teammate in the composer'],
    ['#', 'Reference a side conversation in the composer'],
    ['↑ / ↓', 'Navigate switcher, mention and reference results'],
    ['Tab', 'Choose a highlighted mention or reference'],
    ['Esc', 'Close a dialog, menu, mention or reference picker'],
  ]
}
