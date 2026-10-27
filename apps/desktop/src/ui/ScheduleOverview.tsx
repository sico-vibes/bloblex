// Every schedule that will wake a bot by itself, in one read-only list: the automations and the board tasks that
// repeat or run later. Each row says what the daemon recorded (next run, last outcome, whether it is running, paused
// or off, the time limit it runs under) and links to the real run's conversation. Editing stays on the Schedules and
// Tasks pages, where the unattended limits are set.
import { useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, CalendarClock } from 'lucide-react'
import type { Agent, Automation, BoardTask, TaskScheduleOutcome } from '../types'
import { isAutomation } from '../types'
import { rpc } from '../tauri'
import { RUN_STATUS_LABEL, describeNextRun, describeSchedule } from './automationSchedule'
import { scheduledTasks } from './taskModel'
import './scheduleOverview.css'

type Row = { key: string; kind: 'Automation' | 'Task'; name: string; agent: string; when: string; next: string; state: 'running' | 'active' | 'paused' | 'off'; stateLabel: string; last: string | null; limit: string | null; sessionId: string | null }

const OUTCOME: Record<TaskScheduleOutcome, string> = { started: 'Started', queued: 'Queued', skipped_late: 'Skipped (late)', skipped_paused: 'Skipped (paused)', skipped_overlap: 'Skipped (still running)', failed_to_start: 'Could not start', invalid_schedule: 'Invalid schedule' }
const PAUSE_REASON: Record<string, string> = { user: 'Paused by you', auto_failures: 'Paused after repeated failures', needs_approval: 'Paused: needs your approval' }

function minutes(secs: number | undefined | null) {
  if (!secs || secs <= 0) return null
  return secs >= 3600 && secs % 3600 === 0 ? `${secs / 3600} h limit` : `${Math.round(secs / 60)} min limit`
}

export type ScheduleScope = { agentId: string | null; projectId: string | null }

export function scheduleRows(automations: readonly Automation[], tasks: readonly BoardTask[], agents: readonly Agent[], nowMs: number, scope: ScheduleScope | null = null): Row[] {
  const name = (id: string | null | undefined) => agents.find((agent) => agent.id === id)?.name ?? 'A bot'
  const mineAutomation = (automation: Automation) => !scope || (!!scope.agentId && automation.agentId === scope.agentId)
  const mineTask = (task: BoardTask) => !scope || (!!scope.agentId && task.scheduleAgentId === scope.agentId) || (!!scope.projectId && task.projectId === scope.projectId)
  const rows: Row[] = automations.filter(mineAutomation).map((automation) => {
    const state: Row['state'] = automation.running ? 'running' : automation.enabled ? 'active' : automation.pauseReason ? 'paused' : 'off'
    const last = automation.lastRun
    return {
      key: `a-${automation.id}`, kind: 'Automation', name: automation.name, agent: name(automation.agentId), when: describeSchedule(automation.schedule),
      next: automation.enabled ? describeNextRun(automation.nextRunAt, nowMs) : '',
      state, stateLabel: state === 'running' ? 'Running now' : state === 'active' ? 'On' : state === 'paused' ? PAUSE_REASON[automation.pauseReason ?? ''] ?? 'Paused' : 'Off',
      last: last ? `${RUN_STATUS_LABEL[last.status] ?? last.status}` : null, limit: minutes(automation.maxRuntimeSecs), sessionId: last?.sessionId ?? null,
    }
  })
  for (const task of scheduledTasks(tasks).filter(mineTask)) {
    rows.push({
      key: `t-${task.id}`, kind: 'Task', name: task.title, agent: name(task.scheduleAgentId), when: task.schedule ? describeSchedule(task.schedule.kind === 'once' ? { kind: 'once', at: task.schedule.at } : task.schedule) : '',
      next: describeNextRun(task.scheduleNextAt, nowMs), state: 'active', stateLabel: 'On',
      last: task.scheduleLastOutcome ? OUTCOME[task.scheduleLastOutcome] ?? task.scheduleLastOutcome : null, limit: minutes(task.maxRuntimeSecs), sessionId: null,
    })
  }
  return rows.sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1))
}

