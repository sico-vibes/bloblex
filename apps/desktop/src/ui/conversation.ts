import type { JsonRecord, Session } from '../types'

export type ConversationItem = { kind: 'message' | 'activity'; id: string; value?: JsonRecord; activity?: JsonRecord; activityKind?: 'tool' | 'file' | 'turn' }
export type ActivityGroup = { kind: 'activity-group'; id: string; items: ConversationItem[]; commands: number; files: number; failed: number; runningTitle: string | null }
export type GroupedConversationItem = ConversationItem | ActivityGroup

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

export function groupConversationActivity(items: ConversationItem[]): GroupedConversationItem[] {
  const output: GroupedConversationItem[] = []
  for (let index = 0; index < items.length;) {
    if (items[index].kind !== 'activity' || index === 0 || items[index - 1].kind !== 'message') {
      output.push(items[index++])
      continue
    }
    let end = index
    while (end < items.length && items[end].kind === 'activity') end += 1
    const activityItems = items.slice(index, end)
    if (activityItems.length < 2 || (end < items.length && items[end].kind !== 'message')) {
      output.push(...activityItems)
      index = end
      continue
    }
    const failed = activityItems.filter((item) => {
      const state = String(item.activity?.state ?? item.activity?.status ?? '').toLowerCase()
      return ['error', 'failed', 'rejected'].includes(state) || item.activityKind === 'turn'
    }).length
    const running = activityItems.find((item) => ['running', 'working', 'started'].includes(String(item.activity?.state ?? item.activity?.status ?? '').toLowerCase()))
    const title = running?.activity?.title ?? running?.activity?.command ?? running?.activity?.kind
    output.push({
      kind: 'activity-group',
      id: `activity-group:${activityItems[0].id}:${activityItems.at(-1)?.id}`,
      items: activityItems,
      commands: activityItems.filter((item) => item.activityKind === 'tool').length,
      files: activityItems.filter((item) => item.activityKind === 'file').length,
      failed,
      runningTitle: running ? String(title ?? 'Agent activity') : null,
    })
    index = end
  }
  return output
}
