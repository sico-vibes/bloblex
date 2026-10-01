import type { JsonRecord, Session } from '../types'

export type ConversationItem = { kind: 'message' | 'activity'; id: string; value?: JsonRecord; activity?: JsonRecord; activityKind?: 'tool' | 'file' | 'turn' }

export function buildConversationItems(session: Session): ConversationItem[] {
  const messages = session.messages ?? session.turns?.flatMap((turn) => Array.isArray(turn.messages) ? turn.messages as JsonRecord[] : []) ?? session.events ?? []
  const items: Array<ConversationItem & { sequence: number | null; timestamp: number | null; tie: number }> = []
  const orderOf = (value: JsonRecord) => {
    const sequence = Number(value.sequence)
    const normalizedSequence = Number.isFinite(sequence) && sequence > 0 ? sequence : null
    const time = Date.parse(String(value.createdAt ?? value.startedAt ?? value.completedAt ?? value.updatedAt ?? value.timestamp ?? ''))
    return { sequence: normalizedSequence, timestamp: Number.isFinite(time) ? time : null }
  }
  messages.forEach((message, index) => items.push({ kind: 'message', id: `message:${String(message.id ?? `${message.turnId ?? ''}:${message.role ?? ''}:${index}`)}`, value: message, ...orderOf(message), tie: index }))
  ;(session.tools ?? []).forEach((activity, index) => items.push({ kind: 'activity', id: `tool:${String(activity.id ?? `${activity.turnId ?? ''}:${index}`)}`, activity, activityKind: 'tool', ...orderOf(activity), tie: 10_000 + index }))
  ;(session.files ?? []).forEach((activity, index) => items.push({ kind: 'activity', id: `file:${String(activity.id ?? activity.path ?? index)}`, activity, activityKind: 'file', ...orderOf(activity), tie: 20_000 + index }))
  ;(session.turns ?? []).filter((turn) => turn.state === 'error' || turn.state === 'failed').forEach((turn, index) => items.push({ kind: 'activity', id: `turn-error:${String(turn.id ?? index)}`, activity: turn, activityKind: 'turn', ...orderOf(turn), tie: 30_000 + index }))
  const hasTimestamps = items.some((item) => item.timestamp !== null)
  return items.sort((left, right) => {
    // Sequence counters and epoch timestamps have unrelated units. Use one
    // clock when available; sequence orders entries only when no timestamps exist.
    if (hasTimestamps) {
      if (left.timestamp !== null && right.timestamp !== null) return left.timestamp - right.timestamp || left.tie - right.tie
      if (left.timestamp !== null) return -1
      if (right.timestamp !== null) return 1
      return (left.sequence ?? 0) - (right.sequence ?? 0) || left.tie - right.tie
    }
    return (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER) || left.tie - right.tie
  })
}
