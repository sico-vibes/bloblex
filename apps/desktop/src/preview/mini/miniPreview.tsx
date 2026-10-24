// Development-only design study for the Mini skin: bots without mascots, shown
// by their runtime logo and name, with an animated gradient as the status
// indicator, a frosted cohesive shell, a simpler companion and the Tasks views
// (board, timeline, tree). Three directions at /preview1, /preview2, /preview3.
// Nothing here is wired into the app.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import ReactDOM from 'react-dom/client'
import {
  ArrowUp, Check, ChevronDown, ChevronRight, CircleAlert, Ellipsis, FolderClosed, KanbanSquare, LayoutGrid, Mic, Minus, Moon, Paperclip,
  Pause, Play, Plus, RotateCcw, Search, Settings, SquarePen, Sun, X,
} from 'lucide-react'
import { BOTS, PROJECTS, SESSION_MESSAGES, TASKS, draftFromAsk, makeSessions, type Bot, type LogoMode, type Status } from './miniData'
import { Aura, Logo, MiniContext, STATUS_WORD, VARIANTS, botById, useMini, type MiniActions, type MiniState, type Screen, type TasksView } from './miniCore'
import { TasksScreen } from './miniTasks'
import './mini.css'

const variant = VARIANTS.find((item) => item.id === document.body.dataset.variant) ?? VARIANTS[0]
const query = new URLSearchParams(location.search)
const DEMO: { status: Status; ms: number }[] = [
  { status: 'idle', ms: 3500 }, { status: 'thinking', ms: 4000 }, { status: 'working', ms: 6000 }, { status: 'needs', ms: 5000 },
  { status: 'working', ms: 4000 }, { status: 'done', ms: 2600 },
]
const SWATCHES = ['#ef8354', '#f2a93b', '#e7b24a', '#3fcf9c', '#4cc3e8', '#7c9bff', '#b48cf2', '#f06ba8', '#ef5b4c', '#9aa3ad']

function useStore() {
  const [bots, setBots] = useState(BOTS)
  const [tasks, setTasks] = useState(TASKS)
  const [sessions, setSessions] = useState(() => makeSessions(Date.now()))
  const [selected, select] = useState<string | null>('claude')
  const [screen, setScreen] = useState<Screen>(query.get('screen') === 'tasks' ? 'tasks' : 'chat')
  const [tasksView, setTasksView] = useState<TasksView>((['board', 'timeline', 'tree'] as const).find((v) => v === query.get('view')) ?? 'board')
  const [logoMode, setLogoMode] = useState<LogoMode>('original')
  const [now, setNow] = useState(Date.now())
  const [paused, setPaused] = useState(false)
  const [openTask, setOpenTask] = useState<string | null>(null)
  const [drag, setDragState] = useState<{ dragging: string | null; over: string | null }>({ dragging: null, over: null })
  const counter = useRef(20)
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(id) }, [])

  const setStatus = useCallback((botId: string, status: Status) => setBots((list) => list.map((bot) => bot.id === botId ? { ...bot, status } : bot)), [])
  const act: MiniActions = {
    select, setScreen, setTasksView, setStatus, setPaused, openTask: setOpenTask,
    updateBot: (botId, patch) => setBots((list) => list.map((bot) => bot.id === botId ? { ...bot, ...patch } : bot)),
    updateTask: (id, patch) => setTasks((list) => list.map((task) => task.id === id ? { ...task, ...patch } : task)),
    removeTask: (id) => { setTasks((list) => list.filter((task) => task.id !== id)); setOpenTask(null) },
    setDrag: (dragging, over) => setDragState({ dragging, over }),
    unassign: (taskId) => setTasks((list) => list.map((task) => task.id === taskId && task.state === 'queued' ? { ...task, state: 'unassigned', assigneeId: null } : task)),
    dispatch: (taskId, botId) => {
      const bot = botById(bots, botId), task = tasks.find((item) => item.id === taskId)
      if (!bot || !task || bot.manager) return 'The Manager drafts tasks; drop them on a bot.'
      const busy = bot.status !== 'idle' && bot.status !== 'done' || tasks.some((item) => item.assigneeId === botId && (item.state === 'running' || item.state === 'needs_you'))
      if (busy || paused) {
        setTasks((list) => [...list.filter((item) => item.id !== taskId), { ...task, state: 'queued', assigneeId: botId }])
        return paused ? `Queued for ${bot.name}. New runs are paused.` : `Queued for ${bot.name}.`
      }
      const sessionId = `s-live-${counter.current++}`
      setSessions((list) => [...list, { id: sessionId, botId, title: task.title, projectId: task.projectId, startMs: Date.now(), endMs: null, state: 'running', steps: ['Reading the brief', 'Looking at the code'] }])
      setTasks((list) => list.map((item) => item.id === taskId ? { ...item, state: 'running', assigneeId: botId, sessionId, costSoFar: 0 } : item))
      setStatus(botId, 'thinking'); window.setTimeout(() => setStatus(botId, 'working'), 2200)
      return `${bot.name} started it.`
    },
    askManager: (ask) => {
      setStatus('manager', 'working')
      const id = `t-new-${counter.current++}`
      window.setTimeout(() => { setTasks((list) => [draftFromAsk(ask, id), ...list]); setStatus('manager', 'done') }, 1800)
      window.setTimeout(() => setStatus('manager', 'idle'), 3800)
    },
  }
  const state: MiniState = { variant, bots, tasks, sessions, selected, screen, tasksView, logoMode, now, paused, openTask, dragOver: drag.over, dragging: drag.dragging }
  return { state, act, setLogoMode, setSessions }
}

