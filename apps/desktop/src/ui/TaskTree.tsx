// Objective tree: each task is a node under the task it was split from (parentTaskId), joined by connectors. Tasks with no parent and
// no children are listed separately. Finished branches start collapsed.
import { useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Agent, BoardTask } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentLook } from '../blob/look'
import { agentColorHex } from './agentColor'
import { TASK_STATE_LABEL, elapsedLabel, isFinished } from './taskModel'

export interface TaskTreeProps { tasks: readonly BoardTask[]; agents: readonly Agent[]; nowMs: number; onOpen: (task: BoardTask) => void }

export function buildTaskForest(tasks: readonly BoardTask[]) {
  const ids = new Set(tasks.map((task) => task.id))
  const children = new Map<string, BoardTask[]>()
  const roots: BoardTask[] = []
  for (const task of tasks) {
    if (task.parentTaskId && ids.has(task.parentTaskId)) children.set(task.parentTaskId, [...(children.get(task.parentTaskId) ?? []), task])
    else roots.push(task)
  }
  const order = (a: BoardTask, b: BoardTask) => a.createdAt.localeCompare(b.createdAt)
  for (const list of children.values()) list.sort(order)
  roots.sort(order)
  return { trees: roots.filter((task) => children.has(task.id)), standalone: roots.filter((task) => !children.has(task.id)), children }
}

const allFinished = (task: BoardTask, children: Map<string, BoardTask[]>): boolean => isFinished(task) && (children.get(task.id) ?? []).every((child) => allFinished(child, children))

export function TaskTree({ tasks, agents, nowMs, onOpen }: TaskTreeProps) {
  const forest = useMemo(() => buildTaskForest(tasks), [tasks])
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set())
  const flip = (id: string) => setToggled((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const agentFor = (task: BoardTask) => agents.find((agent) => agent.id === task.assigneeAgentId)

  const node = (task: BoardTask) => {
    const kids = forest.children.get(task.id) ?? []
    const collapsed = kids.length > 0 && (allFinished(task, forest.children) ? !toggled.has(task.id) : toggled.has(task.id))
    const agent = agentFor(task)
    const took = task.startedAt ? elapsedLabel(task.startedAt, task.completedAt, nowMs) : null
    return <li key={task.id}>
      <div className={`tree-node tone-${task.state}`}>
        <button type="button" className="tree-card" onClick={() => onOpen(task)}>
          <span className="tree-card-top">
            <span className="tree-face" aria-hidden="true">{agent ? <BlobCanvas decorative color={agentColorHex(agent.color)} size={22} mini mood={task.state === 'running' ? 'working' : 'idle'} look={agentLook(agent)} label={agent.name} /> : <span className="tree-face-empty" />}</span>
            <span className="tree-agent">{agent?.name ?? 'Unassigned'}</span>
            <span className="tree-state"><span className="delegate-dot" aria-hidden="true" />{TASK_STATE_LABEL[task.state]}</span>
          </span>
          <strong className="tree-title">{task.title}</strong>
          {took && <small className="tree-time">{task.completedAt ? 'Took' : 'Running for'} {took}</small>}
        </button>
        {kids.length > 0 && <button type="button" className="tree-toggle" aria-expanded={!collapsed} aria-label={`${collapsed ? 'Show' : 'Hide'} ${kids.length} ${kids.length === 1 ? 'task' : 'tasks'} under ${task.title}`} onClick={() => flip(task.id)}><ChevronDown size={13} aria-hidden="true" className={collapsed ? '' : 'open'} />{kids.length}</button>}
      </div>
      {kids.length > 0 && !collapsed && <ul>{kids.map(node)}</ul>}
    </li>
  }

  if (tasks.length === 0) return <p className="delegate-empty">No tasks yet. Drafts and assigned work appear here once they exist.</p>
  return <div className="task-tree-wrap">
    {forest.trees.length > 0 && <div className="task-tree" aria-label="Objective tree">{forest.trees.map((root) => <ul key={root.id}>{node(root)}</ul>)}</div>}
    {forest.standalone.length > 0 && <section className="tree-standalone" aria-label="Tasks without a parent">
      <h3>{forest.trees.length ? 'Standalone tasks' : 'Tasks'}</h3>
      <ul>{forest.standalone.map((task) => node(task))}</ul>
    </section>}
  </div>
}
