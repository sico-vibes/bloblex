// Preview-only task ledger. It mimics the daemon's task.* contract (drafts, dispatch -> started or queued, review) with in-memory
// data; it is not evidence of daemon behaviour. A started task "finishes its turn" after a few seconds so the review step can be seen.
import type { BoardTask, BoardTaskRun } from '../types'

type Notify = (type: string, payload: Record<string, unknown>) => void
type Fail = (code: string, message: string) => Error

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const draft = (id: string, title: string, brief: string, estimateMinutes: number, ageMinutes: number): BoardTask => ({
  id, title, brief, doneGoal: '', reportBack: '', projectId: null, assigneeAgentId: null, supervisionPolicy: 'report_only', estimateMinutes, state: 'unassigned', version: 1,
  createdAt: minutesAgo(ageMinutes), updatedAt: minutesAgo(ageMinutes),
})
const assigned = (id: string, title: string, agent: string, state: BoardTask['state'], extra: Partial<BoardTask> = {}): BoardTask => ({
  id, title, brief: '', doneGoal: '', reportBack: '', projectId: null, assigneeAgentId: agent, supervisionPolicy: 'report_only', state, version: 3,
  createdAt: minutesAgo(90), updatedAt: minutesAgo(5), assignedAt: minutesAgo(40), ...extra,
})

const tasks: BoardTask[] = [
  draft('task-notes', 'Write release notes', 'Summarise what changed since the last release for the changelog.', 15, 12),
  draft('task-flaky', 'Fix flaky checkout test', 'The checkout test fails about one run in ten. Find the cause and fix it.', 20, 30),
  draft('task-churn', 'Summarise churn calls', 'Read the last five churn calls and list the common reasons.', 15, 45),
  draft('task-pricing', 'Update pricing page', 'Apply the new plan names to the pricing page copy.', 10, 70),
  draft('task-crm', 'Clean up CRM duplicates', '', 18, 95),
  assigned('task-release', 'Ship the pricing relaunch', 'agent-manager', 'running', { startedAt: minutesAgo(70), assignedAt: minutesAgo(72) }),
  assigned('task-refactor', 'Refactor auth module', 'agent-codex', 'running', { estimateMinutes: 30, startedAt: minutesAgo(12), assignedAt: minutesAgo(16), queuePosition: null, parentTaskId: 'task-release' }),
  assigned('task-stripe', 'Upgrade Stripe SDK', 'agent-codex', 'queued', { queuePosition: 1, assignedAt: minutesAgo(9), parentTaskId: 'task-release' }),
  assigned('task-competitor', 'Competitor scan', 'agent-claude', 'awaiting_review', { startedAt: minutesAgo(35), completedAt: minutesAgo(6), assignedAt: minutesAgo(38), parentTaskId: 'task-release' }),
  assigned('task-copy', 'Confirm the copy direction', 'agent-opencode', 'needs_you', { startedAt: minutesAgo(18), assignedAt: minutesAgo(20), parentTaskId: 'task-release' }),
  assigned('task-lint', 'Fix lint warnings', 'agent-claude', 'done', { startedAt: minutesAgo(200), completedAt: minutesAgo(180), updatedAt: minutesAgo(180), assignedAt: minutesAgo(203) }),
]
const run = (taskId: string, attempt: number, agentId: string, agentName: string, state: string, started: number | null, ended: number | null): BoardTaskRun => ({ id: `run-${taskId}-${attempt}`, taskId, attempt, sessionId: null, assigneeAgentId: agentId, assigneeAgentName: agentName, state, startedAt: started == null ? null : minutesAgo(started), endedAt: ended == null ? null : minutesAgo(ended) })
const runs: Record<string, BoardTaskRun[]> = {
  'task-release': [run('task-release', 1, 'agent-manager', 'Manager', 'running', 70, null)],
  'task-refactor': [run('task-refactor', 1, 'agent-codex', 'Codex', 'failed', 88, 80), run('task-refactor', 2, 'agent-codex', 'Codex', 'running', 12, null)],
  'task-competitor': [run('task-competitor', 1, 'agent-claude', 'Claude', 'awaiting_review', 35, 6)],
  'task-copy': [run('task-copy', 1, 'agent-opencode', 'OpenCode', 'needs_you', 18, null)],
  'task-lint': [run('task-lint', 1, 'agent-claude', 'Claude', 'done', 200, 180)],
}
const bump = (task: BoardTask, patch: Partial<BoardTask>) => Object.assign(task, patch, { version: task.version + 1, updatedAt: new Date().toISOString() })
const keys = new Map<string, Record<string, unknown>>()