function App() {
  const { state, act, setLogoMode } = useStore()
  const [mode, setMode] = useState<'dark' | 'light'>(query.get('mode') === 'light' ? 'light' : query.get('mode') === 'dark' ? 'dark' : variant.mode)
  const [surface, setSurface] = useState<'app' | 'companion'>(query.get('surface') === 'companion' ? 'companion' : 'app')
  const [demo, setDemo] = useState(true)
  const step = useRef(0)
  useEffect(() => {
    if (!demo) return
    let timer = 0
    const run = () => { const next = DEMO[step.current % DEMO.length]; act.setStatus('pololo', next.status); step.current++; timer = window.setTimeout(run, next.ms) }
    run()
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo])
  useEffect(() => { document.documentElement.dataset.mode = mode }, [mode])
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const bar = root.current?.querySelector('.controls'); if (!bar) return
    const observer = new ResizeObserver(() => root.current?.style.setProperty('--controls-h', `${bar.getBoundingClientRect().height}px`))
    observer.observe(bar); return () => observer.disconnect()
  }, [])
  const selectedBot = botById(state.bots, state.selected)
  return <MiniContext.Provider value={{ state, act }}>
    <div ref={root} className={`mini v${variant.id}`} data-mode={mode}>
      <div className="desk" aria-hidden="true"><i /><i /><i /><i /></div>
      <ControlBar mode={mode} setMode={setMode} surface={surface} setSurface={setSurface} logoMode={state.logoMode} setLogoMode={setLogoMode} demo={demo} setDemo={setDemo} bot={selectedBot} />
      {surface === 'app' ? <Window light={mode === 'light'} /> : <CompanionDesk light={mode === 'light'} />}
      <div id="mini-portal" />
    </div>
  </MiniContext.Provider>
}

/* -------------------------------------------------------- prototype controls */

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (id: T) => void; label: string }) {
  return <div className="seg" role="radiogroup" aria-label={label}>{options.map((option) => <button key={option.id} role="radio" aria-checked={value === option.id} className={value === option.id ? 'on' : ''} onClick={() => onChange(option.id)}>{option.label}</button>)}</div>
}

