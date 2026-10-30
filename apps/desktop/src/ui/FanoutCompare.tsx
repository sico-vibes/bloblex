// Phase 1B: fan-out and compare. One prompt goes to several bots, each in its own
// new conversation, and the answers sit side by side. The conversations are
// ordinary ones: approvals, queues and limits all behave as usual. Picking an
// answer only marks it; nothing is merged or deleted.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, Clock, GitBranch, LoaderCircle, MessageSquare, Split, Trash2 } from 'lucide-react'
import type { Agent, Project, Runtime } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentLook } from '../blob/look'
import { listenForDaemonEvents, rpc } from '../tauri'
import { agentColorHex } from './agentColor'
import { useDialogAccessibility, useDialogEntered } from './dialogFocus'
import { openSafeLink } from './openSafeLink'
import { runtimeUsable } from './rosterSelectors'
import { SafeMarkdown } from './SafeMarkdown'
import { Select } from './Select'
import { defaultProjectFor, rosterAgents } from './teamSelectors'
import './fanout.css'

export const MIN_FANOUT_BOTS = 2
export const MAX_FANOUT_BOTS = 6

export type FanoutRow = { agentId: string; agentName: string; sessionId: string | null; state: string; reply: string | null; error: string | null; durationMs: number | null; tokens: number | null; worktree: { path: string; branch: string } | null }
export type Fanout = { id: string; title: string; text: string; projectName: string | null; createdAt: string | null; chosenSessionId: string | null; rows: FanoutRow[] }

const text = (value: unknown) => typeof value === 'string' && value ? value : null
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null

/** Accepts only a well-formed record from the daemon. Unknown usage stays null, never zero. */
export function normalizeFanout(raw: unknown): Fanout | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  if (typeof item.id !== 'string' || !Array.isArray(item.rows)) return null
  const rows = item.rows.flatMap((part): FanoutRow[] => {
    if (!part || typeof part !== 'object') return []
    const row = part as Record<string, unknown>
    if (typeof row.agentId !== 'string') return []
    const worktree = row.worktree && typeof row.worktree === 'object' ? row.worktree as { path?: unknown; branch?: unknown } : null
    return [{ agentId: row.agentId, agentName: text(row.agentName) ?? 'A removed bot', sessionId: text(row.sessionId), state: text(row.state) ?? 'failed', reply: text(row.reply), error: text(row.error), durationMs: count(row.durationMs), tokens: count(row.tokens), worktree: worktree && typeof worktree.path === 'string' && typeof worktree.branch === 'string' ? { path: worktree.path, branch: worktree.branch } : null }]
  })
  return { id: item.id, title: text(item.title) ?? 'Comparison', text: typeof item.text === 'string' ? item.text : '', projectName: text(item.projectName), createdAt: text(item.createdAt), chosenSessionId: text(item.chosenSessionId), rows }
}

const STATE_LABEL: Record<string, string> = { working: 'Working', starting: 'Starting', waiting_permission: 'Needs you', limited: 'Usage limit', cancelling: 'Stopping', cancelled: 'Stopped', failed: 'Failed', error: 'Failed', idle: 'Done', completed: 'Done' }
const LIVE = new Set(['working', 'starting', 'cancelling'])

/** The word shown on a column. A conversation that hasn't answered yet is not "Done". */
export function fanoutRowState(row: Pick<FanoutRow, 'state' | 'error' | 'reply'>): { label: string; tone: 'live' | 'needs' | 'bad' | 'done' | 'idle' } {
  if (row.error) return { label: 'Failed', tone: 'bad' }
  const label = STATE_LABEL[row.state] ?? 'Done'
  if (LIVE.has(row.state)) return { label, tone: 'live' }
  if (row.state === 'waiting_permission' || row.state === 'limited') return { label, tone: 'needs' }
  if (row.state === 'failed' || row.state === 'error' || row.state === 'cancelled') return { label, tone: 'bad' }
  return row.reply ? { label: 'Done', tone: 'done' } : { label: 'No reply yet', tone: 'idle' }
}

