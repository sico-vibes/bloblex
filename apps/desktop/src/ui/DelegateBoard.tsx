// The delegate board: unassigned drafts on the left, one lane per bot on the right. Drag a draft onto a bot to start it or queue it;
// the Assign menu on each draft is the keyboard route to the same single dispatch action.
import { useState } from 'react'
import { ChevronDown, GripVertical } from 'lucide-react'
import type { Agent, BoardTask, Project } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentLook } from '../blob/look'
import { agentColorHex } from './agentColor'
import { Select } from './Select'
import { TASK_STATE_LABEL, draftTasks, finishedTasks, laneAvailability, laneTasks, assignableAgents } from './taskModel'
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
  const bots = assignableAgents(agents).slice().sort((a, b) => a.sortOrder - b.sortOrder)
  const drafts = draftTasks(tasks)
  const finished = finishedTasks(tasks)
  const projectName = (id: string | null) => projects.find((project) => project.id === id)?.name ?? null
  const dragging = dragId ? tasks.find((task) => task.id === dragId && task.state === 'unassigned') ?? null : null
  const assignOptions = bots.map((agent) => ({ value: agent.id, label: agent.name }))

  const meta = (task: BoardTask) => [projectName(task.projectId), task.estimateMinutes ? `about ${task.estimateMinutes} min` : null].filter(Boolean).join(' · ')

  return <div className="delegate-board">
    <section className="delegate-backlog" aria-labelledby="delegate-backlog-title">
      <header className="delegate-head"><h2 id="delegate-backlog-title">Unassigned</h2><span className="delegate-count">{drafts.length}</span></header>
      {drafts.length === 0
        ? <p className="delegate-empty">No drafts. Ask your Manager to plan some work, or add a task.</p>
        : <ul className="delegate-list">{drafts.map((task) => <li key={task.id}>
          <article className={`delegate-draft${dragId === task.id ? ' dragging' : ''}${busy.has(task.id) ? ' busy' : ''}`} draggable={connected && !busy.has(task.id)}
            onDragStart={(event) => { setDragId(task.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', task.id) }}
            onDragEnd={() => { setDragId(null); setOverId(null) }}>
            <button type="button" className="delegate-draft-main" onClick={() => onOpen(task)}>
              <GripVertical size={14} className="delegate-grip" aria-hidden="true" />
              <span className="delegate-draft-text"><strong>{task.title}</strong>{meta(task) && <small>{meta(task)}</small>}</span>
            </button>
            <Select ariaLabel={`Assign ${task.title}`} variant="muted" value="" placeholder="Assign to…" triggerLabel="Assign" disabled={!connected || busy.has(task.id) || bots.length === 0} options={assignOptions}
              onChange={(value) => { const agent = bots.find((item) => item.id === value); if (agent) onAssign(task, agent) }} />
          </article>
        </li>)}</ul>}
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
          <section className={`delegate-lane${dragging ? ' drop-ready' : ''}${over ? ' over' : ''}`} aria-label={`${agent.name}, ${availability.label}`}
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
