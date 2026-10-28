// Manager delegations: the ledger the daemon keeps for every message a bot sends to a teammate (`delegation.list`
// and `delegation.updated`), and how one assignment is presented in the conversation that made it.
// The daemon owns each assignment's lifecycle (queued, running, completed, failed, cancelled, interrupted); this
// module only adds what only the window knows (a pending approval in the side conversation) and never invents
// a status the daemon did not record.
import { useCallback, useEffect, useRef, useState } from 'react'
import { listenForDaemonEvents, rpc } from '../tauri'
import type { Agent, Session } from '../types'
import { taskElapsed, taskStatus } from './WorkingBotsPanel'
import type { GroupedConversationItem } from './conversation'

export type DelegationStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type DelegationWorktree = { repo: string | null; branch: string | null; path: string | null }
export type DelegationRecord = {
  id: string
  originSessionId: string
  originTurnId: string | null
  sideSessionId: string
  sideTurnId: string | null
  fromAgentId: string | null
  targetAgentId: string | null
  topic: string
  briefPreview: string
  status: DelegationStatus
  error: string | null
  workspacePath: string | null
  worktree: DelegationWorktree | null
  createdAt: string | null
  startedAt: string | null
  finishedAt: string | null
  updatedAt: string | null
  /** Why a queued assignment has not started: its conversation is mid-turn, or every global slot is taken. */
  queueReason: 'busy' | 'slots' | null
  /** The teammate replied `(pass)`: done, with nothing to report and no relay to the Manager. */
  silent?: boolean
  /** What must be true for the assignment to count as done, when it was given one. */
  doneGoal?: string | null
}

const STATUSES: readonly DelegationStatus[] = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']
const text = (value: unknown) => typeof value === 'string' && value ? value : null

/** Accepts only a well-formed daemon record; anything else is dropped instead of guessed at. */
export function normalizeDelegation(raw: unknown): DelegationRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const id = text(value.id)
  const originSessionId = text(value.originSessionId)
  const sideSessionId = text(value.sideSessionId)
  if (!id || !originSessionId || !sideSessionId || !STATUSES.includes(value.status as DelegationStatus)) return null
  const workspace = value.workspace && typeof value.workspace === 'object' ? value.workspace as Record<string, unknown> : {}
  const tree = workspace.worktree && typeof workspace.worktree === 'object' ? workspace.worktree as Record<string, unknown> : null
  return {
    id, originSessionId, sideSessionId,
    originTurnId: text(value.originTurnId), sideTurnId: text(value.sideTurnId),
    fromAgentId: text(value.fromAgentId), targetAgentId: text(value.targetAgentId),
    topic: text(value.topic) ?? 'Assigned task', briefPreview: text(value.briefPreview) ?? '',
    status: value.status as DelegationStatus, error: text(value.error),
    workspacePath: text(workspace.path),
    worktree: tree ? { repo: text(tree.repo), branch: text(tree.branch), path: text(tree.path) } : null,
    createdAt: text(value.createdAt), startedAt: text(value.startedAt), finishedAt: text(value.finishedAt), updatedAt: text(value.updatedAt),
    queueReason: value.queueReason === 'busy' || value.queueReason === 'slots' ? value.queueReason : null,
  }
}

/**
 * Loads one conversation's delegations, then keeps them current from `delegation.updated`. An older daemon
 * without the ledger answers `not_found`: `available` stays false and the rows fall back to what the
 * conversation itself recorded. `ensure` reloads once for an id the list has not seen yet.
 */
