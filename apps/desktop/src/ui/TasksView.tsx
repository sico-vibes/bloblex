// Tasks: durable work you hand to a bot. The daemon owns every state; this page shows the board and sends the owner's actions.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Plus } from 'lucide-react'
import type { Agent, BoardTask, BoardTaskRun, Project, Runtime } from '../types'
import { TaskTimeline } from './TaskTimeline'
import { TaskTree } from './TaskTree'
import { rpcFailure } from '../executionContract'
import { DelegateBoard } from './DelegateBoard'
import { useDialogAccessibility, useDialogEntered } from './dialogFocus'
import { Select } from './Select'
import { SafeMarkdown } from './SafeMarkdown'
import { openSafeLink } from './openSafeLink'
import { TaskForm } from './TaskForm'
import { TaskImageStrip } from './TaskImageStrip'
import { SCHEDULE_OUTCOME_LABEL, TASK_STATE_LABEL, assignableAgents, dispatchMessage, elapsedLabel, newIdempotencyKey, scheduleSummary } from './taskModel'
import { useTasks, type TaskInput } from './useTasks'
import './tasks.css'

export interface TasksViewProps {
  agents: readonly Agent[]
  projects: readonly Project[]
  runtimes: readonly Runtime[]
  connected: boolean
  onBack: () => void
  onOpenSession: (sessionId: string) => void
}

export function TasksView({ agents, projects, runtimes, connected, onBack, onOpenSession }: TasksViewProps) {
  const board = useTasks(true, connected)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [view, setView] = useState<'board' | 'tree' | 'timeline'>('board')
  const [runsByTask, setRunsByTask] = useState<Record<string, BoardTaskRun[]>>({})
  const runsKey = board.tasks.filter((task) => task.assigneeAgentId).map((task) => `${task.id}:${task.version}`).join(',')
  useEffect(() => {
    if (view !== 'timeline') return
    let live = true
    void Promise.all(board.tasks.filter((task) => task.assigneeAgentId).map(async (task) => [task.id, await board.runs(task.id).catch(() => [] as BoardTaskRun[])] as const)).then((entries) => { if (live) setRunsByTask(Object.fromEntries(entries)) })
    return () => { live = false }
  }, [view, runsKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const backRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { backRef.current?.focus() }, [])
  useEffect(() => { const timer = window.setInterval(() => setNowMs(Date.now()), 30_000); return () => window.clearInterval(timer) }, [])
  const mark = (id: string, on: boolean) => setBusy((current) => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next })
  const runtimeName = (agent: Agent) => { const runtime = runtimes.find((item) => item.id === agent.runtimeId); return [runtime?.displayName ?? runtime?.provider ?? agent.runtimeId, agent.model].filter(Boolean).join(' · ') }

  const assign = async (task: BoardTask, agent: Agent) => {
    mark(task.id, true)
    setNotice(null)
    try {
      const result = await board.dispatch(task, agent.id, newIdempotencyKey(task.id))
      setNotice({ tone: 'ok', text: dispatchMessage(result.disposition, agent.name, result.queuePosition, result.reason) })
    } catch (reason) {
      setNotice({ tone: 'bad', text: rpcFailure(reason).message })
      void board.reload()
    } finally { mark(task.id, false) }
  }

  const openTask = board.tasks.find((task) => task.id === openId) ?? null

  return <div className="tasks-page">
    <header className="blob-page-header">
      <button ref={backRef} type="button" className="analytics-icon-button" aria-label="Back" title="Back" onClick={onBack}><ArrowLeft size={16} /></button>
      <strong className="blob-page-heading">Tasks</strong>
      <button type="button" className="primary-button small tasks-new" disabled={!connected} onClick={() => setCreating(true)}><Plus size={14} aria-hidden="true" />New task</button>
    </header>
    <div className="tasks-scroll">
      <div className="tasks-column">
        <div className="tasks-bar">
          <p className="tasks-lead">{view === 'board' ? "Your Manager drafts tasks here. Drag one onto a bot to start it, or queue it behind the bot's current work." : view === 'tree' ? 'Each card is a task, placed under the task it was split from.' : 'When each bot worked, and what it waited on.'}</p>
          <div className="segmented" role="radiogroup" aria-label="View">{(['board', 'tree', 'timeline'] as const).map((item) => <button key={item} type="button" role="radio" aria-checked={view === item} className={view === item ? 'on' : undefined} onClick={() => setView(item)}>{item === 'board' ? 'Board' : item === 'tree' ? 'Tree' : 'Timeline'}</button>)}</div>
        </div>
        {board.error && <p className="tasks-problem" role="alert">{board.error}</p>}
        <div className="tasks-notice" role="status" aria-live="polite">{notice && <span className={`tasks-notice-text ${notice.tone}`}>{notice.text}</span>}</div>
        {!board.loaded && !board.error ? <p className="tasks-loading">Loading tasks…</p> : view === 'tree' ? <TaskTree tasks={board.tasks} agents={agents} nowMs={nowMs} onOpen={(task) => setOpenId(task.id)} /> : view === 'timeline' ? <TaskTimeline tasks={board.tasks} runsByTask={runsByTask} agents={agents} nowMs={nowMs} onOpen={(task) => setOpenId(task.id)} /> : <DelegateBoard tasks={board.tasks} agents={agents} projects={projects} nowMs={nowMs} connected={connected} busy={busy} runtimeName={runtimeName} onAssign={(task, agent) => void assign(task, agent)} onOpen={(task) => setOpenId(task.id)} />}
      </div>
    </div>
    {creating && <TaskFormDialog task={null} agents={agents} projects={projects} connected={connected} loadImage={board.image} onClose={() => setCreating(false)} onSave={async (input, start) => { const created = await board.create(input); setCreating(false); if (start) await assign(created, start) }} />}
    {openTask && <TaskDialog task={openTask} agents={agents} projects={projects} connected={connected} nowMs={nowMs} onClose={() => setOpenId(null)} board={board} onOpenSession={onOpenSession} onAssign={assign} />}
  </div>
}