/** "2m 5s", or "12s"; null when unknown. */
export function durationLabel(ms: number | null): string | null {
  if (ms === null) return null
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : typeof reason === 'string' && reason ? reason : fallback

/** Chooses the bots and the project, and starts the comparison. */
export function FanoutDialog({ agents, projects, runtimes, initialAgent, onCancel, onStarted }: {
  agents: readonly Agent[]
  projects: readonly Project[]
  runtimes: readonly Runtime[]
  initialAgent: Agent | null
  onCancel: () => void
  onStarted: (fanout: Fanout) => void
}) {
  const entered = useDialogEntered()
  const [busy, setBusy] = useState(false)
  const { ref, close } = useDialogAccessibility(onCancel, () => !busy)
  const usable = useCallback((agent: Agent) => runtimeUsable(runtimes.find((runtime) => runtime.id === agent.runtimeId)), [runtimes])
  const roster = useMemo(() => rosterAgents(agents as Agent[]), [agents])
  const [picked, setPicked] = useState<string[]>(() => initialAgent && usable(initialAgent) ? [initialAgent.id] : [])
  const [projectValue, setProjectValue] = useState<string>(() => (initialAgent ? defaultProjectFor(initialAgent, projects)?.id : undefined) ?? '')
  const [prompt, setPrompt] = useState('')
  const [worktrees, setWorktrees] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  const toggle = (id: string) => setPicked((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length >= MAX_FANOUT_BOTS ? current : [...current, id])
  const ready = picked.length >= MIN_FANOUT_BOTS && !!prompt.trim() && !busy
  const start = async () => {
    if (!ready) return
    setBusy(true); setProblem(null)
    try {
      const result = await rpc<{ fanout?: unknown }>('fanout.start', { agentIds: picked, text: prompt.trim(), projectId: projectValue || null, worktrees: !!projectValue && worktrees })
      const fanout = normalizeFanout(result?.fanout)
      if (!fanout) throw new Error('The comparison could not be started.')
      onStarted(fanout)
    } catch (reason) { setProblem(messageOf(reason, 'The comparison could not be started.')); setBusy(false) }
  }
  return <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`}>
    <section ref={ref} className="blob-dialog fanout-dialog" role="dialog" aria-modal="true" aria-labelledby="fanout-title" tabIndex={-1}>
      <h2 id="fanout-title">Ask several bots</h2>
      <p>Each bot gets the same message in its own new conversation, and you compare the answers side by side.</p>
      <div className="fanout-bots" role="group" aria-label={`Choose ${MIN_FANOUT_BOTS} to ${MAX_FANOUT_BOTS} bots`}>
        {roster.map((agent) => {
          const on = picked.includes(agent.id)
          const available = usable(agent)
          return <button key={agent.id} type="button" className={`fanout-bot${on ? ' on' : ''}`} aria-pressed={on} disabled={!available || (!on && picked.length >= MAX_FANOUT_BOTS)} title={available ? undefined : `${agent.name}'s coding agent isn't ready`} onClick={() => toggle(agent.id)}>
            <BlobCanvas decorative color={agentColorHex(agent.color)} size={18} mini mood="idle" look={agentLook(agent)} label={agent.name} />
            <span>{agent.name}</span>
            {on && <Check size={13} aria-hidden="true" />}
          </button>
        })}
      </div>
      <label className="fanout-field"><span>Project</span>
        <Select ariaLabel="Project" variant="muted" value={projectValue} onChange={setProjectValue} options={[...projects.filter((project) => !!project.path).map((project) => ({ value: project.id, label: project.name })), { value: '', label: 'No project' }]} />
      </label>
      {projectValue !== '' && <label className="fanout-copy"><input type="checkbox" checked={worktrees} onChange={(event) => setWorktrees(event.target.checked)} /><span>Give each bot its own copy of the repository<small>So their edits can't clash. Applies to git projects. Uncommitted changes aren't copied.</small></span></label>}
      <textarea className="fanout-prompt" rows={4} value={prompt} maxLength={100_000} data-dialog-initial-focus="" aria-label="The message for every bot" placeholder="What should they all answer?" onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void start() } }} />
      {problem && <p className="fanout-problem" role="alert">{problem}</p>}
      <div className="blob-dialog-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={close}>Cancel</button>
        <button type="button" className="primary-button" disabled={!ready} onClick={() => void start()}>{busy ? 'Sending…' : picked.length >= MIN_FANOUT_BOTS ? `Ask ${picked.length} bots` : `Choose ${MIN_FANOUT_BOTS} or more`}</button>
      </div>
    </section>
  </div>
}

/** The answers side by side, and earlier comparisons. */
export function CompareView({ initialId, agents, connected, onBack, onOpenSession, onStartNew }: {
  initialId: string | null
  agents: readonly Agent[]
  connected: boolean
  onBack: () => void
  onOpenSession: (sessionId: string) => void
  onStartNew: () => void
}) {
  const [list, setList] = useState<Fanout[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(initialId)
  const [open, setOpen] = useState<Fanout | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const openIdRef = useRef(openId)
  openIdRef.current = openId
  useEffect(() => { setOpenId(initialId) }, [initialId])
  const loadList = useCallback(() => rpc<{ fanouts?: unknown }>('fanout.list', {}).then((result) => setList(Array.isArray(result?.fanouts) ? result.fanouts.flatMap((row) => { const item = normalizeFanout(row); return item ? [item] : [] }) : [])).catch(() => { setList([]); setProblem('Comparisons could not be read.') }), [])
  const loadOpen = useCallback((id: string) => rpc<{ fanout?: unknown }>('fanout.get', { id }).then((result) => { if (openIdRef.current === id) setOpen(normalizeFanout(result?.fanout)) }).catch(() => { if (openIdRef.current === id) { setOpen(null); setOpenId(null) } }), [])
  useEffect(() => { void loadList() }, [loadList])
  useEffect(() => { if (openId) void loadOpen(openId); else setOpen(null) }, [openId, loadOpen])
  // A reply arriving in a member conversation refreshes the columns.
  const members = useRef(new Set<string>())
  members.current = new Set((open?.rows ?? []).flatMap((row) => row.sessionId ? [row.sessionId] : []))
  useEffect(() => {
    let live = true
    let stop: (() => void) | undefined
    let timer: number | undefined
    const refresh = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { void loadList(); if (openIdRef.current) void loadOpen(openIdRef.current) }, 250) }
    void listenForDaemonEvents((event) => {
      const payload = event.payload as { id?: unknown } | undefined
      if (event.type === 'fanout.changed' || (event.type === 'session.changed' && typeof payload?.id === 'string' && members.current.has(payload.id))) refresh()
    }).then((unlisten) => { if (live) stop = unlisten; else unlisten() })
    return () => { live = false; window.clearTimeout(timer); stop?.() }
  }, [loadList, loadOpen])
  // While a bot is still working, its column also refreshes on a slow timer, so a missed event can't leave it stale.
  const anyLive = !!open?.rows.some((row) => fanoutRowState(row).tone === 'live')
  useEffect(() => {
    if (!anyLive || !openId) return
    const timer = window.setInterval(() => void loadOpen(openId), 4_000)
    return () => window.clearInterval(timer)
  }, [anyLive, openId, loadOpen])
  const pick = async (fanout: Fanout, sessionId: string | null) => {
    try { const result = await rpc<{ fanout?: unknown }>('fanout.pick', { id: fanout.id, sessionId }); setOpen(normalizeFanout(result?.fanout)) }
    catch (reason) { setProblem(messageOf(reason, 'That choice could not be saved.')) }
  }
  const remove = async (fanout: Fanout) => {
    try { await rpc('fanout.delete', { id: fanout.id }); setOpenId(null); await loadList() }
    catch (reason) { setProblem(messageOf(reason, 'That comparison could not be removed.')) }
  }
  const agentOf = (id: string) => agents.find((agent) => agent.id === id) ?? null
  return <div className="compare-page">
    <header className="blob-page-header">
      <button type="button" className="analytics-icon-button" aria-label="Back" title="Back" onClick={() => { if (openId) setOpenId(null); else onBack() }}><ArrowLeft size={16} /></button>
      <strong className="blob-page-heading">{open ? open.title : 'Comparisons'}</strong>
      <span className="compare-header-end">
        {open && <button type="button" className="ghost-button small" title="Removes this comparison. The conversations stay." onClick={() => void remove(open)}><Trash2 size={13} aria-hidden="true" />Remove</button>}
        {!open && <button type="button" className="primary-button small" disabled={!connected} onClick={onStartNew}><Split size={14} aria-hidden="true" />Ask several bots</button>}
      </span>
    </header>
    {problem && <p className="fanout-problem compare-problem" role="alert">{problem}</p>}
    {open
      ? <div className="compare-body">
        <div className="compare-prompt"><p>{open.text}</p>{open.projectName && <small>{open.projectName}</small>}</div>
        <div className="compare-columns" style={{ ['--compare-count' as string]: open.rows.length }}>
          {open.rows.map((row) => {
            const state = fanoutRowState(row)
            const chosen = !!row.sessionId && open.chosenSessionId === row.sessionId
            const agent = agentOf(row.agentId)
            const facts = [durationLabel(row.durationMs), row.tokens !== null ? `${row.tokens.toLocaleString()} tokens` : null].filter(Boolean)
            return <article key={`${row.agentId}-${row.sessionId ?? 'none'}`} className={`compare-column${chosen ? ' chosen' : ''}`} aria-label={`${row.agentName}: ${state.label}`}>
              <header className="compare-column-head">
                {agent ? <BlobCanvas decorative color={agentColorHex(agent.color)} size={20} mini mood="idle" look={agentLook(agent)} label={agent.name} /> : null}
                <strong>{row.agentName}</strong>
                <span className={`compare-state tone-${state.tone}`}>{state.tone === 'live' && <LoaderCircle size={11} className="spinning" aria-hidden="true" />}{state.label}</span>
              </header>
              <div className="compare-reply">
                {row.error ? <p className="fanout-problem">{row.error}</p>
                  : row.reply ? <SafeMarkdown text={row.reply} onOpenLink={(url) => void openSafeLink(url)} />
                  : <p className="compare-waiting">{state.tone === 'needs' ? 'Waiting for you in its conversation.' : state.tone === 'live' ? 'Working on it…' : 'No reply.'}</p>}
              </div>
              <footer className="compare-column-foot">
                {(facts.length > 0 || row.worktree) && <div className="compare-facts">
                  {facts.length > 0 && <span><Clock size={11} aria-hidden="true" />{facts.join(' · ')}</span>}
                  {row.worktree && <span title={row.worktree.path}><GitBranch size={11} aria-hidden="true" />{row.worktree.branch}</span>}
                </div>}
                <div className="compare-actions">
                  {row.sessionId && <button type="button" className="ghost-button small" onClick={() => onOpenSession(row.sessionId!)}><MessageSquare size={13} aria-hidden="true" />Open</button>}
                  {row.sessionId && (row.reply || chosen) && <button type="button" className={`${chosen ? 'primary-button' : 'secondary-button'} small`} aria-pressed={chosen} onClick={() => void pick(open, chosen ? null : row.sessionId)}><Check size={13} aria-hidden="true" />{chosen ? 'Your pick' : 'Pick this'}</button>}
                </div>
              </footer>
            </article>
          })}
        </div>
      </div>
      : <div className="compare-list-wrap">
        {list === null ? <p className="compare-waiting" role="status">Reading comparisons…</p>
          : list.length === 0 ? <div className="compare-empty"><Split size={22} aria-hidden="true" /><p>Ask several bots the same thing and read their answers side by side.</p></div>
          : <ul className="compare-list">{list.map((item) => <li key={item.id}><button type="button" onClick={() => setOpenId(item.id)}>
            <strong>{item.title}</strong>
            <small>{[item.rows.map((row) => row.agentName).join(', '), item.projectName, item.createdAt ? new Date(item.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : null].filter(Boolean).join(' · ')}</small>
          </button></li>)}</ul>}
      </div>}
  </div>
}

/** The companion's Activity pane: a comparison still running, with each bot's state. */
export function CompanionFanoutSummary({ connected, onOpen }: { connected: boolean; onOpen: (sessionId: string) => void }) {
  const [latest, setLatest] = useState<Fanout | null>(null)
  useEffect(() => {
    if (!connected) return
    let live = true
    let stop: (() => void) | undefined
    const load = () => rpc<{ fanouts?: unknown[] }>('fanout.list', { limit: 1 }).then((result) => { if (live) setLatest(normalizeFanout(result?.fanouts?.[0])) }).catch(() => { if (live) setLatest(null) })
    void load()
    void listenForDaemonEvents((event) => { if (event.type === 'fanout.changed' || event.type === 'session.changed') void load() }).then((unlisten) => { if (live) stop = unlisten; else unlisten() })
    return () => { live = false; stop?.() }
  }, [connected])
  if (!latest || !latest.rows.some((row) => { const tone = fanoutRowState(row).tone; return tone === 'live' || tone === 'needs' })) return null
  return <div className="companion-fanout" role="group" aria-label={`Comparing: ${latest.title}`}>
    <small>Comparing: {latest.title}</small>
    {latest.rows.map((row) => <button type="button" key={row.agentId} className="companion-activity-row team" disabled={!row.sessionId} onClick={() => { if (row.sessionId) onOpen(row.sessionId) }}>
      <span><strong>{row.agentName}</strong><small>{fanoutRowState(row).label}</small></span>
    </button>)}
  </div>
}