export function useDelegations(originSessionId: string | null, connected: boolean) {
  const [records, setRecords] = useState<ReadonlyMap<string, DelegationRecord>>(() => new Map())
  const [loaded, setLoaded] = useState(false)
  const [available, setAvailable] = useState(true)
  const sessionRef = useRef<string | null>(null)
  const asked = useRef(new Set<string>())

  const load = useCallback(async (id: string) => {
    try {
      const result = await rpc<{ delegations?: unknown[] }>('delegation.list', { originSessionId: id })
      if (sessionRef.current !== id) return
      const next = new Map<string, DelegationRecord>()
      for (const raw of result.delegations ?? []) { const record = normalizeDelegation(raw); if (record && record.originSessionId === id) next.set(record.id, record) }
      setRecords(next); setAvailable(true)
    } catch {
      if (sessionRef.current === id) setAvailable(false)
    } finally {
      if (sessionRef.current === id) setLoaded(true)
    }
  }, [])

  useEffect(() => {
    sessionRef.current = originSessionId
    asked.current = new Set()
    setRecords(new Map()); setLoaded(false); setAvailable(true)
    if (!originSessionId || !connected) return
    void load(originSessionId)
  }, [originSessionId, connected, load])

  useEffect(() => {
    if (!originSessionId || !connected) return
    let off: (() => void) | null = null
    let cancelled = false
    void listenForDaemonEvents((event) => {
      if (event.type !== 'delegation.updated') return
      const record = normalizeDelegation((event.payload as { delegation?: unknown } | undefined)?.delegation)
      if (!record || record.originSessionId !== originSessionId) return
      setRecords((current) => {
        const known = current.get(record.id)
        if (known && known.updatedAt && record.updatedAt && record.updatedAt < known.updatedAt) return current
        return new Map(current).set(record.id, record)
      })
    }).then((unlisten) => { if (cancelled) unlisten(); else off = unlisten })
    return () => { cancelled = true; off?.() }
  }, [originSessionId, connected])

  const ensure = useCallback((ids: readonly string[]) => {
    const id = sessionRef.current
    if (!id) return
    const fresh = ids.filter((item) => !asked.current.has(item))
    if (!fresh.length) return
    for (const item of fresh) asked.current.add(item)
    void load(id)
  }, [load])

  return { records, loaded, available, ensure }
}

export type DelegationBucket = 'queued' | 'working' | 'approval' | 'done' | 'failed' | 'cancelled' | 'interrupted' | 'earlier'
export const isActiveBucket = (bucket: DelegationBucket) => bucket === 'queued' || bucket === 'working' || bucket === 'approval'

/** One assignment as the conversation shows it. */
export type DelegationRowModel = {
  key: string
  delegationId: string | null
  agent: Agent | undefined
  name: string
  topic: string
  sideSessionId: string | null
  sideSession: Session | undefined
  bucket: DelegationBucket
  label: string
  startedAt: number | null
  endedAt: number | null
  preview: string
  error: string | null
  workspacePath: string | null
  worktree: DelegationWorktree | null
  /** The teammate is waiting for the owner to answer a question (not to approve an action). */
  asking?: boolean
  /** True when the daemon's ledger recorded this assignment; false for an older message read from the conversation. */
  recorded: boolean
}

/** A delegation notice found in the conversation (a message the daemon wrote when it sent the brief or could not). */
export type DelegationNotice = {
  id: string
  delegationId: string | null
  originTurnId: string | null
  peerAgentId: string | null
  peerName: string
  topic: string | null
  sideSessionId: string | null
  failed: boolean
  text: string
  createdAt: string | null
}

export function delegationNotice(item: GroupedConversationItem): DelegationNotice | null {
  if (item.kind !== 'message' || !item.value) return null
  const message = item.value as Record<string, unknown>
  const meta = message.meta && typeof message.meta === 'object' ? message.meta as Record<string, unknown> : null
  if (message.role !== 'notice' || meta?.kind !== 'delegation') return null
  const direction = meta.direction
  // `waiting` and `isolated` notices live in the teammate's own conversation, not here.
  if (direction !== undefined && direction !== 'sent' && direction !== 'failed') return null
  return {
    id: item.id, delegationId: text(meta.delegationId), originTurnId: text(meta.originTurnId), peerAgentId: text(meta.peerAgentId),
    peerName: text(meta.peerName) ?? 'Teammate', topic: text(meta.topic), sideSessionId: text(meta.sideSessionId),
    failed: direction === 'failed', text: typeof message.content === 'string' ? message.content : '', createdAt: text(message.createdAt),
  }
}