/** The create and edit dialog around the shared form. `save` returns once the task is stored (and started, when asked). */
function TaskFormDialog({ task, agents, projects, connected, loadImage, onClose, onSave, onDiscard }: {
  task: BoardTask | null; agents: readonly Agent[]; projects: readonly Project[]; connected: boolean
  loadImage: (taskId: string, imageId: string) => Promise<string>
  onClose: () => void; onSave: (input: TaskInput, start: Agent | null) => Promise<void>; onDiscard?: () => Promise<void>
}) {
  const entered = useDialogEntered()
  const { ref, close } = useDialogAccessibility(onClose)
  const headingId = task ? 'task-edit-title' : 'task-new-title'
  return <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`} onPointerDown={(event) => { if (event.target === event.currentTarget) close() }}>
    <section ref={ref} className="blob-dialog task-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1}>
      <TaskForm task={task} agents={agents} projects={projects} connected={connected} heading={task ? 'Edit task' : 'New task'} headingId={headingId} submitLabel={task ? 'Save' : 'Add task'} startLabel={task ? 'Save and start' : 'Add and start'}
        loadImage={loadImage} onCancel={close} onSubmit={onSave} onDiscard={onDiscard} />
    </section>
  </div>
}

type TaskDialogProps = {
  task: BoardTask; agents: readonly Agent[]; projects: readonly Project[]; connected: boolean; nowMs: number
  board: ReturnType<typeof useTasks>; onClose: () => void; onOpenSession: (sessionId: string) => void; onAssign: (task: BoardTask, agent: Agent) => Promise<void>
}

/** A draft opens in the editor (it is the only state the daemon lets the owner edit); anything else opens its details. */
function TaskDialog(props: TaskDialogProps) {
  const { task, agents, projects, connected, board, onClose, onAssign } = props
  if (task.state !== 'unassigned') return <TaskDetailDialog {...props} />
  return <TaskFormDialog task={task} agents={agents} projects={projects} connected={connected} loadImage={board.image} onClose={onClose}
    onSave={async (input, start) => { const saved = await board.update(task, input); onClose(); if (start) await onAssign(saved, start) }}
    onDiscard={async () => { await board.act('task.cancel', task); onClose() }} />
}

function TaskDetailDialog({ task, agents, projects, connected, nowMs, board, onClose, onOpenSession, onAssign }: {
  task: BoardTask; agents: readonly Agent[]; projects: readonly Project[]; connected: boolean; nowMs: number
  board: ReturnType<typeof useTasks>; onClose: () => void; onOpenSession: (sessionId: string) => void; onAssign: (task: BoardTask, agent: Agent) => Promise<void>
}) {
  const entered = useDialogEntered()
  const { ref, close } = useDialogAccessibility(onClose)
  const [runs, setRuns] = useState<BoardTaskRun[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const assignee = agents.find((agent) => agent.id === task.assigneeAgentId)
  const project = projects.find((item) => item.id === task.projectId)
  useEffect(() => { let live = true; void board.runs(task.id).then((list) => { if (live) setRuns(list) }).catch(() => undefined); return () => { live = false } }, [task.id, task.version]) // eslint-disable-line react-hooks/exhaustive-deps
  const latest = useMemo(() => runs.slice().sort((a, b) => b.attempt - a.attempt)[0] ?? null, [runs])
  const run = async (action: () => Promise<unknown>) => { setWorking(true); setFailure(null); try { await action() } catch (reason) { setFailure(rpcFailure(reason).message) } finally { setWorking(false) } }
  const when = (value?: string | null) => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null
  const took = task.startedAt ? elapsedLabel(task.startedAt, task.completedAt, nowMs) : null
  const state = task.state
  return <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`} onPointerDown={(event) => { if (event.target === event.currentTarget) close() }}>
    <section ref={ref} className="blob-dialog task-dialog task-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="task-detail-title" tabIndex={-1}>
      <header className="task-dialog-head"><h2 id="task-detail-title">{task.title}</h2><span className={`task-state tone-${state}`}>{TASK_STATE_LABEL[state]}</span></header>
      <div className="task-detail-content">
      <dl className="task-facts">
        {assignee && <><dt>Bot</dt><dd>{assignee.name}</dd></>}
        {project && <><dt>Project</dt><dd>{project.name}</dd></>}
        {task.startedAt && <><dt>Started</dt><dd>{when(task.startedAt)}</dd></>}
        {took && <><dt>{task.completedAt ? 'Took' : 'Running for'}</dt><dd>{took}</dd></>}
        {task.estimateMinutes ? <><dt>Estimate</dt><dd>about {task.estimateMinutes} min</dd></> : null}
        {task.maxRuntimeSecs ? <><dt>Time limit</dt><dd>{Math.round(task.maxRuntimeSecs / 60)} min</dd></> : null}
        {task.unattended && <><dt>Started by</dt><dd>A schedule</dd></>}
        {task.schedule && <><dt>Schedule</dt><dd>{scheduleSummary(task, agents)}{task.scheduleLastOutcome ? ` · ${SCHEDULE_OUTCOME_LABEL[task.scheduleLastOutcome] ?? task.scheduleLastOutcome}` : ''}</dd></>}
      </dl>
      {task.brief && <section className="task-text"><h3>What needs doing</h3><SafeMarkdown text={task.brief} onOpenLink={(url) => void openSafeLink(url)} /></section>}
      {task.doneGoal && <section className="task-text"><h3>Done when</h3><SafeMarkdown text={task.doneGoal} onOpenLink={(url) => void openSafeLink(url)} /></section>}
      {task.reportBack && <section className="task-text"><h3>Report back</h3><SafeMarkdown text={task.reportBack} onOpenLink={(url) => void openSafeLink(url)} /></section>}
      {!!task.images?.length && <section className="task-text"><h3>Images</h3><TaskImageStrip taskId={task.id} images={task.images} load={board.image} /></section>}
      {state === 'awaiting_review' && <p className="task-note">The bot finished its turn. Check the result, then mark the task done or not done. Finishing a turn does not count as done.</p>}
      {runs.length > 1 && <ul className="task-runs" aria-label="Attempts">{runs.slice().sort((a, b) => b.attempt - a.attempt).map((item) => <li key={item.id}><span>Attempt {item.attempt}</span><span>{item.assigneeAgentName ?? 'Bot'}</span><span>{TASK_STATE_LABEL[item.state as keyof typeof TASK_STATE_LABEL] ?? item.state}</span></li>)}</ul>}
      {failure && <p className="tasks-problem" role="alert">{failure}</p>}
      </div>
      <div className="blob-dialog-actions task-actions">
        {(state === 'failed' || state === 'awaiting_review') && <>
          <Select ariaLabel="Try again with" variant="muted" className="task-retry-select" align="left" disabled={!connected || working} value="" placeholder="Try again with…" menuPlacement="top" options={assignableAgents(agents).map((agent) => ({ value: agent.id, label: agent.name }))} onChange={(value) => { const agent = agents.find((item) => item.id === value); if (agent) void run(async () => { await onAssign(task, agent); onClose() }) }} /></>}
        <div className="task-action-buttons">
        <button type="button" className="secondary-button" onClick={close}>Close</button>
        {latest?.sessionId && <button type="button" className="secondary-button" onClick={() => onOpenSession(latest.sessionId as string)}>Open conversation</button>}
        {state === 'queued' && <><button type="button" className="secondary-button" disabled={working} onClick={() => void run(() => board.act('task.unassign', task))}>Unassign</button><button type="button" className="secondary-button" disabled={working} onClick={() => void run(async () => { await board.act('task.cancel', task); onClose() })}>Cancel task</button></>}
        {(state === 'running' || state === 'needs_you') && <button type="button" className="secondary-button" disabled={working} onClick={() => void run(() => board.act('task.stop', task))}>Stop</button>}
        {(state === 'awaiting_review' || state === 'needs_you') && <><button type="button" className="secondary-button" disabled={working} onClick={() => void run(async () => { await board.review(task, latest?.id ?? null, 'not_done', 'Marked not done by you.'); onClose() })}>Not done</button><button type="button" className="primary-button" disabled={working} onClick={() => void run(async () => { await board.review(task, latest?.id ?? null, 'done', 'Marked done by you.'); onClose() })}>Mark done</button></>}        </div>
      </div>
    </section>
  </div>
}
