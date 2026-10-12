export type ConversationNotification = { state: 'completed' | 'failed' | 'approval'; body: (title: string) => string }

export function notificationForTransition(previous: string | null | undefined, next: string | null | undefined): ConversationNotification | null {
  if (previous == null) return null
  const prior = (previous ?? '').toLowerCase()
  const state = (next ?? '').toLowerCase()
  if (state === 'completed' && prior !== 'completed') return { state: 'completed', body: (title) => `Finished: ${title}` }
  if ((state === 'error' || state === 'failed') && prior !== state) return { state: 'failed', body: (title) => `Failed: ${title}` }
  if (state === 'waiting_permission' && prior !== 'waiting_permission') return { state: 'approval', body: (title) => `Needs your approval: ${title}` }
  return null
}

export type NotificationLevel = 'all' | 'input' | 'muted'

/** A blob's level decides which transitions may notify: everything, only approvals/questions, or nothing. */
export function notificationAllowed(level: NotificationLevel | null | undefined, state: ConversationNotification['state']): boolean {
  if (level === 'muted') return false
  if (level === 'input') return state === 'approval'
  return true
}