function ControlBar({ mode, setMode, surface, setSurface, logoMode, setLogoMode, demo, setDemo, bot }: {
  mode: 'dark' | 'light'; setMode: (mode: 'dark' | 'light') => void; surface: 'app' | 'companion'; setSurface: (surface: 'app' | 'companion') => void
  logoMode: LogoMode; setLogoMode: (mode: LogoMode) => void; demo: boolean; setDemo: (on: boolean) => void; bot: Bot | undefined
}) {
  const { act } = useMini()
  return <header className="controls">
    <nav className="controls-variants" aria-label="Prototypes">
      {VARIANTS.map((item) => <a key={item.id} href={`/preview${item.id}${location.search}`} className={item.id === variant.id ? 'on' : ''} title={item.note}><b>{item.id}</b>{item.name}</a>)}
    </nav>
    <span className="controls-note">{variant.note}</span>
    <div className="controls-group">
      <Seg label="Surface" value={surface} onChange={setSurface} options={[{ id: 'app', label: 'Main window' }, { id: 'companion', label: 'Companion' }]} />
      <button className="icon-toggle" onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')} aria-label={mode === 'dark' ? 'Switch to light' : 'Switch to dark'}>{mode === 'dark' ? <Moon size={14} /> : <Sun size={14} />}</button>
      <Seg label="Logo colour" value={logoMode} onChange={setLogoMode} options={[{ id: 'original', label: 'Original' }, { id: 'tint', label: 'Bot colour' }, { id: 'mono', label: 'Mono' }]} />
    </div>
    {bot && <div className="controls-group">
      <span className="controls-label">{bot.name}</span>
      <Seg label={`${bot.name} status`} value={bot.status} onChange={(status) => act.setStatus(bot.id, status)} options={(['idle', 'thinking', 'working', 'needs', 'error', 'done'] as const).map((id) => ({ id, label: STATUS_WORD[id] }))} />
    </div>}
    <button className={`demo-toggle${demo ? ' on' : ''}`} onClick={() => setDemo(!demo)} title="Cycles Pololo through every status">{demo ? <Pause size={12} /> : <Play size={12} />} Demo cycle</button>
  </header>
}

/* ------------------------------------------------------------------- window */

function Window({ light }: { light: boolean }) {
  const { state, act } = useMini()
  return <main className={`window nav-${variant.nav}`}>
    {variant.nav === 'rail' && <IconRail />}
    <Sidebar light={light} />
    <section className="pane">
      {variant.nav === 'tabs' && <div className="pane-tabs"><Seg label="View" value={state.screen} onChange={act.setScreen} options={[{ id: 'chat', label: 'Chats' }, { id: 'tasks', label: 'Tasks' }]} /></div>}
      {state.screen === 'chat' ? <Chat light={light} /> : <TasksScreen light={light} />}
    </section>
  </main>
}

function IconRail() {
  const { state, act } = useMini()
  const unassigned = state.tasks.filter((task) => task.state === 'unassigned').length
  return <nav className="rail" aria-label="Sections">
    <span className="rail-mark" aria-hidden="true">B</span>
    <button className={state.screen === 'chat' ? 'on' : ''} onClick={() => act.setScreen('chat')} aria-label="Chats" title="Chats"><SquarePen size={17} /></button>
    <button className={state.screen === 'tasks' ? 'on' : ''} onClick={() => act.setScreen('tasks')} aria-label="Tasks" title="Tasks"><KanbanSquare size={17} />{unassigned > 0 && <em>{unassigned}</em>}</button>
    <button aria-label="Search" title="Search"><Search size={17} /></button>
    <span className="rail-fill" />
    <button aria-label="Settings" title="Settings"><Settings size={17} /></button>
  </nav>
}

