import type { JsonRecord, Session, Snapshot } from '../types'

export const EXPERIMENTS = [
  { name: 'changeReview', label: 'Change review', hint: 'Review, keep or revert the files changed by a turn.', help: 'Shows saved file diffs below each completed reply. Keep dismisses a file. Revert confirms and reverses only a complete patch that still applies cleanly.' },
  { name: 'messageActions', label: 'Message actions', hint: 'React, reply to, or copy a user or assistant message.', help: 'Hover or focus a user or assistant message for Reaction, Reply and Copy. Reply quotes the selected message as untrusted context. Right-click a user message for Retry or Edit. Hidden in read-only side conversations.' },
  { name: 'search', label: 'Search all conversations', hint: 'Find messages across your saved, active conversations.', help: 'Choose Search messages in the quick switcher. Search returns up to 50 matching messages. Open a result to jump to its message. Archived conversations are excluded.' },
  { name: 'autoTitles', label: 'Automatic titles', hint: 'Name a main conversation from its first prompt.', help: 'The first user prompt supplies a short title if the conversation still has the blob’s default name. Custom titles and side conversations are preserved.' },
  { name: 'undo', label: 'Undo', hint: 'Undo archiving a blob or deleting a conversation for eight seconds.', help: 'Conversation deletion is queued in the daemon database for eight seconds. Closing a window does not cancel it. Quitting ends Undo and finishes pending deletions; an unexpected exit is recovered on the next launch.' },
  { name: 'shortcuts', label: 'Shortcut sheet', hint: 'Open the keyboard shortcut list with Ctrl+/.', help: 'Adds Keyboard shortcuts to the profile menu and Ctrl+/ to open the list. Dictation appears only when enabled.' },
  { name: 'approvalBadge', label: 'Approval badge', hint: 'See waiting blobs on the Windows taskbar and tray.', help: 'Adds a taskbar overlay for blobs needing approval or an answer. The tray tooltip shows the count. Clears when nobody is waiting or this switch is off.' },
] as const
export type ExperimentName = typeof EXPERIMENTS[number]['name']
export type Experiments = Record<ExperimentName, boolean>
export const DEFAULT_EXPERIMENTS = Object.fromEntries(EXPERIMENTS.map(({ name }) => [name, false])) as Experiments

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
