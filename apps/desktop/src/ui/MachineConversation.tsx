// Phase 4: a bot on another machine. Its conversations are read-only here, because only one
// machine runs a conversation. The one action is Take over, which moves it to this machine.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CircleAlert, CircleCheck, FolderGit2, GitBranch, Info, Laptop, LoaderCircle, RefreshCw, X } from 'lucide-react'
import type { Session } from '../types'
import { rpc } from '../tauri'
import { useDialogAccessibility, useDialogEntered } from './dialogFocus'
import { canTakeOver, machineBusyBots, useMachines, type Machine, type MachineBot, type TakeOverJob, type TakeOverPreview } from './machines'
import { MachineBadge, openMachineBotInMainWindow } from './MachineBots'
import { openSafeLink } from './openSafeLink'
import { SafeMarkdown } from './SafeMarkdown'
import { shortTime } from './rosterSelectors'
import { sessionIsBusy } from './teamSelectors'
import './machines.css'

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : typeof reason === 'string' && reason ? reason : fallback
const POLL_MS = 3000
const STEP_WORD: Record<string, string> = { prepare: 'Saved the work on the other machine', code: 'Got the code', bot: 'Matched the bot', import: 'Copied the conversation', commit: 'Handed over', open: 'Opened it here' }

type Conversation = { id: string; title?: string | null; updatedAt?: string | null; projectName?: string | null; state?: string | null; link?: Session['link'] }

function conversationsFrom(raw: unknown): Conversation[] {
  const rows = raw && typeof raw === 'object' ? (raw as { conversations?: unknown }).conversations : null
  return Array.isArray(rows) ? rows.filter((row): row is Conversation => !!row && typeof (row as Conversation).id === 'string') : []
}

/** The sentence and button for what's possible with this conversation. */
export function takeOverState(machine: Machine, session: Pick<Session, 'link'> | null, selfId: string | null): { allowed: boolean; note: string } {
  const movedTo = session?.link?.movedTo
  if (movedTo) return { allowed: false, note: movedTo.machineId === selfId ? 'This conversation moved to this machine.' : `This conversation moved to ${movedTo.name}.` }
  if (machine.state === 'revoked') return { allowed: false, note: `${machine.name} removed this link. Pair again in Settings, Machines.` }
  if (machine.state !== 'online') return { allowed: false, note: `${machine.name} can't be reached, so this may be out of date.` }
  if (!canTakeOver(machine)) return { allowed: false, note: `Read only. To take conversations over, set this machine to Chat and approve in Settings, Remote, on ${machine.name}.` }
  return { allowed: true, note: `Running on ${machine.name}. Read only here.` }
}