/**
 * Runs of delegation notices that belong together: adjacent in the conversation and sent in the same Manager turn.
 * The first notice's item id keys the run; the rest are folded into it. A "could not start" notice for an
 * assignment the conversation already shows (same `delegationId`) is the same assignment, not another one.
 */
export function delegationRuns(items: readonly GroupedConversationItem[]): { runs: Map<string, DelegationNotice[]>; folded: Set<string> } {
  const runs = new Map<string, DelegationNotice[]>()
  const folded = new Set<string>()
  const notices = items.map(delegationNotice)
  // "Could not start" arrives later than the message it belongs to, so it is matched by id, wherever it sits.
  const sent = new Set(notices.flatMap((notice) => notice && !notice.failed && notice.delegationId ? [notice.delegationId] : []))
  let current: DelegationNotice[] | null = null
  items.forEach((item, index) => {
    const notice = notices[index]
    if (!notice) { current = null; return }
    if (notice.failed && notice.delegationId && sent.has(notice.delegationId)) { folded.add(item.id); return }
    if (current && current[0].originTurnId === notice.originTurnId) {
      current.push(notice)
      folded.add(item.id)
      return
    }
    current = [notice]
    runs.set(item.id, current)
  })
  return { runs, folded }
}

const durationOf = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
}
const parse = (value: string | null | undefined) => { const time = Date.parse(value ?? ''); return Number.isFinite(time) ? time : null }

/** Elapsed time of a row: waiting or working time while it is open; frozen at the daemon's finish time once it is not. */
export function rowElapsed(row: DelegationRowModel, now: number): string {
  if (row.startedAt === null) return '—'
  const end = isActiveBucket(row.bucket) ? now : row.endedAt
  return end === null ? '—' : durationOf(end - row.startedAt)
}

export const BUCKET_LABEL: Record<DelegationBucket, string> = {
  queued: 'Queued', working: 'Working', approval: 'Needs approval', done: 'Done', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted', earlier: 'Earlier message',
}

/** A queued assignment says what it waits for, when the daemon recorded it. */
export function queuedLabel(reason: DelegationRecord['queueReason']): string {
  return reason === 'busy' ? 'Queued · bot is busy' : reason === 'slots' ? 'Queued · no free slot' : BUCKET_LABEL.queued
}

const LEGACY_BUCKET: Record<string, DelegationBucket> = { Working: 'working', Starting: 'working', 'Waiting for you': 'approval', Waiting: 'queued', Done: 'done', Failed: 'failed', Cancelled: 'cancelled' }

/**
 * Builds the rows of one run. A recorded assignment shows the daemon's own status, upgraded to "Needs approval"
 * only while the teammate's conversation has an approval waiting. A message from before the ledger existed shows
 * the teammate conversation's state only for the newest message sent to it; an older one cannot be told apart
 * from it and is labelled "Earlier message" instead of getting a guessed status.
 */
