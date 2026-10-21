// Timeline: one lane per bot over a time axis ending now. Bars come only from observed timestamps: a queue wait from assignedAt to the run's
// observed start, and the work itself from startedAt to endedAt (or now while it is still going). A run with no observed start is not drawn.
import { useMemo, useState } from 'react'
import type { Agent, BoardTask, BoardTaskRun } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentLook } from '../blob/look'
import { agentColorHex } from './agentColor'
import { TASK_STATE_LABEL, assignableAgents } from './taskModel'

export const TIMELINE_RANGES = [{ minutes: 30, label: '30 minutes', step: 5 }, { minutes: 120, label: '2 hours', step: 20 }, { minutes: 1440, label: '24 hours', step: 240 }] as const

export interface TimelineBar { key: string; task: BoardTask; kind: 'queued' | 'work'; tone: string; label: string; startMs: number; endMs: number; row: number }

const toneFor = (state: string) => state === 'running' ? 'running' : state === 'awaiting_review' || state === 'needs_you' ? 'attention' : state === 'done' ? 'done' : state === 'failed' ? 'failed' : state === 'cancelled' ? 'cancelled' : 'queued'

/** Bars for one bot inside [fromMs, nowMs], packed into rows so overlapping attempts do not hide each other. */
export function timelineBars(tasks: readonly BoardTask[], runsByTask: Readonly<Record<string, readonly BoardTaskRun[]>>, agentId: string, fromMs: number, nowMs: number): { bars: TimelineBar[]; rows: number; unplaced: number } {
  const raw: Omit<TimelineBar, 'row'>[] = []
  let unplaced = 0
  for (const task of tasks) {
    const runs = (runsByTask[task.id] ?? []).filter((run) => (run.assigneeAgentId ?? task.assigneeAgentId) === agentId)
    if (runs.length === 0 && task.assigneeAgentId === agentId && task.state === 'queued' && task.assignedAt) {
      const startMs = Date.parse(task.assignedAt)
      if (!Number.isNaN(startMs)) raw.push({ key: `${task.id}:wait`, task, kind: 'queued', tone: 'queued', label: `${task.title} · queued`, startMs, endMs: nowMs })
      continue
    }
    for (const run of runs) {
      const started = run.startedAt ? Date.parse(run.startedAt) : NaN
      if (Number.isNaN(started)) { unplaced += 1; continue }
      if (run.attempt === 1 && task.assignedAt) {
        const assigned = Date.parse(task.assignedAt)
        if (!Number.isNaN(assigned) && assigned < started) raw.push({ key: `${run.id}:wait`, task, kind: 'queued', tone: 'queued', label: `${task.title} · queued`, startMs: assigned, endMs: started })
      }
      const live = run.state === 'running' || run.state === 'needs_you'
      const ended = run.endedAt ? Date.parse(run.endedAt) : live || run.state === 'awaiting_review' ? nowMs : NaN
      if (Number.isNaN(ended)) { unplaced += 1; continue }
      raw.push({ key: run.id, task, kind: 'work', tone: toneFor(String(run.state)), label: `${task.title} · ${TASK_STATE_LABEL[run.state as keyof typeof TASK_STATE_LABEL] ?? run.state}`, startMs: started, endMs: ended })
    }
  }
  const visible = raw.filter((bar) => bar.endMs >= fromMs && bar.startMs <= nowMs).sort((a, b) => a.startMs - b.startMs)
  const rowEnds: number[] = []
  const bars = visible.map((bar) => {
    let row = rowEnds.findIndex((end) => end <= bar.startMs)
    if (row < 0) { row = rowEnds.length; rowEnds.push(bar.endMs) } else rowEnds[row] = bar.endMs
    return { ...bar, row }
  })
  return { bars, rows: Math.max(1, rowEnds.length), unplaced }
}