function Sidebar({ light }: { light: boolean }) {
  const { state, act } = useMini()
  const [editing, setEditing] = useState<{ id: string; top: number; left: number } | null>(null)
  const [openProjects, setOpenProjects] = useState<Set<string>>(new Set(['pricing']))
  const manager = state.bots.find((bot) => bot.manager)!
  const bots = state.bots.filter((bot) => !bot.manager)
  const unassigned = state.tasks.filter((task) => task.state === 'unassigned').length
  const toggle = (id: string) => setOpenProjects((set) => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const pick = (id: string) => { act.select(id); act.setScreen('chat') }
  return <aside className="sidebar">
    <div className="side-head">
      <span className="side-title">Bitbots</span>
      <button className="ghost-icon" aria-label="Search"><Search size={15} /></button>
      <button className="ghost-icon" aria-label="New chat"><SquarePen size={15} /></button>
    </div>
    {variant.nav === 'sidebar' && <div className="side-nav">
      <button className={state.screen === 'chat' ? 'on' : ''} onClick={() => act.setScreen('chat')}><SquarePen size={15} />Chats</button>
      <button className={state.screen === 'tasks' ? 'on' : ''} onClick={() => act.setScreen('tasks')}><LayoutGrid size={15} />Tasks{unassigned > 0 && <em>{unassigned}</em>}</button>
    </div>}
    <div className="side-scroll">
    <BotRow bot={manager} light={light} selected={state.selected === manager.id && state.screen === 'chat'} onPick={() => pick(manager.id)} onEdit={setEditing} />
    <div className="side-label">Bots <ChevronDown size={12} /></div>
    <div className="side-list">
      {bots.map((bot) => <BotRow key={bot.id} bot={bot} light={light} selected={state.selected === bot.id && state.screen === 'chat'} onPick={() => pick(bot.id)} onEdit={setEditing} />)}
      <button className="bot-row connect"><span className="connect-icon"><Plus size={13} /></span><span className="bot-name">Connect a bot</span></button>
    </div>
    <div className="side-label">Projects <ChevronDown size={12} /></div>
    <div className="side-list">
      {PROJECTS.map((project) => {
        const sessions = state.sessions.filter((session) => session.projectId === project.id).sort((a, b) => b.startMs - a.startMs)
        const open = openProjects.has(project.id)
        return <div key={project.id} className="project">
          <button className="project-row" onClick={() => toggle(project.id)} aria-expanded={open}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<FolderClosed size={14} /><span>{project.name}</span><em>{sessions.length}</em></button>
          {open && sessions.slice(0, 4).map((session) => {
            const bot = botById(state.bots, session.botId)!
            const live = session.state === 'running' || session.state === 'needs'
            return <button key={session.id} className="session-row" onClick={() => pick(bot.id)}>
              {live && <Aura bot={bot} status={session.state === 'needs' ? 'needs' : 'working'} selected={false} kind={variant.aura} quiet />}
              <Logo bot={bot} size={12} mode={state.logoMode} light={light} /><span>{session.title}</span>
            </button>
          })}
        </div>
      })}
    </div>
    </div>
    <div className="side-foot"><span className="avatar">B</span><span>Basem</span><button className="ghost-icon" aria-label="Settings"><Settings size={15} /></button></div>
    {editing && <BotEditor id={editing.id} top={editing.top} left={editing.left} onClose={() => setEditing(null)} light={light} />}
  </aside>
}

function BotRow({ bot, light, selected, onPick, onEdit }: { bot: Bot; light: boolean; selected: boolean; onPick: () => void; onEdit: (edit: { id: string; top: number; left: number }) => void }) {
  const { state } = useMini()
  const over = state.dragging !== null && state.dragOver === bot.id
  const meta = bot.status === 'needs' ? 'Needs you' : bot.status === 'error' ? 'Failed' : bot.lastActive
  return <div className={`bot-row${selected ? ' sel' : ''}${over ? ' drop-over' : ''}${bot.manager ? ' manager' : ''} st-${bot.status}`} data-drop={bot.manager ? undefined : bot.id}>
    <Aura bot={bot} status={bot.status} selected={selected} kind={variant.aura} />
    <button className="bot-hit" onClick={onPick} aria-current={selected || undefined} aria-label={`${bot.name}, ${STATUS_WORD[bot.status]}`} />
    <Logo bot={bot} size={18} mode={state.logoMode} light={light} />
    <span className="bot-name">{bot.name}</span>
    <span className={`bot-meta m-${bot.status}`}>{meta}</span>
    <button className="bot-more" aria-label={`Edit ${bot.name}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onEdit({ id: bot.id, top: rect.bottom + 6, left: rect.left - 200 }) }}><Ellipsis size={14} /></button>
  </div>
}

function BotEditor({ id, top, left, onClose, light }: { id: string; top: number; left: number; onClose: () => void; light: boolean }) {
  const { state, act } = useMini()
  const bot = botById(state.bots, id)!
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close) }, [onClose])
  return <>
    <div className="scrim" onClick={onClose} />
    <div className="popover bot-editor" style={{ top, left: Math.max(12, left) }} role="dialog" aria-label={`${bot.name} look`}>
      <div className="pop-head"><Logo bot={bot} size={20} mode={state.logoMode} light={light} /><b>{bot.name}</b><button className="ghost-icon" onClick={onClose} aria-label="Close"><X size={14} /></button></div>
      <label className="pop-label">Colour</label>
      <div className="swatches">{SWATCHES.map((colour) => <button key={colour} className={bot.color === colour ? 'on' : ''} style={{ background: colour }} onClick={() => act.updateBot(bot.id, { color: colour })} aria-label={colour}>{bot.color === colour && <Check size={12} />}</button>)}</div>
      <label className="pop-label">Logo</label>
      <Seg label="Logo colour" value={bot.logo ?? 'default'} onChange={(value) => act.updateBot(bot.id, { logo: value === 'default' ? undefined : value as LogoMode })}
        options={[{ id: 'default', label: 'Default' }, { id: 'original', label: 'Original' }, { id: 'tint', label: 'Bot colour' }, { id: 'mono', label: 'Mono' }]} />
      <p className="pop-note">The colour also drives this bot’s status gradient.</p>
    </div>
  </>
}

/* --------------------------------------------------------------------- chat */

function Chat({ light }: { light: boolean }) {
  const { state, act } = useMini()
  const bot = botById(state.bots, state.selected)
  const [draft, setDraft] = useState('')
  const [extra, setExtra] = useState<Record<string, string[]>>({})
  if (!bot) return <div className="empty">Pick a bot to start.</div>
  const messages = SESSION_MESSAGES[bot.id] ?? [{ from: 'bot' as const, text: `Hi, I am ${bot.name}. What should I work on?` }]
  const send = (event: FormEvent) => { event.preventDefault(); if (!draft.trim()) return; setExtra((all) => ({ ...all, [bot.id]: [...(all[bot.id] ?? []), draft.trim()] })); setDraft(''); act.setStatus(bot.id, 'thinking'); window.setTimeout(() => act.setStatus(bot.id, 'working'), 1800) }
  return <div className="chat">
    <div className="chat-head">
      <Aura bot={bot} status={bot.status} selected kind={variant.aura} quiet />
      <Logo bot={bot} size={22} mode={state.logoMode} light={light} />
      <div className="chat-title"><b>{bot.name}</b><span>{bot.model} · {bot.manager ? 'Manager' : bot.runtime === 'claude' ? 'Claude Code' : bot.runtime === 'codex' ? 'Codex' : 'OpenCode'}</span></div>
      <span className={`chat-state m-${bot.status}`}>{STATUS_WORD[bot.status]}</span>
    </div>
    <div className="chat-scroll">
      <div className="chat-column">
        {messages.map((message, index) => message.from === 'step'
          ? <div key={index} className="step"><Check size={12} />{message.text}</div>
          : <div key={index} className={`msg ${message.from}`}>{message.text}</div>)}
        {(extra[bot.id] ?? []).map((text, index) => <div key={`x${index}`} className="msg you">{text}</div>)}
        {(bot.status === 'working' || bot.status === 'thinking') && <div className="step live">{bot.status === 'working' ? 'Editing files' : 'Thinking'}</div>}
        {bot.status === 'needs' && <div className="ask">
          <div className="ask-head"><CircleAlert size={15} />Run <code>scripts/rotate-keys.sh</code>?</div>
          <p>{bot.name} wants to run a script against the live ads account.</p>
          <div className="ask-actions"><button className="primary" onClick={() => act.setStatus(bot.id, 'working')}>Allow once</button><button onClick={() => act.setStatus(bot.id, 'idle')}>Deny</button></div>
        </div>}
        {bot.status === 'error' && <div className="ask error">
          <div className="ask-head"><CircleAlert size={15} />The turn failed</div>
          <p>Checkout tests failed. The last change is kept.</p>
          <div className="ask-actions"><button className="primary" onClick={() => act.setStatus(bot.id, 'working')}><RotateCcw size={13} />Retry</button></div>
        </div>}
        {bot.manager && <button className="link-card" onClick={() => act.setScreen('tasks')}><LayoutGrid size={15} />Open the Tasks board</button>}
      </div>
    </div>
    <form className="composer" onSubmit={send}>
      <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={`Message ${bot.name}`} rows={2} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) send(event) }} />
      <div className="composer-row">
        <button type="button" className="ghost-icon" aria-label="Attach"><Paperclip size={15} /></button>
        <span className="composer-chip">{bot.model}</span>
        <span className="composer-fill" />
        <button type="button" className="ghost-icon" aria-label="Dictate"><Mic size={15} /></button>
        <button type="submit" className="send" aria-label="Send" disabled={!draft.trim()}><ArrowUp size={15} /></button>
      </div>
    </form>
  </div>
}

/* ---------------------------------------------------------------- companion */

function CompanionDesk({ light }: { light: boolean }) {
  return <div className={`companion-desk c-${variant.companion}`}>
    <p className="desk-hint">The companion floats over other apps. Click a bot to reply without opening Bitbots.</p>
    <Companion light={light} />
  </div>
}

function Companion({ light }: { light: boolean }) {
  const { state, act } = useMini()
  const [open, setOpen] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [reply, setReply] = useState('')
  const bots = useMemo(() => [...state.bots].sort((a, b) => rank(a) - rank(b)), [state.bots])
  const active = bots.filter((bot) => bot.status !== 'idle')
  const openBot = botById(state.bots, open)
  const send = (event: FormEvent) => { event.preventDefault(); if (!openBot || !reply.trim()) return; act.setStatus(openBot.id, 'thinking'); setReply(''); window.setTimeout(() => act.setStatus(openBot.id, 'working'), 1600) }
  const line = (bot: Bot) => bot.status === 'needs' ? 'Wants to run a script' : bot.status === 'error' ? 'Checkout tests failed' : bot.status === 'working' ? 'Editing files' : bot.status === 'thinking' ? 'Thinking' : bot.status === 'done' ? 'Finished' : bot.lastActive
  const replyBox = openBot && <form className="comp-reply" onSubmit={send}>
    {openBot.status === 'needs' && <div className="comp-ask"><button type="button" className="primary" onClick={() => act.setStatus(openBot.id, 'working')}>Allow once</button><button type="button" onClick={() => act.setStatus(openBot.id, 'idle')}>Deny</button></div>}
    <input value={reply} onChange={(event) => setReply(event.target.value)} placeholder={`Reply to ${openBot.name}`} autoFocus />
    <button type="submit" className="send" aria-label="Send" disabled={!reply.trim()}><ArrowUp size={14} /></button>
  </form>

  if (variant.companion === 'stack') return <div className={`companion comp-stack${collapsed ? ' collapsed' : ''}`}>
    <div className="comp-head"><b>Bitbots</b><span>{active.length} active</span><button className="ghost-icon" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand' : 'Collapse'}>{collapsed ? <Plus size={14} /> : <Minus size={14} />}</button></div>
    {collapsed
      ? <div className="comp-mini">{active.map((bot) => <span key={bot.id} className="comp-mini-item" title={`${bot.name}: ${STATUS_WORD[bot.status]}`}><Aura bot={bot} status={bot.status} selected={false} kind={variant.aura} /><Logo bot={bot} size={16} mode={state.logoMode} light={light} /></span>)}</div>
      : bots.map((bot) => <div key={bot.id} className={`comp-row${open === bot.id ? ' open' : ''}`}>
        <Aura bot={bot} status={bot.status} selected={open === bot.id} kind={variant.aura} />
        <button className="comp-hit" onClick={() => setOpen(open === bot.id ? null : bot.id)} aria-expanded={open === bot.id}>
          <Logo bot={bot} size={18} mode={state.logoMode} light={light} /><span className="comp-name">{bot.name}</span><span className={`comp-line m-${bot.status}`}>{line(bot)}</span>
        </button>
        {open === bot.id && replyBox}
      </div>)}
  </div>

  if (variant.companion === 'dock') return <div className="companion comp-dock">
    {openBot && <div className="comp-card">
      <div className="comp-card-head"><Logo bot={openBot} size={20} mode={state.logoMode} light={light} /><b>{openBot.name}</b><span className={`m-${openBot.status}`}>{STATUS_WORD[openBot.status]}</span><button className="ghost-icon" onClick={() => setOpen(null)} aria-label="Close"><X size={14} /></button></div>
      <p>{line(openBot)}</p>{replyBox}
    </div>}
    <div className="comp-tiles">{bots.map((bot) => <button key={bot.id} className={`comp-tile${open === bot.id ? ' open' : ''}`} onClick={() => setOpen(open === bot.id ? null : bot.id)} aria-label={`${bot.name}, ${STATUS_WORD[bot.status]}`} title={bot.name}>
      <Aura bot={bot} status={bot.status} selected={open === bot.id} kind={variant.aura} /><Logo bot={bot} size={22} mode={state.logoMode} light={light} />
    </button>)}</div>
  </div>

  return <div className="companion comp-rail">
    {openBot && <div className="comp-card">
      <div className="comp-card-head"><Logo bot={openBot} size={20} mode={state.logoMode} light={light} /><b>{openBot.name}</b><button className="ghost-icon" onClick={() => setOpen(null)} aria-label="Close"><X size={14} /></button></div>
      <p className={`m-${openBot.status}`}>{STATUS_WORD[openBot.status]} · {line(openBot)}</p>{replyBox}
    </div>}
    <div className="comp-rail-list">{bots.map((bot) => <button key={bot.id} className={`comp-rail-item${open === bot.id ? ' open' : ''}`} onClick={() => setOpen(open === bot.id ? null : bot.id)} aria-label={`${bot.name}, ${STATUS_WORD[bot.status]}`}>
      <Aura bot={bot} status={bot.status} selected={open === bot.id} kind={variant.aura} /><Logo bot={bot} size={18} mode={state.logoMode} light={light} /><span className="comp-name">{bot.name}</span>
    </button>)}</div>
  </div>
}
const rank = (bot: Bot) => bot.manager ? 0 : ({ needs: 1, error: 2, working: 3, thinking: 3, done: 4, idle: 5 } as const)[bot.status]

const host = document.getElementById('root')! as HTMLElement & { miniRoot?: ReactDOM.Root }
host.miniRoot ??= ReactDOM.createRoot(host)
host.miniRoot.render(<App />)