export function buildDelegationRows(notices: readonly DelegationNotice[], records: ReadonlyMap<string, DelegationRecord>, sessions: readonly Session[], agents: readonly Agent[], approvalSessions: ReadonlySet<string>, newestLegacyBySide: ReadonlyMap<string, string>, now: number, questionSessions: ReadonlySet<string> = new Set()): DelegationRowModel[] {
  return notices.map((notice) => {
    const record = notice.delegationId ? records.get(notice.delegationId) ?? null : null
    const sideSessionId = record?.sideSessionId ?? notice.sideSessionId
    const sideSession = sideSessionId ? sessions.find((session) => session.id === sideSessionId) : undefined
    const agent = agents.find((candidate) => candidate.id === (record?.targetAgentId ?? notice.peerAgentId ?? sideSession?.agentId))
    const name = agent?.name ?? notice.peerName
    const topic = record?.topic ?? notice.topic ?? sideSession?.link?.topic?.trim() ?? sideSession?.title?.trim() ?? 'Assigned task'
    const base = { key: notice.delegationId ?? notice.id, delegationId: notice.delegationId, agent, name, topic, sideSessionId, sideSession }
    if (record) {
      const approval = record.status === 'running' && !!sideSessionId && (approvalSessions.has(sideSessionId) || sideSession?.state === 'waiting_permission')
      const bucket: DelegationBucket = approval ? 'approval' : record.status === 'running' ? 'working' : record.status === 'completed' ? 'done' : record.status
      // A teammate that asked the owner a question keeps its assignment open; say so instead of "Needs approval".
      const asking = approval && !!sideSessionId && questionSessions.has(sideSessionId)
      return { ...base, asking, bucket, label: asking ? 'Has a question' : bucket === 'queued' ? queuedLabel(record.queueReason) : bucket === 'done' && record.silent ? 'Done, nothing to report' : BUCKET_LABEL[bucket], startedAt: parse(record.startedAt ?? record.createdAt), endedAt: parse(record.finishedAt), preview: record.briefPreview, error: record.error, workspacePath: record.workspacePath, worktree: record.worktree, recorded: true }
    }
    const startedAt = parse(notice.createdAt)
    const fallback = { ...base, startedAt, endedAt: null, preview: notice.text, error: notice.failed ? notice.text : null, workspacePath: sideSession?.projectPath ?? null, worktree: null, recorded: false }
    if (notice.failed) return { ...fallback, bucket: 'failed' as const, label: BUCKET_LABEL.failed }
    const newest = sideSessionId ? newestLegacyBySide.get(sideSessionId) === notice.id : false
    if (!sideSession || !newest) return { ...fallback, bucket: 'earlier' as const, label: BUCKET_LABEL.earlier, startedAt: null }
    const status = taskStatus(sideSession)
    const bucket = LEGACY_BUCKET[status] ?? 'earlier'
    const finished = !isActiveBucket(bucket)
    const elapsed = taskElapsed(sideSession, status, now)
    // A legacy row has no recorded finish time: freeze it only when the conversation recorded one.
    return { ...fallback, bucket, label: LEGACY_BUCKET[status] ? BUCKET_LABEL[bucket] : status, startedAt: elapsed === '—' ? null : startedAt, endedAt: finished ? parse(String(sideSession.turns?.at(-1)?.completedAt ?? '')) : null }
  })
}

/** The newest delegation notice per teammate conversation, over a whole conversation (for messages sent before the ledger). */
export function newestNoticeBySide(runs: ReadonlyMap<string, DelegationNotice[]>): Map<string, string> {
  const newest = new Map<string, string>()
  for (const notices of runs.values()) for (const notice of notices) if (notice.sideSessionId && !notice.delegationId) newest.set(notice.sideSessionId, notice.id)
  return newest
}

/** One line for the header: "2 working · 1 done". */
export function summarizeBuckets(rows: readonly DelegationRowModel[]): string {
  const count = (bucket: DelegationBucket) => rows.filter((row) => row.bucket === bucket).length
  const parts: [number, string][] = [[count('approval'), 'need approval'], [count('working'), 'working'], [count('queued'), 'queued'], [count('failed'), 'failed'], [count('interrupted'), 'interrupted'], [count('cancelled'), 'cancelled'], [count('done'), 'done'], [count('earlier'), 'earlier']]
  return parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`).join(' · ')
}

/** The whole group's elapsed time: from the first start to now while anything is open, else to the last finish. */
export function groupElapsed(rows: readonly DelegationRowModel[], now: number): string {
  const starts = rows.map((row) => row.startedAt).filter((time): time is number => time !== null)
  if (!starts.length) return '—'
  const open = rows.some((row) => isActiveBucket(row.bucket))
  const ends = rows.map((row) => row.endedAt).filter((time): time is number => time !== null)
  if (!open && !ends.length) return '—'
  return durationOf((open ? now : Math.max(...ends)) - Math.min(...starts))
}