const tickLabel = (minutesAgo: number) => minutesAgo === 0 ? 'now' : minutesAgo < 60 ? `-${minutesAgo}m` : `-${Math.floor(minutesAgo / 60)}h${minutesAgo % 60 ? ` ${minutesAgo % 60}m` : ''}`

export interface TaskTimelineProps { tasks: readonly BoardTask[]; runsByTask: Readonly<Record<string, readonly BoardTaskRun[]>>; agents: readonly Agent[]; nowMs: number; onOpen: (task: BoardTask) => void }

export function TaskTimeline({ tasks, runsByTask, agents, nowMs, onOpen }: TaskTimelineProps) {
  const [rangeIndex, setRangeIndex] = useState(0)
  const range = TIMELINE_RANGES[rangeIndex]
  const fromMs = nowMs - range.minutes * 60_000
  const lanes = useMemo(() => assignableAgents(agents).sort((a, b) => a.sortOrder - b.sortOrder).map((agent) => ({ agent, ...timelineBars(tasks, runsByTask, agent.id, fromMs, nowMs) })).filter((lane) => lane.bars.length > 0), [agents, tasks, runsByTask, fromMs, nowMs])
  const unplaced = lanes.reduce((sum, lane) => sum + lane.unplaced, 0)
  const ticks = Array.from({ length: Math.floor(range.minutes / range.step) + 1 }, (_, index) => range.minutes - index * range.step)
  const pct = (ms: number) => Math.min(100, Math.max(0, ((ms - fromMs) / (nowMs - fromMs)) * 100))

  return <div className="task-timeline">
    <div className="timeline-controls">
      <span className="timeline-caption">Recorded activity, last {range.label}</span>
      <div className="segmented" role="radiogroup" aria-label="Time range">{TIMELINE_RANGES.map((option, index) => <button key={option.minutes} type="button" role="radio" aria-checked={index === rangeIndex} className={index === rangeIndex ? 'on' : undefined} onClick={() => setRangeIndex(index)}>{option.label}</button>)}</div>
    </div>
    {lanes.length === 0
      ? <p className="delegate-empty">Nothing was recorded in the last {range.label}. Bars appear here when a bot starts or queues a task.</p>
      : <div className="timeline-grid">
        <div className="timeline-axis" aria-hidden="true"><span className="timeline-axis-spacer" /><div className="timeline-axis-track">{ticks.map((minutes) => <span key={minutes} className="timeline-tick" style={{ left: `${(1 - minutes / range.minutes) * 100}%` }}>{tickLabel(minutes)}</span>)}</div></div>
        {lanes.map(({ agent, bars, rows }) => <div key={agent.id} className="timeline-lane">
          <div className="timeline-who"><span className="timeline-face" aria-hidden="true"><BlobCanvas decorative color={agentColorHex(agent.color)} size={22} mini look={agentLook(agent)} label={agent.name} /></span><strong>{agent.name}</strong></div>
          <div className="timeline-track" style={{ height: rows * 30 + 6 }}>
            {ticks.map((minutes) => <span key={minutes} className="timeline-gridline" style={{ left: `${(1 - minutes / range.minutes) * 100}%` }} aria-hidden="true" />)}
            {bars.map((bar) => { const left = pct(bar.startMs); const width = Math.max(0.8, pct(bar.endMs) - left); return <button key={bar.key} type="button" className={`timeline-bar tone-${bar.tone} ${bar.kind}`} style={{ left: `${left}%`, width: `${width}%`, top: 3 + bar.row * 30 }} title={bar.label} aria-label={bar.label} onClick={() => onOpen(bar.task)}><span>{bar.task.title}</span></button> })}
          </div>
        </div>)}
        {unplaced > 0 && <p className="timeline-note">{unplaced} {unplaced === 1 ? 'run has' : 'runs have'} no recorded start or end and {unplaced === 1 ? 'is' : 'are'} not drawn.</p>}
      </div>}
  </div>
}
