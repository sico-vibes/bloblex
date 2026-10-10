import type { JsonRecord, Session } from '../types'

export type ConversationItem = { kind: 'message' | 'activity'; id: string; value?: JsonRecord; activity?: JsonRecord; activityKind?: 'tool' | 'file' | 'turn' }
export type ActivityGroup = {
  kind: 'activity-group'; id: string; turnId: string | null; items: ConversationItem[]
  commands: number; tools: number; searches: number; files: number; failed: number; runningTitle: string | null
}
export type GroupedConversationItem = ConversationItem | ActivityGroup

/** Provider steps that are not user-facing activity (reasoning carries no visible content). */
const HIDDEN_TOOL_KINDS = new Set(['reasoning'])
const COMMAND_KINDS = new Set(['commandexecution', 'exec', 'execute', 'shell', 'bash', 'command', 'terminal'])
const SEARCH_KINDS = new Set(['websearch', 'search', 'web_search', 'fetch', 'webfetch'])

type Ordered = ConversationItem & { sequence: number | null; timestamp: number | null; tie: number; turnId: string | null }

function orderOf(value: JsonRecord) {
  const sequence = Number(value.sequence)
  const time = Date.parse(String(value.createdAt ?? value.startedAt ?? value.completedAt ?? value.updatedAt ?? value.timestamp ?? ''))
  return { sequence: Number.isFinite(sequence) && sequence > 0 ? sequence : null, timestamp: Number.isFinite(time) ? time : null }
}

const turnOf = (value: JsonRecord): string | null => typeof value.turnId === 'string' && value.turnId ? value.turnId : null

