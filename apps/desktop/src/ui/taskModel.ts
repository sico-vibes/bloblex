// Pure helpers for the task board: labels, grouping and the honest "how long" text. Times come only from observed timestamps.
import type { Agent, BoardTask, TaskState } from '../types'

export const TASK_STATE_LABEL: Record<string, string> = {
  claimed: 'Starting', ambiguous: 'Needs a look', unassigned: 'Draft', queued: 'Queued', running: 'Working', needs_you: 'Needs you', awaiting_review: 'Ready for review', done: 'Done', failed: 'Failed', cancelled: 'Cancelled',
}

export const FINISHED_STATES: readonly TaskState[] = ['done', 'failed', 'cancelled']
export const isFinished = (task: BoardTask) => FINISHED_STATES.includes(task.state)
/** On a bot's lane: assigned and not finished. */
export const isOnLane = (task: BoardTask) => !!task.assigneeAgentId && !isFinished(task) && task.state !== 'unassigned'

/** Needs-you and review come first on a lane, then work in progress, then the queue in order. */
const LANE_ORDER: Record<string, number> = { needs_you: 0, awaiting_review: 1, running: 2, queued: 3 }
export function laneTasks(tasks: readonly BoardTask[], agentId: string): BoardTask[] {
  return tasks.filter((task) => task.assigneeAgentId === agentId && isOnLane(task))
    .sort((a, b) => (LANE_ORDER[a.state] ?? 9) - (LANE_ORDER[b.state] ?? 9) || (a.queuePosition ?? 0) - (b.queuePosition ?? 0) || a.createdAt.localeCompare(b.createdAt))
}

export const draftTasks = (tasks: readonly BoardTask[]) => tasks.filter((task) => task.state === 'unassigned').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
export const finishedTasks = (tasks: readonly BoardTask[]) => tasks.filter(isFinished).sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt))

export type Availability = { tone: 'free' | 'working' | 'attention'; label: string; queued: number }
export function laneAvailability(lane: readonly BoardTask[], nowMs: number): Availability {
  const attention = lane.filter((task) => task.state === 'needs_you' || task.state === 'awaiting_review').length
  const running = lane.find((task) => task.state === 'running')
  const queued = lane.filter((task) => task.state === 'queued').length
  if (running) {
    const left = remainingMinutes(running, nowMs)
    return { tone: 'working', label: left != null ? `Busy · ${left} min left` : 'Working', queued }
  }
  if (attention) return { tone: 'attention', label: attention === 1 ? 'Waiting for you' : `${attention} waiting for you`, queued }
  return { tone: 'free', label: 'Free', queued }
}

/** Remaining minutes against the user's own estimate; null when either the estimate or the observed start is missing. */
export function remainingMinutes(task: BoardTask, nowMs: number): number | null {
  if (!task.estimateMinutes || !task.startedAt) return null
  const started = Date.parse(task.startedAt)
  if (Number.isNaN(started)) return null
  return Math.max(0, Math.ceil(task.estimateMinutes - (nowMs - started) / 60000))
}

export function elapsedLabel(from: string | null | undefined, to: string | null | undefined, nowMs: number): string | null {
  if (!from) return null
  const start = Date.parse(from)
  const end = to ? Date.parse(to) : nowMs
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null
  const minutes = Math.floor((end - start) / 60000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}

/** The queue is numbered from 0 on the wire; show it from 1. */
export const queueLabel = (position: number | null | undefined) => position == null ? null : position + 1

export function dispatchMessage(disposition: 'started' | 'queued', agent: string, position?: number | null, reason?: string | null): string {
  if (disposition === 'started') return `Started on ${agent}.`
  const why = reason === 'global_pause' ? 'Tasks are paused' : reason === 'global_limit' ? 'The task limit is reached' : `${agent} is busy`
  return `${why}. Queued${position != null ? ` at position ${position + 1}` : ''} for ${agent}.`
}

export function newIdempotencyKey(taskId: string): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${taskId}:${random}`
}

export const assignableAgents = (agents: readonly Agent[]) => agents.filter((agent) => !agent.archived && !agent.hidden)
