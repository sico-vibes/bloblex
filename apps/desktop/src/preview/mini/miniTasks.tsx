// The Tasks views of the Mini skin study: a delegate board (drag a task onto a
// bot), a timeline of what each bot is running, and the Manager's delegation
// tree. Sample data only.
import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUp, CalendarClock, ChevronDown, ChevronRight, Clock, GripVertical, MessageSquare, Repeat, Sparkles, Star, Trash2, X } from 'lucide-react'
import { CRON_PRESETS, PROJECTS, clock, duration, money, nextRuns, type Bot, type Session, type Task, type TaskState } from './miniData'
import { Aura, Logo, STATUS_WORD, botById, useMini, type TasksView } from './miniCore'

const portalHost = () => document.getElementById('mini-portal') ?? document.body
const STATE_WORD: Record<TaskState, string> = { unassigned: 'Draft', queued: 'Queued', running: 'Running', needs_you: 'Needs you', done: 'Done', failed: 'Failed' }
const MIN = 60_000

export function TasksScreen({ light }: { light: boolean }) {
  const { state, act } = useMini()
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(null), 2600); return () => window.clearTimeout(id) }, [toast])
  const bots = state.bots.filter((bot) => !bot.manager)
  const running = state.bots.filter((bot) => bot.status === 'working' || bot.status === 'thinking').length
  const needs = state.bots.filter((bot) => bot.status === 'needs').length
  const failed = state.bots.filter((bot) => bot.status === 'error').length
  const views: { id: TasksView; label: string }[] = [{ id: 'board', label: 'Board' }, { id: 'timeline', label: 'Timeline' }, { id: 'tree', label: 'Tree' }]
  return <div className="tasks">
    <div className="tasks-head">
      <h1>Tasks</h1>
      <div className="seg" role="tablist" aria-label="Tasks view">{views.map((view) => <button key={view.id} role="tab" aria-selected={state.tasksView === view.id} className={state.tasksView === view.id ? 'on' : ''} onClick={() => act.setTasksView(view.id)}>{view.label}</button>)}</div>
      <div className="tasks-counts">
        <span>{bots.length} bots</span>
        {running > 0 && <span className="c-run">{running} running</span>}
        {needs > 0 && <span className="c-needs">{needs} need you</span>}
        {failed > 0 && <span className="c-fail">{failed} failed</span>}
      </div>
      <label className="switch"><span>Pause new runs</span><input type="checkbox" checked={state.paused} onChange={(event) => act.setPaused(event.target.checked)} /><i /></label>
    </div>
    <div className="tasks-body">
      {state.tasksView === 'board' && <Board light={light} onToast={setToast} />}
      {state.tasksView === 'timeline' && <Timeline light={light} />}
      {state.tasksView === 'tree' && <Tree light={light} />}
    </div>
    {state.openTask && <TaskSheet key={state.openTask} light={light} onToast={setToast} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>
}

/* -------------------------------------------------------------------- drag */

/** Pointer-driven drag so the ghost card can tilt and the sidebar's bots can be drop targets too. */
function useTaskDrag(onDrop: (task: Task, target: string) => void) {
  const { act } = useMini()
  const [ghost, setGhost] = useState<{ task: Task; x: number; y: number; dx: number; dy: number; width: number } | null>(null)
  const start = (event: ReactPointerEvent<HTMLElement>, task: Task, onClick: () => void) => {
    if (event.button !== 0) return
    const rect = event.currentTarget.getBoundingClientRect(), x0 = event.clientX, y0 = event.clientY
    let dragging = false, over: string | null = null
    const move = (e: PointerEvent) => {
      if (!dragging && Math.hypot(e.clientX - x0, e.clientY - y0) < 5) return
      dragging = true
      const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-drop]')
      over = target?.dataset.drop ?? null
      act.setDrag(task.id, over)
      setGhost({ task, x: e.clientX, y: e.clientY, dx: x0 - rect.left, dy: y0 - rect.top, width: rect.width })
    }
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      act.setDrag(null, null); setGhost(null)
      if (!dragging) onClick(); else if (over) onDrop(task, over)
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const layer = ghost && createPortal(<div className="drag-ghost" style={{ left: ghost.x - ghost.dx, top: ghost.y - ghost.dy, width: ghost.width }}><TaskCardBody task={ghost.task} /></div>, portalHost())
  return { start, layer }
}