/** The original mixed ordering: one clock when timestamps exist, else sequence. */
function legacySort(items: Ordered[]) {
  const hasTimestamps = items.some((item) => item.timestamp !== null)
  return [...items].sort((left, right) => {
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

/**
 * The conversation in order. Messages follow the daemon's per-session
 * sequence, which is authoritative (live events may arrive without a
 * timestamp). A turn's tools and file changes sit right after that turn's
 * last message, so the summary reads under the reply it produced; older
 * records without a turn keep their position from the mixed ordering.
 */
export function buildConversationItems(session: Session): ConversationItem[] {
  const messages = session.messages ?? session.turns?.flatMap((turn) => Array.isArray(turn.messages) ? turn.messages as JsonRecord[] : []) ?? session.events ?? []
  const messageItems: Ordered[] = messages.map((message, index) => ({ kind: 'message', id: `message:${String(message.id ?? `${message.turnId ?? ''}:${message.role ?? ''}:${index}`)}`, value: message, ...orderOf(message), tie: index, turnId: turnOf(message) }))
  const activities: Ordered[] = [
    ...(session.tools ?? []).filter((tool) => !HIDDEN_TOOL_KINDS.has(String(tool.kind ?? '').toLowerCase())).map((activity, index): Ordered => ({ kind: 'activity', id: `tool:${String(activity.id ?? `${activity.turnId ?? ''}:${index}`)}`, activity, activityKind: 'tool', ...orderOf(activity), tie: 10_000 + index, turnId: turnOf(activity) })),
    ...(session.files ?? []).map((activity, index): Ordered => ({ kind: 'activity', id: `file:${String(activity.id ?? activity.path ?? index)}`, activity, activityKind: 'file', ...orderOf(activity), tie: 20_000 + index, turnId: turnOf(activity) })),
    ...(session.turns ?? []).filter((turn) => turn.state === 'error' || turn.state === 'failed').map((turn, index): Ordered => ({ kind: 'activity', id: `turn-error:${String(turn.id ?? index)}`, activity: turn, activityKind: 'turn', ...orderOf(turn), tie: 30_000 + index, turnId: typeof turn.id === 'string' ? turn.id : null })),
  ]
  const ordered = messageItems.length > 0 && messageItems.every((item) => item.sequence !== null)
    ? [...messageItems].sort((left, right) => left.sequence! - right.sequence! || left.tie - right.tie)
    : legacySort(messageItems)
  const known = new Set(ordered.map((item) => item.turnId).filter(Boolean))
  const lastOfTurn = new Map<string, string>()
  for (const item of ordered) if (item.turnId) lastOfTurn.set(item.turnId, item.id)
  // Activity without a turn (older records) keeps its place from the mixed ordering.
  const legacy = activities.filter((item) => !item.turnId || !known.has(item.turnId))
  const legacyAfter = new Map<string, Ordered[]>()
  const legacyLead: Ordered[] = []
  let previous: string | null = null
  for (const item of legacySort([...messageItems, ...legacy])) {
    if (item.kind === 'message') { previous = item.id; continue }
    if (item.turnId && !known.has(item.turnId)) continue
    if (previous) legacyAfter.set(previous, [...(legacyAfter.get(previous) ?? []), item])
    else legacyLead.push(item)
  }
  const byTurn = new Map<string, Ordered[]>()
  for (const item of activities) if (item.turnId && known.has(item.turnId)) byTurn.set(item.turnId, [...(byTurn.get(item.turnId) ?? []), item])
  const result: ConversationItem[] = [...legacyLead]
  for (const item of ordered) {
    result.push(item, ...(legacyAfter.get(item.id) ?? []))
    if (item.turnId && lastOfTurn.get(item.turnId) === item.id) result.push(...(byTurn.get(item.turnId) ?? []))
  }
  // A turn with activity but no message yet (it is still running) goes last.
  result.push(...activities.filter((item) => item.turnId && !known.has(item.turnId)))
  return result.map(({ kind, id, value, activity, activityKind }) => ({ kind, id, value, activity, activityKind }))
}

export function activityCategory(item: ConversationItem): 'command' | 'search' | 'file' | 'tool' | 'turn' {
  if (item.activityKind === 'file') return 'file'
  if (item.activityKind === 'turn') return 'turn'
  const kind = String(item.activity?.kind ?? '').toLowerCase()
  if (kind === 'filechange') return 'file'
  if (COMMAND_KINDS.has(kind) || typeof (item.activity?.detail as JsonRecord | undefined)?.command === 'string') return 'command'
  if (SEARCH_KINDS.has(kind)) return 'search'
  return 'tool'
}

/** Each run of activity becomes one collapsible line; a failed turn stays on its own. */
export function groupConversationActivity(items: ConversationItem[]): GroupedConversationItem[] {
  const output: GroupedConversationItem[] = []
  for (let index = 0; index < items.length;) {
    const item = items[index]
    if (item.kind !== 'activity' || item.activityKind === 'turn') {
      output.push(items[index++])
      continue
    }
    let end = index
    while (end < items.length && items[end].kind === 'activity' && items[end].activityKind !== 'turn') end += 1
    const activityItems = items.slice(index, end)
    const categories = activityItems.map(activityCategory)
    const failed = activityItems.filter((entry) => ['error', 'failed', 'rejected'].includes(String(entry.activity?.state ?? entry.activity?.status ?? '').toLowerCase())).length
    const running = activityItems.find((entry) => ['running', 'working', 'started'].includes(String(entry.activity?.state ?? entry.activity?.status ?? '').toLowerCase()))
    const title = running?.activity?.title ?? running?.activity?.command ?? running?.activity?.kind
    output.push({
      kind: 'activity-group',
      id: `activity-group:${activityItems[0].id}:${activityItems.at(-1)?.id}`,
      turnId: typeof activityItems[0].activity?.turnId === 'string' ? activityItems[0].activity.turnId : null,
      items: activityItems,
      commands: categories.filter((category) => category === 'command').length,
      tools: categories.filter((category) => category === 'tool').length,
      searches: categories.filter((category) => category === 'search').length,
      files: categories.filter((category) => category === 'file').length,
      failed,
      runningTitle: running ? String(title ?? 'Agent activity') : null,
    })
    index = end
  }
  return output
}

/** "Ran 3 commands · used 2 tools · searched the web · edited 1 file" */
export function activitySummary(group: ActivityGroup) {
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
  const parts = [
    group.commands ? `Ran ${plural(group.commands, 'command', 'commands')}` : '',
    group.tools ? `${group.commands ? 'used' : 'Used'} ${plural(group.tools, 'tool', 'tools')}` : '',
    group.searches ? `${group.commands || group.tools ? 'searched' : 'Searched'} the web${group.searches > 1 ? ` ${group.searches} times` : ''}` : '',
    group.files ? `${group.commands || group.tools || group.searches ? 'edited' : 'Edited'} ${plural(group.files, 'file', 'files')}` : '',
  ].filter(Boolean)
  return parts.join(' · ') || plural(group.items.length, 'step', 'steps')
}
