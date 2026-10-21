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
import { TASK_STATE_LABEL, assignableAgents, dispatchMessage, elapsedLabel, newIdempotencyKey } from './taskModel'
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
    {creating && <NewTaskDialog projects={projects} onClose={() => setCreating(false)} onCreate={async (input) => { await board.create(input); setCreating(false) }} />}
    {openTask && <TaskDialog task={openTask} agents={agents} projects={projects} nowMs={nowMs} onClose={() => setOpenId(null)} board={board} onOpenSession={onOpenSession} onAssign={assign} />}
  </div>
}

function NewTaskDialog({ projects, onClose, onCreate }: { projects: readonly Project[]; onClose: () => void; onCreate: (input: TaskInput) => Promise<void> }) {
  const entered = useDialogEntered()
  const { ref, close } = useDialogAccessibility(onClose)
  const [title, setTitle] = useState('')
  const [brief, setBrief] = useState('')
  const [doneGoal, setDoneGoal] = useState('')
  const [reportBack, setReportBack] = useState('')
  const [projectId, setProjectId] = useState('')
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const valid = title.trim().length > 0 && title.trim().length <= 120 && brief.length <= 8000
  const submit = async () => {
    if (!valid || saving) return
    setSaving(true); setFailure(null)
    try { await onCreate({ title: title.trim(), brief: brief.trim(), doneGoal: doneGoal.trim(), reportBack: reportBack.trim(), projectId: projectId || null }) }
    catch (reason) { setFailure(rpcFailure(reason).message); setSaving(false) }
  }
  return <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`}>
    <section ref={ref} className="blob-dialog task-dialog" role="dialog" aria-modal="true" aria-labelledby="task-new-title" tabIndex={-1}>
      <h2 id="task-new-title">New task</h2>
      <label className="blob-field"><span>Title</span><input data-dialog-initial-focus value={title} maxLength={120} placeholder="Write the release notes" onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="blob-field"><span>What needs doing</span><textarea rows={4} value={brief} placeholder="Summarise what changed since the last release for the changelog." onChange={(event) => setBrief(event.target.value)} /></label>
      <label className="blob-field"><span>Done when</span><input value={doneGoal} maxLength={400} placeholder="A draft is in docs/releases" onChange={(event) => setDoneGoal(event.target.value)} /></label>
      <label className="blob-field"><span>Report back</span><input value={reportBack} maxLength={400} placeholder="A short summary and the files changed" onChange={(event) => setReportBack(event.target.value)} /></label>
      <div className="blob-field"><span>Project</span><Select ariaLabel="Project" variant="field" value={projectId} placeholder="No project" onChange={setProjectId} options={[{ value: '', label: 'No project' }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} /></div>
      {failure && <p className="tasks-problem" role="alert">{failure}</p>}
      <div className="blob-dialog-actions">
        <button type="button" className="secondary-button" onClick={close}>Cancel</button>
        <button type="button" className="primary-button" disabled={!valid || saving} onClick={() => void submit()}>{saving ? 'Saving…' : 'Add task'}</button>
      </div>
    </section>
  </div>
}

function TaskDialog({ task, agents, projects, nowMs, board, onClose, onOpenSession, onAssign }: {
  task: BoardTask; agents: readonly Agent[]; projects: readonly Project[]; nowMs: number
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
  return <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`}>
    <section ref={ref} className="blob-dialog task-dialog" role="dialog" aria-modal="true" aria-labelledby="task-detail-title" tabIndex={-1}>
      <header className="task-dialog-head"><h2 id="task-detail-title">{task.title}</h2><span className={`task-state tone-${state}`}>{TASK_STATE_LABEL[state]}</span></header>
      <dl className="task-facts">
        {assignee && <><dt>Bot</dt><dd>{assignee.name}</dd></>}
        {project && <><dt>Project</dt><dd>{project.name}</dd></>}
        {task.startedAt && <><dt>Started</dt><dd>{when(task.startedAt)}</dd></>}
        {took && <><dt>{task.completedAt ? 'Took' : 'Running for'}</dt><dd>{took}</dd></>}
        {task.estimateMinutes ? <><dt>Estimate</dt><dd>about {task.estimateMinutes} min</dd></> : null}
      </dl>
      {task.brief && <section className="task-text"><h3>What needs doing</h3><p>{task.brief}</p></section>}
      {task.doneGoal && <section className="task-text"><h3>Done when</h3><p>{task.doneGoal}</p></section>}
      {task.reportBack && <section className="task-text"><h3>Report back</h3><p>{task.reportBack}</p></section>}
      {state === 'awaiting_review' && <p className="task-note">The bot finished its turn. Check the result, then mark the task done or not done. Finishing a turn does not count as done.</p>}
      {runs.length > 1 && <ul className="task-runs" aria-label="Attempts">{runs.slice().sort((a, b) => b.attempt - a.attempt).map((item) => <li key={item.id}><span>Attempt {item.attempt}</span><span>{item.assigneeAgentName ?? 'Bot'}</span><span>{TASK_STATE_LABEL[item.state as keyof typeof TASK_STATE_LABEL] ?? item.state}</span></li>)}</ul>}
      {failure && <p className="tasks-problem" role="alert">{failure}</p>}
      <div className="blob-dialog-actions task-actions">
        <button type="button" className="secondary-button" onClick={close}>Close</button>
        {latest?.sessionId && <button type="button" className="secondary-button" onClick={() => onOpenSession(latest.sessionId as string)}>Open conversation</button>}
        {(state === 'unassigned' || state === 'failed' || state === 'awaiting_review') && <>{state === 'unassigned' && <button type="button" className="secondary-button" disabled={working} onClick={() => void run(async () => { await board.act('task.cancel', task); onClose() })}>Discard</button>}
          <Select ariaLabel={state === 'unassigned' ? 'Assign task' : 'Try again with'} variant="field" value="" placeholder={state === 'unassigned' ? 'Assign to…' : 'Try again with…'} menuPlacement="top" options={assignableAgents(agents).map((agent) => ({ value: agent.id, label: agent.name }))} onChange={(value) => { const agent = agents.find((item) => item.id === value); if (agent) void run(async () => { await onAssign(task, agent); onClose() }) }} /></>}
        {state === 'queued' && <><button type="button" className="secondary-button" disabled={working} onClick={() => void run(() => board.act('task.unassign', task))}>Unassign</button><button type="button" className="secondary-button" disabled={working} onClick={() => void run(async () => { await board.act('task.cancel', task); onClose() })}>Cancel task</button></>}
        {(state === 'running' || state === 'needs_you') && <button type="button" className="secondary-button" disabled={working} onClick={() => void run(() => board.act('task.stop', task))}>Stop</button>}
        {(state === 'awaiting_review' || state === 'needs_you') && <><button type="button" className="secondary-button" disabled={working} onClick={() => void run(async () => { await board.review(task, latest?.id ?? null, 'not_done', 'Marked not done by you.'); onClose() })}>Not done</button><button type="button" className="primary-button" disabled={working} onClick={() => void run(async () => { await board.review(task, latest?.id ?? null, 'done', 'Marked done by you.'); onClose() })}>Mark done</button></>}
      </div>
    </section>
  </div>
}