/* ------------------------------------------------------------------- board */

function laneInfo(bot: Bot, tasks: Task[], sessions: Session[], now: number) {
  const mine = tasks.filter((task) => task.assigneeId === bot.id && (task.state === 'running' || task.state === 'queued' || task.state === 'needs_you'))
  let left = 0
  for (const task of mine) {
    if (task.state === 'queued') { left += task.estimateMinutes; continue }
    const session = sessions.find((item) => item.id === task.sessionId)
    const elapsed = session ? (now - session.startMs) / MIN : 0
    left += Math.max(2, task.estimateMinutes - elapsed)
  }
  const cost = bot.ratePerMin === null ? null : mine.reduce((sum, task) => sum + task.estimateMinutes * bot.ratePerMin!, 0)
  return { mine, until: left > 0 ? now + left * MIN : null, cost }
}

function Board({ light, onToast }: { light: boolean; onToast: (text: string) => void }) {
  const { state, act } = useMini()
  const [ask, setAsk] = useState('')
  const [showDone, setShowDone] = useState(false)
  const drafts = state.tasks.filter((task) => task.state === 'unassigned')
  const done = state.tasks.filter((task) => (task.state === 'done' || task.state === 'failed') && task.assigneeId !== 'manager')
  const bots = state.bots.filter((bot) => !bot.manager)
  const manager = state.bots.find((bot) => bot.manager)!
  const { start, layer } = useTaskDrag((task, target) => {
    if (target === 'unassigned') { if (task.state === 'queued') { act.unassign(task.id); onToast('Moved back to Unassigned.') } return }
    if (task.state !== 'unassigned') { onToast(task.state === 'running' ? 'Stop it before moving it.' : 'Only drafts can be assigned.'); return }
    onToast(act.dispatch(task.id, target))
  })
  const queued = bots.reduce((sum, bot) => { const info = laneInfo(bot, state.tasks, state.sessions, state.now); return sum + (info.cost ?? 0) }, 0)
  const draggingTask = state.tasks.find((task) => task.id === state.dragging)
  const submit = (event: FormEvent) => { event.preventDefault(); if (!ask.trim()) return; act.askManager(ask); setAsk(''); onToast('The Manager is drafting it.') }
  const columns = state.variant.board === 'columns'
  return <div className={`board ${columns ? 'board-columns' : 'board-lanes'}`}>
    <section className={`drafts${state.dragOver === 'unassigned' ? ' drop-over' : ''}`} data-drop="unassigned">
      <div className="col-head"><span>Unassigned</span><em>{drafts.length}</em></div>
      <form className="ask-manager" onSubmit={submit}>
        <span className="ask-aura"><Aura bot={manager} status={manager.status} selected={false} kind={state.variant.aura} quiet /></span>
        <Logo bot={manager} size={15} mode={state.logoMode} light={light} />
        <input value={ask} onChange={(event) => setAsk(event.target.value)} placeholder="Ask the Manager to draft a task" aria-label="Ask the Manager to draft a task" />
        <button type="submit" className="send" aria-label="Draft" disabled={!ask.trim()}><ArrowUp size={13} /></button>
      </form>
      {manager.status === 'working' && <div className="drafting"><Sparkles size={13} />Drafting a task…</div>}
      <div className="draft-list">
        {drafts.map((task) => <div key={task.id} className={`task-card${state.dragging === task.id ? ' lifted' : ''}`} onPointerDown={(event) => start(event, task, () => act.openTask(task.id))} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') act.openTask(task.id) }}>
          <TaskCardBody task={task} />
        </div>)}
        {drafts.length === 0 && <p className="empty-note">Everything is handed out.</p>}
      </div>
    </section>
    <section className="lanes">
      <div className="col-head"><span>Bots</span><span className="lanes-cost" title="Estimate from each bot's recent rate">≈ {money(queued)} in queues</span></div>
      <div className="lane-list">
        {bots.map((bot) => {
          const info = laneInfo(bot, state.tasks, state.sessions, state.now)
          const over = state.dragOver === bot.id && !!draggingTask
          const extra = over && draggingTask ? draggingTask.estimateMinutes : 0
          const busy = info.until !== null
          const preview = over && draggingTask && (busy || state.paused
            ? <span className="lane-preview">{bot.ratePerMin !== null && <b>+≈{money(extra * bot.ratePerMin)}</b>}<span>+{extra}m, until {clock((info.until ?? state.now) + extra * MIN)}</span></span>
            : <span className="lane-preview"><b>Starts now</b>{bot.ratePerMin !== null && <span>≈{money(extra * bot.ratePerMin)}</span>}</span>)
          return <div key={bot.id} className={`lane${over ? ' drop-over' : ''}`} data-drop={bot.id}>
            <div className="lane-head">
              <Logo bot={bot} size={20} mode={state.logoMode} light={light} />
              <div className="lane-title"><b>{bot.name}{info.mine.length > 0 && <em>{info.mine.length}</em>}</b><span>{bot.model}{bot.ratePerMin !== null ? ` · ≈${money(bot.ratePerMin)}/min` : ' · no estimate yet'}</span></div>
              {preview || <span className={`lane-state${bot.status === 'needs' ? ' needs' : bot.status === 'error' ? ' fail' : busy ? '' : ' free'}`}>{bot.status === 'needs' ? 'Needs you' : bot.status === 'error' ? 'Failed' : busy ? `Busy until ${clock(info.until!)}` : 'Free'}</span>}
            </div>
            {info.mine.length > 0 && <div className="lane-tasks">
              {info.mine.map((task) => {
                const live = task.state === 'running' || task.state === 'needs_you'
                const status = task.state === 'needs_you' || (live && bot.status === 'needs') ? 'needs' : live ? (bot.status === 'thinking' ? 'thinking' : 'working') : 'idle'
                return <div key={task.id} className={`chip${live ? ' live' : ''}`} onPointerDown={(event) => start(event, task, () => act.openTask(task.id))} role="button" tabIndex={0} title={live ? 'Running' : 'Queued: drag back to Unassigned to take it off'}>
                  {live && <Aura bot={bot} status={status} selected={false} kind={state.variant.aura} quiet />}
                  {task.schedule.kind !== 'none' && <Repeat size={11} />}<span>{task.title}</span>
                </div>
              })}
            </div>}
          </div>
        })}
      </div>
      {done.length > 0 && <div className="finished">
        <button className="finished-toggle" onClick={() => setShowDone(!showDone)}>{showDone ? <ChevronDown size={13} /> : <ChevronRight size={13} />}Finished today <em>{done.length}</em></button>
        {showDone && done.map((task) => { const bot = botById(state.bots, task.assigneeId)!; return <button key={task.id} className="finished-row" onClick={() => act.openTask(task.id)}><Logo bot={bot} size={13} mode={state.logoMode} light={light} /><span>{task.title}</span><em className={task.state === 'failed' ? 'fail' : ''}>{STATE_WORD[task.state]}</em></button> })}
      </div>}
    </section>
    {layer}
  </div>
}