/** `scope` limits the list to one bot (and its project's scheduled tasks); without it every schedule is listed, as the Manager sees them. `compact` is the rail's smaller list. */
export function ScheduleOverview({ agents, connected, onOpenSession, scope = null, compact = false, onOpenSchedules }: { agents: readonly Agent[]; connected: boolean; onOpenSession?: (sessionId: string) => void; scope?: ScheduleScope | null; compact?: boolean; onOpenSchedules?: () => void }) {
  const [automations, setAutomations] = useState<Automation[] | null>(null)
  const [tasks, setTasks] = useState<BoardTask[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!connected) return
    let live = true
    setProblem(null)
    void Promise.allSettled([rpc<{ automations?: unknown[] }>('automation.list', {}), rpc<{ tasks?: BoardTask[] }>('task.list', {})]).then(([a, t]) => {
      if (!live) return
      if (a.status === 'fulfilled') setAutomations((a.value?.automations ?? []).filter(isAutomation)); else setProblem('Schedules could not be read.')
      if (t.status === 'fulfilled') setTasks(t.value?.tasks ?? [])
    })
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    // Runs start and end on their own, so the list is read again now and then while it is on screen.
    const reload = window.setInterval(() => {
      void Promise.allSettled([rpc<{ automations?: unknown[] }>('automation.list', {}), rpc<{ tasks?: BoardTask[] }>('task.list', {})]).then(([a, t]) => {
        if (!live) return
        if (a.status === 'fulfilled') setAutomations((a.value?.automations ?? []).filter(isAutomation))
        if (t.status === 'fulfilled') setTasks(t.value?.tasks ?? [])
      })
    }, 60_000)
    return () => { live = false; window.clearInterval(timer); window.clearInterval(reload) }
  }, [connected])
  const rows = useMemo(() => scheduleRows(automations ?? [], tasks, agents, now, scope), [automations, tasks, agents, now, scope?.agentId, scope?.projectId])
  return <section className={`schedule-overview${compact ? ' compact' : ''}`} {...(compact ? { 'aria-label': 'Schedules' } : { 'aria-labelledby': 'schedule-overview-title' })}>
    {!compact && <h3 id="schedule-overview-title"><CalendarClock size={14} aria-hidden="true" />Schedules</h3>}
    {problem && <p className="schedule-overview-note" role="alert">{problem}</p>}
    {!automations && !problem && <p className="schedule-overview-note">Reading schedules…</p>}
    {automations && !rows.length && <p className="schedule-overview-note">{scope ? 'Nothing is scheduled for this bot or project.' : 'Nothing is scheduled.'} Bots only start work by themselves when you set a schedule on the Schedules or Tasks page.</p>}
    {compact && onOpenSchedules && <button type="button" className="rail-link" onClick={onOpenSchedules}>Open schedules</button>}
    {rows.length > 0 && <ul>{rows.map((row) => <li key={row.key} data-state={row.state}>
      <div className="schedule-overview-main"><strong>{row.name}</strong><small>{row.agent} · {row.when || 'No time set'}{row.limit ? ` · ${row.limit}` : ''}</small></div>
      <div className="schedule-overview-facts">
        <span className="schedule-overview-state">{row.stateLabel}</span>
        <span>{row.next ? `Next ${row.next}` : row.state === 'running' ? 'In progress' : 'No next run'}</span>
        <span>{row.last ? `Last: ${row.last}` : 'Not run yet'}</span>
      </div>
      {row.sessionId && onOpenSession && <button type="button" className="schedule-overview-open" onClick={() => onOpenSession(row.sessionId!)} aria-label={`Open the last run of ${row.name}`}>Last run<ArrowUpRight size={12} aria-hidden="true" /></button>}
    </li>)}</ul>}
  </section>
}