export function handleFixtureTaskRpc(method: string, params: Record<string, unknown>, notify: Notify, fail: Fail): unknown {
  const find = () => tasks.find((task) => task.id === params.taskId)
  const need = () => { const task = find(); if (!task) throw fail('not_found', 'That task no longer exists.'); return task }
  const fresh = (task: BoardTask) => { if (typeof params.expectedVersion === 'number' && params.expectedVersion !== task.version) throw fail('conflict', 'This task changed. Reload the board and try again.'); return task }
  const publish = (task: BoardTask) => notify('task.changed', { task: { ...task } })
  switch (method) {
    case 'task.list': return { tasks: tasks.filter((task) => (!params.state || task.state === params.state) && (!params.assigneeAgentId || task.assigneeAgentId === params.assigneeAgentId)).map((task) => ({ ...task })) }
    case 'task.get': return { task: { ...need() } }
    case 'task.runs': return { runs: (runs[String(params.taskId)] ?? []).map((run) => ({ ...run })) }
    case 'task.create': {
      const title = String(params.title ?? '').trim()
      if (!title) throw fail('invalid_argument', 'A task needs a title.')
      const task: BoardTask = { ...draft(`task-${Date.now().toString(36)}`, title, String(params.brief ?? ''), 0, 0), doneGoal: String(params.doneGoal ?? ''), reportBack: String(params.reportBack ?? ''), projectId: (params.projectId as string | null) ?? null, estimateMinutes: null }
      tasks.unshift(task)
      publish(task)
      return { task: { ...task } }
    }
    case 'task.dispatch': {
      const task = fresh(need())
      const agentId = String(params.assigneeAgentId ?? '')
      const key = String(params.idempotencyKey ?? '')
      const replay = keys.get(key)
      if (replay) return { ...replay, replayed: true }
      if (task.state !== 'unassigned') throw fail('conflict', 'Only a draft can be assigned.')
      const busy = tasks.some((item) => item.assigneeAgentId === agentId && item.state === 'running')
      const queued = tasks.filter((item) => item.assigneeAgentId === agentId && item.state === 'queued').length
      const started = !busy
      bump(task, { assigneeAgentId: agentId, assignedAt: new Date().toISOString(), state: started ? 'running' : 'queued', queuePosition: started ? null : queued + 1, startedAt: started ? new Date().toISOString() : null })
      const run: BoardTaskRun = { id: `run-${task.id}-1`, taskId: task.id, attempt: 1, sessionId: null, assigneeAgentId: agentId, assigneeAgentName: null, state: task.state, startedAt: task.startedAt ?? null }
      runs[task.id] = [run]
      publish(task)
      if (started) window.setTimeout(() => { if (task.state === 'running') { bump(task, { state: 'awaiting_review', completedAt: new Date().toISOString() }); publish(task) } }, 8000)
      const result = { task: { ...task }, run, disposition: started ? 'started' : 'queued', queuePosition: task.queuePosition ?? null, reason: started ? null : 'bot_busy', replayed: false }
      keys.set(key, result)
      return result
    }
    case 'task.unassign': {
      const task = fresh(need())
      if (task.state !== 'queued') throw fail('conflict', 'A running task must be stopped first.')
      bump(task, { assigneeAgentId: null, state: 'unassigned', queuePosition: null, assignedAt: null })
      publish(task)
      return { task: { ...task } }
    }
    case 'task.cancel': {
      const task = fresh(need())
      if (task.state === 'running') throw fail('conflict', 'A running task must be stopped first.')
      bump(task, { state: 'cancelled', queuePosition: null, completedAt: new Date().toISOString() })
      publish(task)
      return { task: { ...task } }
    }
    case 'task.stop': {
      const task = fresh(need())
      bump(task, { state: 'cancelled', completedAt: new Date().toISOString() })
      publish(task)
      return { task: { ...task } }
    }
    case 'task.review': {
      const task = fresh(need())
      const decision = String(params.decision)
      bump(task, { state: decision === 'done' ? 'done' : decision === 'not_done' ? 'failed' : 'awaiting_review', completedAt: new Date().toISOString() })
      publish(task)
      return { task: { ...task } }
    }
    case 'task.reorder': return { task: { ...fresh(need()) } }
    case 'task.update': {
      const task = fresh(need())
      for (const field of ['title', 'brief', 'doneGoal', 'reportBack', 'projectId'] as const) if (field in params) (task as Record<string, unknown>)[field] = params[field]
      bump(task, {})
      publish(task)
      return { task: { ...task } }
    }
    default: throw fail('unsupported', `The preview does not support ${method}.`)
  }
}