export function TakeOverDialog({ machine, sessionId, onClose, onMoved }: { machine: Machine; sessionId: string; onClose: () => void; onMoved: (sessionId: string) => void }) {
  const entered = useDialogEntered()
  const [preview, setPreview] = useState<TakeOverPreview | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [job, setJob] = useState<TakeOverJob | null>(null)
  const [starting, setStarting] = useState(false)
  const [consent, setConsent] = useState(false)
  const running = starting || job?.state === 'running'
  const { ref, close } = useDialogAccessibility(onClose, () => !running)
  const jobId = job?.state === 'running' ? job.id : null

  useEffect(() => {
    let live = true
    void rpc<TakeOverPreview>('machine.takeOver.preview', { machineId: machine.id, sessionId })
      .then((reply) => { if (live) setPreview(reply) })
      .catch((reason) => { if (live) setFailure(messageOf(reason, 'This conversation could not be checked.')) })
    return () => { live = false }
  }, [machine.id, sessionId])

  useEffect(() => {
    if (!jobId) return
    const timer = window.setInterval(() => {
      void rpc<{ jobs?: TakeOverJob[] }>('machine.takeOver.list', {}).then((reply) => {
        const next = reply?.jobs?.find((item) => item.id === jobId)
        if (next) setJob(next)
      }).catch(() => undefined)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [jobId])

  const uncommitted = preview?.uncommitted ?? 0
  const ownCopy = !!preview?.repo.isWorktree
  const needsConsent = ownCopy && uncommitted > 0
  const blocked = !preview || !preview.ready || !preview.runtimeReady || preview.needsProject
  const start = async () => {
    setStarting(true); setFailure(null)
    try {
      const reply = await rpc<{ job: TakeOverJob }>('machine.takeOver', { machineId: machine.id, sessionId, projectId: preview?.project?.id ?? null, commitUncommitted: needsConsent && consent, confirm: true })
      setJob(reply.job)
    } catch (reason) { setFailure(messageOf(reason, 'This conversation could not be taken over.')) } finally { setStarting(false) }
  }
  const done = job?.state === 'done'

  // Portalled: this opens from inside other dialogs, and a transformed parent would trap a fixed backdrop.
  return createPortal(<div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`}>
    <section ref={ref} className="blob-dialog take-over" role="dialog" aria-modal="true" aria-labelledby="take-over-title" tabIndex={-1}>
      <h2 id="take-over-title">{done ? "It's on this machine now" : job?.state === 'failed' ? 'It stayed where it was' : running ? 'Taking it over…' : 'Take over this conversation?'}</h2>
      {!preview && !failure && <p role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" /> Checking with {machine.name}…</p>}
      {preview && !job && <>
        <p>It moves to this machine. {machine.name} keeps a read-only copy, and only this machine can run it from then on.</p>
        <ul className="take-over-facts">
          <li><Laptop size={14} aria-hidden="true" /><span>{preview.bot.willCreate ? `This machine gets a copy of ${preview.bot.name}, without Full access or environment values.` : `${preview.bot.name} carries on here, in a fresh session with a summary.`}</span></li>
          {preview.repo.hasRemote && ownCopy && <li><GitBranch size={14} aria-hidden="true" /><span>The branch <code>{preview.repo.branch}</code> is pushed from {machine.name} and fetched here.</span></li>}
          {preview.repo.identity && preview.project && <li><FolderGit2 size={14} aria-hidden="true" /><span>It works in your project {preview.project.name}.</span></li>}
          {!preview.repo.hasRemote && <li><Info size={14} aria-hidden="true" /><span>This repository has no remote, so the files stay on {machine.name}. Only the conversation moves.</span></li>}
          {preview.repo.hasRemote && !ownCopy && <li><Info size={14} aria-hidden="true" /><span>This conversation has no copy of its own, so its files stay on {machine.name}{uncommitted > 0 ? `, including ${uncommitted} uncommitted file${uncommitted === 1 ? '' : 's'}` : ''}.</span></li>}
          <li><Info size={14} aria-hidden="true" /><span>Pictures and tool steps stay on {machine.name}.</span></li>
        </ul>
        {needsConsent && <label className="new-project-check"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>Commit {uncommitted} uncommitted file{uncommitted === 1 ? '' : 's'} to that branch first</span></label>}
        {!preview.ready && <p className="new-project-error" role="alert">{preview.reason}</p>}
        {preview.ready && !preview.runtimeReady && <p className="new-project-error" role="alert">{preview.reason ?? `This machine has no coding agent for ${preview.bot.name}.`}</p>}
        {preview.ready && preview.runtimeReady && preview.needsProject && <p className="new-project-error" role="alert">This machine doesn't have <code>{preview.repo.identity}</code> yet. Add it in New project, Clone, then try again.</p>}
      </>}
      {job && <ul className="take-over-steps" aria-label="Progress">
        {job.steps.map((step) => <li key={step.id} data-status={step.status}>
          {step.status === 'failed' ? <CircleAlert size={13} aria-hidden="true" /> : <CircleCheck size={13} aria-hidden="true" />}
          <span>{step.status === 'failed' ? step.detail ?? 'That step failed.' : step.status === 'skipped' ? `Skipped: ${(STEP_WORD[step.id] ?? step.id).toLowerCase()}` : STEP_WORD[step.id] ?? step.id}</span>
        </li>)}
        {running && <li><LoaderCircle size={13} className="spin" aria-hidden="true" /><span>Working…</span></li>}
      </ul>}
      {job?.state === 'failed' && <p className="new-project-error" role="alert">{job.detail ?? 'It stayed on the other machine.'} The conversation stays on {machine.name}.</p>}
      {failure && <p className="new-project-error" role="alert">{failure}</p>}
      <div className="blob-dialog-actions">
        {done
          ? <button type="button" className="primary-button" onClick={() => onMoved(job.sessionId ?? sessionId)}>Open it</button>
          : <>
            <button type="button" className="secondary-button" disabled={running} onClick={close}>{job ? 'Close' : 'Cancel'}</button>
            {!job && <button type="button" className="primary-button" disabled={blocked || running || (needsConsent && !consent)} onClick={() => void start()}>{starting ? 'Starting…' : 'Take over'}</button>}
          </>}
      </div>
    </section>
  </div>, document.body)
}

/** In place of the composer: another machine runs this conversation now. */
export function MovedBar({ sessionId, movedTo, machines, onMoved }: { sessionId: string; movedTo: { machineId: string; name: string }; machines: readonly Machine[]; onMoved: () => void }) {
  const [takingOver, setTakingOver] = useState(false)
  const machine = machines.find((item) => item.id === movedTo.machineId) ?? null
  const allowed = !!machine && canTakeOver(machine)
  const note = !machine ? `To take it back, link ${movedTo.name} in Settings, Machines.` : !allowed ? machine.state === 'online' ? `To take it back, set this machine to Chat and approve on ${machine.name}.` : `${machine.name} can't be reached right now.` : 'Read only here.'
  return <div className="moved-bar" role="status">
    <Laptop size={15} aria-hidden="true" />
    <span><strong>Moved to {movedTo.name}.</strong> {note}</span>
    <button type="button" className="primary-button small" disabled={!allowed} onClick={() => setTakingOver(true)}>Take over</button>
    {takingOver && machine && <TakeOverDialog machine={machine} sessionId={sessionId} onClose={() => setTakingOver(false)} onMoved={() => { setTakingOver(false); onMoved() }} />}
  </div>
}

/** The companion: bots working on another machine, each with that machine's name. */
export function CompanionMachineBots() {
  const { machines } = useMachines()
  const busy = machineBusyBots(machines)
  if (!busy.length) return null
  return <div className="companion-machine-bots" aria-label="Working on other machines">
    {busy.map(({ machine, bot }) => <button type="button" key={`${machine.id}-${bot.id}`} className="companion-machine-bot" onClick={() => void openMachineBotInMainWindow(machine.id, bot.id).catch(() => undefined)}>
      <strong>{bot.name}</strong><span>Working</span><MachineBadge name={machine.name} />
    </button>)}
  </div>
}

export function MachineConversation({ machine, bot, initialSessionId, selfId, onClose, onMoved }: { machine: Machine; bot: MachineBot; initialSessionId?: string | null; selfId: string | null; onClose: () => void; onMoved: (sessionId: string) => void }) {
  const entered = useDialogEntered()
  const [takingOver, setTakingOver] = useState(false)
  const { ref, close } = useDialogAccessibility(onClose, () => !takingOver)
  const [conversations, setConversations] = useState<Conversation[] | null>(null)
  const [selected, setSelected] = useState<string | null>(initialSessionId ?? bot.activeSessionId)
  const [session, setSession] = useState<Session | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    let live = true
    const load = () => rpc('machine.conversations', { machineId: machine.id, agentId: bot.id }).then((reply) => {
      if (!live) return
      const rows = conversationsFrom(reply)
      setConversations(rows)
      setSelected((current) => current ?? rows[0]?.id ?? null)
    }).catch((reason) => { if (live) { setConversations((current) => current ?? []); setFailure(messageOf(reason, `${machine.name} can't be reached right now.`)) } })
    void load()
    const timer = window.setInterval(() => void load(), 15000)
    return () => { live = false; window.clearInterval(timer) }
  }, [machine.id, bot.id, machine.name])

  useEffect(() => {
    if (!selected) { setSession(null); return }
    let live = true
    setSession(null)
    pinned.current = true
    const load = () => rpc<{ session?: Session }>('machine.conversation', { machineId: machine.id, sessionId: selected }).then((reply) => {
      if (live) { setSession(reply?.session ?? null); setFailure(null) }
    }).catch((reason) => { if (live) setFailure(messageOf(reason, `${machine.name} can't be reached right now.`)) })
    void load()
    const timer = window.setInterval(() => { if (!document.hidden) void load() }, POLL_MS)
    return () => { live = false; window.clearInterval(timer) }
  }, [machine.id, selected, machine.name])

  useEffect(() => {
    const element = scroller.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [session?.messages?.length])

  const state = takeOverState(machine, session, selfId)
  const messages = (session?.messages ?? []).filter((message) => ['user', 'assistant', 'notice'].includes(String(message.role)) && String(message.content ?? '').trim())
  const busy = sessionIsBusy(session)

  return <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`}>
    <section ref={ref} className="blob-dialog machine-view" role="dialog" aria-modal="true" aria-labelledby="machine-view-title" tabIndex={-1}>
      <header className="machine-view-head">
        <div className="machine-view-title">
          <h2 id="machine-view-title">{bot.name}</h2>
          <small>On {machine.name}{machine.lastSeenAt && machine.state !== 'online' ? ` · last seen ${shortTime(machine.lastSeenAt)}` : ''}</small>
        </div>
        <button type="button" className="icon-button" aria-label="Close" onClick={close}><X size={16} aria-hidden="true" /></button>
      </header>
      <div className="machine-view-layout">
        <ul className="machine-view-list" aria-label={`${bot.name}'s conversations`}>
          {conversations === null && <li><small>Loading…</small></li>}
          {conversations?.length === 0 && <li><small>No conversations yet.</small></li>}
          {conversations?.map((item) => <li key={item.id}><button type="button" aria-current={item.id === selected ? 'true' : undefined} onClick={() => setSelected(item.id)}>
            <strong>{item.title || 'Conversation'}</strong>
            <small>{[item.projectName, item.updatedAt ? shortTime(item.updatedAt) : null].filter(Boolean).join(' · ')}</small>
          </button></li>)}
        </ul>
        <div className="machine-view-main">
          <div ref={scroller} className="machine-transcript" tabIndex={0} aria-label="Conversation, read only" onScroll={(event) => { const element = event.currentTarget; pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48 }}>
            {selected && !session && !failure && <p role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" /> Loading…</p>}
            {!selected && conversations?.length !== 0 && conversations !== null && <p>Choose a conversation.</p>}
            {messages.map((message) => <article key={String(message.id)} className={`machine-message ${String(message.role)}`}>
              {message.role !== 'notice' && <small>{message.role === 'user' ? 'You' : bot.name}{message.createdAt ? ` · ${shortTime(String(message.createdAt))}` : ''}</small>}
              {message.role === 'assistant'
                ? <SafeMarkdown text={String(message.content)} onOpenLink={openSafeLink} />
                : <div>{String(message.content)}</div>}
            </article>)}
            {busy && <p className="machine-message notice" role="status">{bot.name} is working on {machine.name}…</p>}
          </div>
          {failure && <p className="new-project-error" role="alert">{failure}</p>}
          {selected && <div className="machine-owner-bar">
            <Laptop size={14} aria-hidden="true" />
            <span>{state.note}</span>
            {machine.state === 'offline' && <RefreshCw size={13} aria-hidden="true" />}
            <button type="button" className="primary-button small" disabled={!state.allowed || !session} onClick={() => setTakingOver(true)}>Take over</button>
          </div>}
        </div>
      </div>
      {takingOver && selected && <TakeOverDialog machine={machine} sessionId={selected} onClose={() => setTakingOver(false)} onMoved={onMoved} />}
    </section>
  </div>
}