function TaskCardBody({ task }: { task: Task }) {
  const project = PROJECTS.find((item) => item.id === task.projectId)
  const runs = task.schedule.kind === 'repeat' ? nextRuns(task.schedule.cron, new Date(), 1) : null
  return <>
    <GripVertical className="grip" size={13} />
    <div className="task-text">
      <b>{task.title}</b>
      <span className="task-meta">
        {task.origin === 'manager' ? <span className="by-manager"><Star size={9} fill="currentColor" strokeWidth={0} />Manager</span> : <span>You</span>}
        <span>{project?.name}</span><span>~{task.estimateMinutes} min</span>
        {runs && runs[0] && <span className="sched"><Repeat size={10} />{runs[0].toLocaleDateString([], { weekday: 'short' })} {clock(runs[0].getTime())}</span>}
        {task.schedule.kind === 'once' && task.schedule.at && <span className="sched"><CalendarClock size={10} />{new Date(task.schedule.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
      </span>
    </div>
  </>
}

/* --------------------------------------------------------------- task sheet */

function TaskSheet({ light, onToast }: { light: boolean; onToast: (text: string) => void }) {
  const { state, act } = useMini()
  const task = state.tasks.find((item) => item.id === state.openTask)
  const [form, setForm] = useState(task)
  const [assignee, setAssignee] = useState(task?.assigneeId ?? 'claude')
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape') act.openTask(null) }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close) })
  if (!task || !form) return null
  const draft = task.state === 'unassigned'
  const set = (patch: Partial<Task>) => setForm({ ...form, ...patch })
  const runs = form.schedule.kind === 'repeat' ? nextRuns(form.schedule.cron, new Date(), 3) : null
  const bot = botById(state.bots, task.assigneeId)
  const save = () => { act.updateTask(task.id, form); onToast('Saved.'); act.openTask(null) }
  return <>
    <div className="sheet-scrim" onClick={() => act.openTask(null)} />
    <aside className="sheet" role="dialog" aria-label={`Task: ${task.title}`}>
      <div className="sheet-head">
        <span className={`state-tag s-${task.state}`}>{STATE_WORD[task.state]}</span>
        {bot && <span className="sheet-bot"><Logo bot={bot} size={14} mode={state.logoMode} light={light} />{bot.name}</span>}
        <button className="ghost-icon" onClick={() => act.openTask(null)} aria-label="Close"><X size={15} /></button>
      </div>
      <div className="sheet-body">
        <input className="sheet-title" value={form.title} onChange={(event) => set({ title: event.target.value })} aria-label="Title" readOnly={!draft} />
        <Field label="Brief"><textarea rows={4} value={form.brief} onChange={(event) => set({ brief: event.target.value })} readOnly={!draft} /></Field>
        <Field label="Done when"><textarea rows={2} value={form.doneGoal} onChange={(event) => set({ doneGoal: event.target.value })} readOnly={!draft} /></Field>
        <Field label="Report back"><textarea rows={2} value={form.reportBack} onChange={(event) => set({ reportBack: event.target.value })} readOnly={!draft} /></Field>
        <div className="field-row">
          <Field label="Project"><select value={form.projectId} onChange={(event) => set({ projectId: event.target.value })} disabled={!draft}>{PROJECTS.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>
          <Field label="Estimate"><div className="unit"><input type="number" min={1} value={form.estimateMinutes} onChange={(event) => set({ estimateMinutes: Number(event.target.value) || 1 })} readOnly={!draft} /><span>min</span></div></Field>
          <Field label="Time limit"><div className="unit"><input type="number" min={5} max={120} value={form.maxRuntimeMinutes} onChange={(event) => set({ maxRuntimeMinutes: Number(event.target.value) || 30 })} readOnly={!draft} /><span>min</span></div></Field>
        </div>
        <Field label="When it reports back">
          <div className="seg wide">{([['report_only', 'You review'], ['bounded', 'Manager checks, up to 2 rounds'], ['manager_completes', 'Manager finishes it']] as const).map(([id, label]) => <button key={id} className={form.supervision === id ? 'on' : ''} onClick={() => draft && set({ supervision: id })}>{label}</button>)}</div>
        </Field>
        <Field label="Schedule">
          <div className="seg">{([['none', 'Run when assigned'], ['once', 'Once'], ['repeat', 'Repeat']] as const).map(([id, label]) => <button key={id} className={form.schedule.kind === id ? 'on' : ''} onClick={() => set({ schedule: { ...form.schedule, kind: id } })}>{label}</button>)}</div>
          {form.schedule.kind === 'once' && <input type="datetime-local" value={form.schedule.at} onChange={(event) => set({ schedule: { ...form.schedule, at: event.target.value } })} />}
          {form.schedule.kind === 'repeat' && <div className="cron">
            <select value={CRON_PRESETS.find((preset) => preset.cron === form.schedule.cron)?.cron ?? 'custom'} onChange={(event) => event.target.value !== 'custom' && set({ schedule: { ...form.schedule, cron: event.target.value } })}>
              {CRON_PRESETS.map((preset) => <option key={preset.cron} value={preset.cron}>{preset.label}</option>)}<option value="custom">Custom</option>
            </select>
            <input className="mono" value={form.schedule.cron} onChange={(event) => set({ schedule: { ...form.schedule, cron: event.target.value } })} aria-label="Cron expression" spellCheck={false} />
            <div className={`next-runs${runs ? '' : ' bad'}`}>{runs ? <><Clock size={12} />Next: {runs.map((run) => run.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })).join(' · ')}</> : 'That is not a schedule Bitbots can read. Use five fields: minute hour day month weekday.'}</div>
          </div>}
          {form.schedule.kind !== 'none' && <p className="hint">Runs only while Bitbots is open. A missed run is skipped, not run late. Each run keeps the time limit above and never bypasses approvals.</p>}
        </Field>
        {task.costSoFar !== null && <p className="hint">So far: {money(task.costSoFar)} (estimate)</p>}
      </div>
      <div className="sheet-foot">
        {draft ? <>
          <button className="danger" onClick={() => { act.removeTask(task.id); onToast('Draft deleted.') }}><Trash2 size={13} />Delete</button>
          <span className="fill" />
          <select value={assignee} onChange={(event) => setAssignee(event.target.value)} aria-label="Bot">{state.bots.filter((item) => !item.manager).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <button onClick={() => { act.updateTask(task.id, form); onToast(act.dispatch(task.id, assignee)); act.openTask(null) }}>Assign</button>
          <button className="primary" onClick={save}>Save</button>
        </> : <>
          {task.state === 'queued' && <button onClick={() => { act.unassign(task.id); act.openTask(null); onToast('Moved back to Unassigned.') }}>Move to Unassigned</button>}
          <span className="fill" />
          {bot && <button onClick={() => { act.select(bot.id); act.setScreen('chat'); act.openTask(null) }}><MessageSquare size={13} />Open conversation</button>}
          <button className="primary" onClick={save}>Save schedule</button>
        </>}
      </div>
    </aside>
  </>
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>
}

/* ---------------------------------------------------------------- timeline */

const RANGES = [{ id: 30, label: '30m', tick: 5 }, { id: 120, label: '2h', tick: 15 }, { id: 480, label: '8h', tick: 60 }]

function Timeline({ light }: { light: boolean }) {
  const { state, act } = useMini()
  const [range, setRange] = useState(30)
  const [offset, setOffset] = useState(0)
  const [tip, setTip] = useState<{ session: Session; x: number; y: number; pinned: boolean } | null>(null)
  const track = useRef<HTMLDivElement>(null)
  const tick = RANGES.find((item) => item.id === range)!.tick
  const end = state.now - offset * MIN, startMs = end - range * MIN
  const pos = (ms: number) => ((ms - startMs) / (range * MIN)) * 100
  const bots = state.bots
  useEffect(() => { if (!tip?.pinned) return; const close = (event: MouseEvent) => { if (!(event.target as HTMLElement).closest('.tl-tip, .tl-bar')) setTip(null) }; window.addEventListener('mousedown', close); return () => window.removeEventListener('mousedown', close) }, [tip])
  const pan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.tl-bar')) return
    const width = track.current?.getBoundingClientRect().width ?? 1, x0 = event.clientX, o0 = offset
    const move = (e: PointerEvent) => setOffset(Math.max(0, Math.min(600, o0 + ((e.clientX - x0) / width) * range)))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const ticks: number[] = []
  for (let m = Math.ceil((offset + 0.0001) / tick) * tick; m < offset + range; m += tick) ticks.push(m)
  const tipBot = tip && botById(state.bots, tip.session.botId)
  return <div className="timeline">
    <div className="tl-bar-head">
      <span className="tl-legend"><i className="dot run" />{state.sessions.filter((s) => s.state === 'running').length} running<i className="dot needs" />{state.sessions.filter((s) => s.state === 'needs').length} need you</span>
      <span className="fill" />
      {offset > 0 && <button className="small" onClick={() => setOffset(0)}>Back to now</button>}
      <div className="seg">{RANGES.map((item) => <button key={item.id} className={range === item.id ? 'on' : ''} onClick={() => { setRange(item.id); setOffset(0) }}>Last {item.label}</button>)}</div>
    </div>
    <div className="tl-grid">
      <div className="tl-labels">
        <div className="tl-axis-pad" />
        {bots.map((bot) => {
          const live = state.sessions.some((s) => s.botId === bot.id && s.endMs === null)
          return <button key={bot.id} className="tl-label" onClick={() => { act.select(bot.id); act.setScreen('chat') }}>
            <Logo bot={bot} size={18} mode={state.logoMode} light={light} />
            <span><b>{bot.name}</b><small>{bot.model}{(bot.status === 'needs' || bot.status === 'error' || !live) && <em className={`m-${bot.status}`}>{bot.status === 'needs' ? 'Needs you' : bot.status === 'error' ? 'Failed' : 'Idle'}</em>}</small></span>
          </button>
        })}
      </div>
      <div className="tl-track" ref={track} onPointerDown={pan}>
        <div className="tl-axis">
          {ticks.map((m) => <span key={m} style={{ left: `${100 - ((m - offset) / range) * 100}%` }}>−{m >= 60 ? `${m / 60}h` : `${m}m`}</span>)}
          {offset === 0 && <span className="now">now</span>}
        </div>
        {ticks.map((m) => <i key={m} className="tl-line" style={{ left: `${100 - ((m - offset) / range) * 100}%` }} />)}
        {bots.map((bot) => <div key={bot.id} className="tl-row">
          {state.sessions.filter((session) => session.botId === bot.id).map((session) => {
            const sEnd = session.endMs ?? state.now
            if (sEnd < startMs || session.startMs > end) return null
            const left = Math.max(0, pos(session.startMs)), right = Math.min(100, pos(sEnd))
            const live = session.endMs === null
            const status = session.state === 'needs' || (live && bot.status === 'needs') ? 'needs' : session.state === 'error' ? 'error' : live ? 'working' : 'idle'
            return <button key={session.id} className={`tl-bar s-${session.state}${live ? ' live' : ''}`} style={{ left: `${left}%`, width: `calc(${Math.max(0.6, right - left)}% )` }}
              onMouseEnter={(event) => !tip?.pinned && setTip({ session, x: event.clientX, y: event.currentTarget.getBoundingClientRect().bottom, pinned: false })}
              onMouseMove={(event) => !tip?.pinned && setTip({ session, x: event.clientX, y: event.currentTarget.getBoundingClientRect().bottom, pinned: false })}
              onMouseLeave={() => !tip?.pinned && setTip(null)}
              onClick={(event) => setTip({ session, x: event.clientX, y: event.currentTarget.getBoundingClientRect().bottom, pinned: true })}>
              {(live || session.state === 'error') && <Aura bot={bot} status={status} selected={false} kind={state.variant.aura} />}
              <span>{session.title}</span>
              {status === 'needs' && <em>Needs you</em>}
            </button>
          })}
        </div>)}
      </div>
    </div>
    <p className="hint tl-hint">Drag the timeline to look back. Click a session to keep its details open.</p>
    {tip && tipBot && createPortal(<div className={`tl-tip${tip.pinned ? ' pinned' : ''}`} style={{ left: Math.min(tip.x - 20, window.innerWidth - 300), top: tip.y + 8 }}>
      <b>{tip.session.title}</b>
      <span className="tl-tip-meta">{tipBot.name} · {tip.session.state === 'running' ? 'Running' : tip.session.state === 'needs' ? 'Needs you' : tip.session.state === 'error' ? 'Failed' : 'Done'} · {duration((tip.session.endMs ?? state.now) - tip.session.startMs)}</span>
      <span className="tl-tip-meta">Started {clock(tip.session.startMs)} · {PROJECTS.find((p) => p.id === tip.session.projectId)?.name}</span>
      <ul>{tip.session.steps.map((step) => <li key={step}>{step}</li>)}</ul>
      {tip.pinned && <button className="small" onClick={() => { act.select(tipBot.id); act.setScreen('chat') }}><MessageSquare size={12} />Open conversation</button>}
    </div>, portalHost())}
  </div>
}

/* -------------------------------------------------------------------- tree */

function Tree({ light }: { light: boolean }) {
  const { state, act } = useMini()
  const [focus, setFocus] = useState<string | null>(null)
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [rootId, setRootId] = useState('t-root')
  const manager = state.bots.find((bot) => bot.manager)!
  const board = useMemo(() => state.tasks.filter((task) => task.parentId === null && task.assigneeId && task.assigneeId !== 'manager'), [state.tasks])
  const root = state.tasks.find((task) => task.id === rootId)
  const kids = (id: string) => state.tasks.filter((task) => task.parentId === id && task.state !== 'unassigned')
  const top = rootId === 'board' ? board : kids(rootId)
  const all = (id: string): Task[] => kids(id).flatMap((task) => [task, ...all(task.id)])
  const family = rootId === 'board' ? board.flatMap((task) => [task, ...all(task.id)]) : all(rootId)
  const total = family.reduce((sum, task) => sum + (task.costSoFar ?? 0), rootId === 't-root' ? root?.costSoFar ?? 0 : 0)
  const rootSession = state.sessions.find((item) => item.id === root?.sessionId)
  const toggle = (id: string) => setClosed((set) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const focusTask = state.tasks.find((task) => task.id === focus)
  const node = (task: Task): ReactNode => {
    const bot = botById(state.bots, task.assigneeId)!
    const session = state.sessions.find((item) => item.id === task.sessionId)
    const children = kids(task.id)
    const live = task.state === 'running' || task.state === 'needs_you'
    const status = live ? (bot.status === 'needs' ? 'needs' : bot.status === 'thinking' ? 'thinking' : 'working') : task.state === 'failed' ? 'error' : 'idle'
    return <>
      <button className={`tnode s-${task.state}${focus === task.id ? ' focus' : ''}`} onClick={() => setFocus(task.id)}>
        {(live || task.state === 'failed') && <Aura bot={bot} status={status} selected={focus === task.id} kind={state.variant.aura} quiet={!live} />}
        <span className="tnode-head"><Logo bot={bot} size={18} mode={state.logoMode} light={light} /><span className="tnode-who"><b>{bot.name}</b><small>{bot.model}</small></span><span className={`state-tag s-${task.state}`}>{STATE_WORD[task.state]}</span></span>
        <span className="tnode-task">{task.title}</span>
        <span className="tnode-foot"><span>{task.costSoFar !== null ? `≈${money(task.costSoFar)}` : '—'}{session ? ` · ${duration((session.endMs ?? state.now) - session.startMs)}` : task.state === 'queued' ? ' · waiting' : ''}</span>
          {children.length > 0 && <span className="tnode-kids" role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); toggle(task.id) }}>{children.length}{closed.has(task.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>}</span>
      </button>
      {children.length > 0 && !closed.has(task.id) && <div className="tsub">{children.map((child) => <div key={child.id} className="tsub-item">{node(child)}</div>)}</div>}
    </>
  }
  return <div className="tree">
    <div className="tl-bar-head">
      <div className="seg">
        <button className={rootId === 't-root' ? 'on' : ''} onClick={() => setRootId('t-root')}>Launch the pricing page</button>
        <button className={rootId === 'board' ? 'on' : ''} onClick={() => setRootId('board')}>From the board</button>
      </div>
      <span className="fill" /><span className="tree-total">≈ {money(total)} so far · {family.length} tasks</span>
    </div>
    <div className="tree-scroll">
      <div className="tree-canvas">
        <button className={`tnode root${manager.status !== 'idle' ? ' live' : ''}`} onClick={() => setFocus(null)}>
          <Aura bot={manager} status={manager.status === 'idle' ? (rootId === 't-root' ? 'working' : 'idle') : manager.status} selected={false} kind={state.variant.aura} />
          <span className="tnode-head"><Logo bot={manager} size={18} mode={state.logoMode} light={light} /><span className="tnode-who"><b>Manager</b><small>{manager.model}</small></span><span className="state-tag s-running">{rootId === 't-root' ? 'Running' : 'Board'}</span></span>
          <span className="tnode-task">{rootId === 't-root' ? root?.title : 'Tasks you assigned from the board'}</span>
          <span className="tnode-foot"><span>{rootId === 't-root' ? `≈${money(total)} · ${rootSession ? duration(state.now - rootSession.startMs) : ''}` : `${board.length} tasks`}</span><span className="tnode-kids">{top.length}<ChevronDown size={12} /></span></span>
        </button>
        {top.length > 0 ? <div className="tkids">{top.map((task) => <div key={task.id} className="tbranch">{node(task)}</div>)}</div> : <p className="empty-note">Nothing assigned from the board yet. Drag a task onto a bot on the Board.</p>}
      </div>
    </div>
    {focusTask && <Conversation task={focusTask} light={light} onClose={() => setFocus(null)} onOpen={(bot) => { act.select(bot.id); act.setScreen('chat') }} />}
  </div>
}

function Conversation({ task, light, onClose, onOpen }: { task: Task; light: boolean; onClose: () => void; onOpen: (bot: Bot) => void }) {
  const { state, act } = useMini()
  const bot = botById(state.bots, task.assigneeId)!, manager = state.bots.find((item) => item.manager)!
  const session = state.sessions.find((item) => item.id === task.sessionId)
  const parent = state.tasks.find((item) => item.id === task.parentId)
  return <aside className="convo" aria-label={`Manager and ${bot.name}`}>
    <div className="convo-head"><Logo bot={manager} size={16} mode={state.logoMode} light={light} /><ChevronRight size={13} /><Logo bot={bot} size={16} mode={state.logoMode} light={light} /><b>Manager and {bot.name}</b><button className="ghost-icon" onClick={onClose} aria-label="Close"><X size={14} /></button></div>
    <div className="convo-body">
      {parent && parent.assigneeId !== 'manager' && <p className="hint">Drafted from {botById(state.bots, parent.assigneeId)?.name}’s report on “{parent.title}”.</p>}
      <div className="cmsg mgr"><span className="cwho">Manager</span>{task.brief}<span className="cgoal">Done when: {task.doneGoal}</span></div>
      {session?.steps.map((step) => <div key={step} className="cstep">{step}</div>)}
      {task.state === 'queued' && <div className="cstep">Queued. Starts when {bot.name} is free.</div>}
      {task.state === 'done' && <div className="cmsg bot"><span className="cwho">{bot.name}</span>Done. {session?.steps[session.steps.length - 1]}. The Manager checked it against the goal.</div>}
      {task.state === 'failed' && <div className="cmsg bot fail"><span className="cwho">{bot.name}</span>{session?.steps[session.steps.length - 1]}. The Manager drafted a follow-up task.</div>}
      {bot.status === 'needs' && (task.state === 'running' || task.state === 'needs_you') && <div className="cmsg bot needs"><span className="cwho">{bot.name}</span>Waiting for your approval.</div>}
    </div>
    <div className="convo-foot">
      <span className={`m-${bot.status}`}>{STATUS_WORD[bot.status]}</span><span className="fill" />
      <button className="small" onClick={() => act.openTask(task.id)}>Task details</button>
      <button className="small primary" onClick={() => onOpen(bot)}><MessageSquare size={12} />Open conversation</button>
    </div>
  </aside>
}
