// The delegate board: unassigned drafts on the left, one lane per bot on the right. Drag a draft onto a bot to start it or queue it;
// the Assign menu on each draft is the keyboard route to the same single dispatch action.
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { CalendarClock, ChevronDown, GripVertical } from 'lucide-react'
import type { Agent, BoardTask, Project } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentLook } from '../blob/look'
import { agentColorHex } from './agentColor'
import { Select } from './Select'
import { TASK_STATE_LABEL, SCHEDULE_OUTCOME_LABEL, draftTasks, finishedTasks, laneAvailability, laneTasks, assignableAgents, scheduleSummary, scheduledTasks } from './taskModel'
import { describeNextRun } from './automationSchedule'
import { useEntityNoun } from './vocabulary'

export interface DelegateBoardProps {
  tasks: readonly BoardTask[]
  agents: readonly Agent[]
  projects: readonly Project[]
  nowMs: number
  connected: boolean
  /** Task ids with a request in flight. */
  busy: ReadonlySet<string>
  runtimeName: (agent: Agent) => string
  onAssign: (task: BoardTask, agent: Agent) => void
  onOpen: (task: BoardTask) => void
}

export function DelegateBoard({ tasks, agents, projects, nowMs, connected, busy, runtimeName, onAssign, onOpen }: DelegateBoardProps) {
  const noun = useEntityNoun()
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [showFinished, setShowFinished] = useState(false)
  const [dragPoint, setDragPoint] = useState<{ x: number; y: number } | null>(null)
  const gesture = useRef<{ taskId: string; pointerId: number; x: number; y: number; dragging: boolean } | null>(null)
  const suppressClick = useRef(false)
  const bots = assignableAgents(agents).slice().sort((a, b) => a.sortOrder - b.sortOrder)
  const drafts = draftTasks(tasks)
  const scheduled = scheduledTasks(tasks)
  const finished = finishedTasks(tasks)
  const projectName = (id: string | null) => projects.find((project) => project.id === id)?.name ?? null
  const dragging = dragId ? tasks.find((task) => task.id === dragId && task.state === 'unassigned') ?? null : null
  const assignOptions = bots.map((agent) => ({ value: agent.id, label: agent.name }))

  const botAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>('.delegate-lane[data-agent-id]')?.dataset.agentId ?? null
  const clearDrag = () => { gesture.current = null; setDragId(null); setOverId(null); setDragPoint(null) }
  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>, task: BoardTask) => {
    if (event.button !== 0 || !connected || busy.has(task.id)) return
    suppressClick.current = false
    gesture.current = { taskId: task.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, dragging: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    if (!current.dragging && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return
    current.dragging = true
    suppressClick.current = true
    event.preventDefault()
    setDragId(current.taskId)
    setDragPoint({ x: event.clientX, y: event.clientY })
    setOverId(botAt(event.clientX, event.clientY))
  }
  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    const agentId = current.dragging ? botAt(event.clientX, event.clientY) : null
    const task = tasks.find((item) => item.id === current.taskId && item.state === 'unassigned')
    const agent = bots.find((item) => item.id === agentId)
    suppressClick.current = current.dragging
    clearDrag()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (current.dragging) {
      event.preventDefault()
      window.setTimeout(() => { suppressClick.current = false }, 0)
      if (connected && task && agent && !busy.has(task.id)) onAssign(task, agent)
    }
  }

  const meta = (task: BoardTask) => [projectName(task.projectId), task.estimateMinutes ? `about ${task.estimateMinutes} min` : null, task.images?.length ? `${task.images.length} image${task.images.length === 1 ? '' : 's'}` : null, task.scheduleState === 'missed' ? 'Missed its time' : null].filter(Boolean).join(' · ')

  return <div className="delegate-board">
    {dragging && dragPoint && <div className="delegate-drag-ghost" style={{ left: dragPoint.x + 14, top: dragPoint.y + 14 }} aria-hidden="true">{dragging.title}</div>}
    <section className="delegate-backlog" aria-labelledby="delegate-backlog-title">
      <header className="delegate-head"><h2 id="delegate-backlog-title">Unassigned</h2><span className="delegate-count">{drafts.length}</span></header>
      {drafts.length === 0
        ? <p className="delegate-empty">No drafts. Ask your Manager to plan some work, or add a task.</p>
        : <ul className="delegate-list">{drafts.map((task) => <li key={task.id}>
          <article className={`delegate-draft${dragId === task.id ? ' dragging' : ''}${busy.has(task.id) ? ' busy' : ''}`} draggable={false}
            onDragStart={(event) => { setDragId(task.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', task.id) }}
            onDragEnd={() => { setDragId(null); setOverId(null) }}>
            <button type="button" className="delegate-draft-main"
              onPointerDown={(event) => beginDrag(event, task)} onPointerMove={moveDrag} onPointerUp={finishDrag}
              onPointerCancel={clearDrag} onLostPointerCapture={() => { if (gesture.current) clearDrag() }}
              onClick={() => { if (suppressClick.current) { suppressClick.current = false; return }; onOpen(task) }}>
              <GripVertical size={14} className="delegate-grip" aria-hidden="true" />
              <span className="delegate-draft-text"><strong>{task.title}</strong>{meta(task) && <small>{meta(task)}</small>}</span>
            </button>
            <Select ariaLabel={`Assign ${task.title}`} variant="muted" value="" placeholder="Assign to…" triggerLabel="Assign" disabled={!connected || busy.has(task.id) || bots.length === 0} options={assignOptions}
              onChange={(value) => { const agent = bots.find((item) => item.id === value); if (agent) onAssign(task, agent) }} />
          </article>
        </li>)}</ul>}
      {scheduled.length > 0 && <div className="delegate-scheduled">
        <header className="delegate-head"><h2>Scheduled</h2><span className="delegate-count">{scheduled.length}</span></header>
        <ul className="delegate-list">{scheduled.map((task) => <li key={task.id}>
          <button type="button" className="delegate-scheduled-card" onClick={() => onOpen(task)}>
            <CalendarClock size={14} className="delegate-grip" aria-hidden="true" />
            <span className="delegate-draft-text"><strong>{task.title}</strong><small>{scheduleSummary(task, agents)}</small><small>{task.scheduleNextAt ? `Next run ${describeNextRun(task.scheduleNextAt, nowMs)}` : ''}{task.scheduleLastOutcome ? `${task.scheduleNextAt ? ' · ' : ''}Last: ${SCHEDULE_OUTCOME_LABEL[task.scheduleLastOutcome] ?? task.scheduleLastOutcome}` : ''}</small></span>
          </button>
        </li>)}</ul>
      </div>}
      {finished.length > 0 && <div className="delegate-finished">
        <button type="button" className="delegate-finished-toggle" aria-expanded={showFinished} onClick={() => setShowFinished((open) => !open)}><ChevronDown size={14} aria-hidden="true" className={showFinished ? 'open' : ''} />Finished<span className="delegate-count">{finished.length}</span></button>
        {showFinished && <ul className="delegate-list compact">{finished.map((task) => <li key={task.id}><button type="button" className={`delegate-done tone-${task.state}`} onClick={() => onOpen(task)}><span className="delegate-dot" aria-hidden="true" /><span className="delegate-done-title">{task.title}</span><small>{TASK_STATE_LABEL[task.state]}</small></button></li>)}</ul>}
      </div>}
    </section>

    <section className="delegate-bots" aria-labelledby="delegate-bots-title">
      <header className="delegate-head"><h2 id="delegate-bots-title">{noun === 'bot' ? 'Bots' : `${noun[0].toUpperCase()}${noun.slice(1)}s`}</h2><span className="delegate-hint">{dragging ? `Drop on a ${noun} to start the task or queue it` : `Drag a task onto a ${noun}`}</span></header>
      {bots.length === 0 ? <p className="delegate-empty">Create a {noun} first, then give it work here.</p> : <ul className="delegate-lanes">{bots.map((agent) => {
        const lane = laneTasks(tasks, agent.id)
        const availability = laneAvailability(lane, nowMs)
        const over = overId === agent.id
        return <li key={agent.id}>
          <section className={`delegate-lane${dragging ? ' drop-ready' : ''}${over ? ' over' : ''}`} data-agent-id={agent.id} aria-label={`${agent.name}, ${availability.label}`}
            onDragOver={(event) => { if (!dragging) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; if (overId !== agent.id) setOverId(agent.id) }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && overId === agent.id) setOverId(null) }}
            onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData('text/plain') || dragId; setDragId(null); setOverId(null); const task = tasks.find((item) => item.id === id && item.state === 'unassigned'); if (task) onAssign(task, agent) }}>
            <header className="delegate-lane-head">
              <span className="delegate-face" aria-hidden="true"><BlobCanvas decorative color={agentColorHex(agent.color)} size={28} mood={lane.some((task) => task.state === 'running') ? 'working' : 'idle'} look={agentLook(agent)} label={agent.name} /></span>
              <span className="delegate-lane-name"><strong>{agent.name}</strong><small>{runtimeName(agent)}</small></span>
              <span className="delegate-badges"><span className={`delegate-availability tone-${availability.tone}`}>{availability.label}</span>{availability.queued > 0 && <span className="delegate-availability">{availability.queued} queued</span>}</span>
            </header>
            {lane.length > 0 && <ul className="delegate-chips">{lane.map((task) => <li key={task.id}><button type="button" className={`delegate-chip tone-${task.state}`} onClick={() => onOpen(task)}><span className="delegate-dot" aria-hidden="true" /><span className="delegate-chip-title">{task.title}</span><small>{task.state === 'queued' && task.queuePosition != null ? `Queued ${task.queuePosition + 1}` : TASK_STATE_LABEL[task.state]}</small></button></li>)}</ul>}
          </section>
        </li>
      })}</ul>}
    </section>
  </div>
}
