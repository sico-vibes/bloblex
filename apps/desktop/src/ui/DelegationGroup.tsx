// The Manager's assignments in the conversation that made them: a centred "Messaged ..." chip per run of messages sent
// in a turn (like "Message from"), opening in place to a row per bot with its art, a status the daemon recorded, elapsed time, and a way into the teammate's
// own conversation. Approving stays in that conversation; nothing here decides anything for the owner.
import { useEffect, useState } from 'react'
import { ArrowUpRight, ChevronDown, ChevronRight, Square } from 'lucide-react'
import { rpc } from '../tauri'
import type { Agent } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import type { BlobMood } from '../blob/characterState'
import { agentLook } from '../blob/look'
import { agentColorHex } from './agentColor'
import { useSessionRepository, repositoryRefreshKey } from './sessionRepository'
import { sessionIsBusy } from './teamSelectors'
import { useEntityNoun } from './vocabulary'
import { groupElapsed, isActiveBucket, rowElapsed, summarizeBuckets, type DelegationBucket, type DelegationRowModel } from './delegations'
import './delegationGroup.css'

const MOOD: Record<DelegationBucket, BlobMood> = { queued: 'idle', working: 'working', approval: 'permission', done: 'idle', failed: 'error', cancelled: 'idle', interrupted: 'idle', earlier: 'idle' }
const baseName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

function Art({ agent, name, size, mood }: { agent: Agent | undefined; name: string; size: number; mood: BlobMood }) {
  return agent
    ? <BlobCanvas decorative color={agentColorHex(agent.color)} size={size} mini mood={mood} look={agentLook(agent)} label={name} />
    : <span className="delegation-art-fallback" style={{ width: size, height: size }} aria-hidden="true">{name.slice(0, 1)}</span>
}

/** Where the work happens and what Git says there. Only the teammate's own branch is attributed to it. */
function Workspace({ row, active }: { row: DelegationRowModel; active: boolean }) {
  const own = !!row.worktree?.branch
  const repository = useSessionRepository(row.sideSession ?? null, repositoryRefreshKey(row.sideSession ?? null), !!row.sideSession && sessionIsBusy(row.sideSession), active)
  const data = repository.data
  const folder = row.workspacePath ? baseName(row.workspacePath) : null
  const branch = own ? row.worktree!.branch : data?.gitRepo && data.branch ? data.branch : null
  const changed = data?.gitRepo ? data.files.length : null
  const place = !folder ? 'Not recorded' : own ? `Own copy of ${row.worktree!.repo ? baseName(row.worktree!.repo) : 'the project'}` : `Shared folder ${folder}`
  return <dl className="delegation-facts">
    <div><dt>Workspace</dt><dd title={row.workspacePath ?? undefined}>{place}</dd></div>
    <div><dt>Branch</dt><dd>{branch ? <code>{branch}</code> : data && !data.gitRepo ? 'Not a Git folder' : repository.loading ? 'Reading…' : 'Unknown'}{branch && !own && <span className="delegation-note"> · the folder's current branch</span>}{branch && own && <span className="delegation-note"> · this bot's own branch</span>}</dd></div>
    {changed !== null && <div><dt>Changes</dt><dd title={own ? undefined : 'Git reports the whole folder, so these changes are not attributed to this bot.'}>{changed === 0 ? 'None' : `${changed} file${changed === 1 ? '' : 's'}`}{changed > 0 && data && <span className="delegation-note"> · +{data.addedLines} −{data.removedLines}{own ? '' : ' · whole folder, not only this bot'}</span>}</dd></div>}
  </dl>
}

/** Stops one assignment: a queued brief is withdrawn, a running one has its turn cancelled. The daemon reports the result through `delegation.updated`. */
function StopControl({ row, onStopped, onError }: { row: DelegationRowModel; onStopped?: () => void; onError: (message: string) => void }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const stop = async () => {
    setBusy(true)
    try { await rpc('delegation.cancel', { delegationId: row.delegationId }); onStopped?.() } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false); setAsking(false) }
  }
  return asking
    ? <span className="delegation-stop-confirm" role="group" aria-label={`Stop ${row.name}?`}><button type="button" className="delegation-stop danger" disabled={busy} onClick={() => void stop()}>{busy ? 'Stopping…' : row.bucket === 'queued' ? 'Withdraw' : 'Stop work'}</button><button type="button" className="delegation-stop" disabled={busy} onClick={() => setAsking(false)}>Keep</button></span>
    : <button type="button" className="delegation-stop" onClick={() => setAsking(true)} aria-label={`${row.bucket === 'queued' ? 'Withdraw the assignment to' : 'Stop'} ${row.name}: ${row.topic}`}><Square size={10} aria-hidden="true" />Stop</button>
}

const stoppable = (row: DelegationRowModel) => row.recorded && !!row.delegationId && isActiveBucket(row.bucket)

function Row({ row, now, onOpen, onError, onFollowUp }: { row: DelegationRowModel; now: number; onOpen: (sessionId: string) => void; onError: (message: string) => void; onFollowUp?: (row: DelegationRowModel) => void }) {
  const [open, setOpen] = useState(false)
  const panel = `delegation-${row.key}`.replace(/[^A-Za-z0-9_-]/g, '')
  const elapsed = rowElapsed(row, now)
  return <li className={`delegation-row ${row.bucket}`} data-delegation-id={row.delegationId ?? undefined} data-status={row.bucket}>
    <div className="delegation-row-main">
      <button type="button" className="delegation-row-toggle" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={12} className={open ? 'open' : ''} aria-hidden="true" />
        <Art agent={row.agent} name={row.name} size={24} mood={MOOD[row.bucket]} />
        <span className="delegation-row-copy"><strong>{row.name}</strong><span className="delegation-row-topic" title={row.topic}>{row.topic}</span></span>
      </button>
      {/* Its own column, so the status sits on the same line as Open (owner, 28 October 2026). */}
      <span className="delegation-status"><i className="delegation-mark" aria-hidden="true" />{row.label}{elapsed !== '—' && <><span aria-hidden="true"> · </span><time aria-label="Elapsed time">{elapsed}</time></>}</span>
      {stoppable(row) && <StopControl row={row} onError={onError} />}
      <button type="button" className="delegation-open" disabled={!row.sideSessionId} onClick={() => row.sideSessionId && onOpen(row.sideSessionId)} aria-label={`${row.bucket === 'approval' ? 'Open to approve' : 'Open'} the conversation with ${row.name}: ${row.topic}`}>{row.bucket === 'approval' ? 'Review' : 'Open'}<ArrowUpRight size={12} aria-hidden="true" /></button>
    </div>
    {open && <div id={panel} className="delegation-detail">
      {row.preview && <p className="delegation-brief" title={row.preview}>{row.preview}</p>}
      {row.error && <p className="delegation-error" role="status">{row.error}</p>}
      {row.bucket === 'approval' && <p className="delegation-hint">{row.asking ? `${row.name} asked you a question and is waiting in its own conversation. Open it to answer; the answer goes only to ${row.name}.` : `Waiting for you in ${row.name}'s conversation. Open it to approve or decline.`}</p>}
      {row.bucket === 'interrupted' && <p className="delegation-hint">Bitbots restarted before this finished. It was not sent again, so open the conversation to see what was done.</p>}
      {row.bucket === 'queued' && <p className="delegation-hint">Waiting for a free slot. It starts by itself.</p>}
      {!row.recorded && <p className="delegation-hint">Sent before assignments were recorded{row.bucket === 'earlier' ? ', so its own result is in the conversation.' : '; this is the conversation’s current state.'}</p>}
      {onFollowUp && row.bucket !== 'queued' && <button type="button" className="delegation-followup" onClick={() => onFollowUp(row)}>Ask for an update</button>}
      <Workspace row={row} active={open} />
    </div>}
  </li>
}

export function DelegationGroup({ rows, onOpen, originSessionId, onFollowUp }: { rows: readonly DelegationRowModel[]; onOpen: (sessionId: string) => void; /** The Manager's conversation the group belongs to; the group stop is scoped to it. */ originSessionId?: string; /** Puts a follow-up question in the Manager's message box; the owner sends it. */ onFollowUp?: (row: DelegationRowModel) => void }) {
  const [problem, setProblem] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const [confirmAll, setConfirmAll] = useState(false)
  const nouns = useEntityNoun({ plural: true })
  const anyActive = rows.some((row) => isActiveBucket(row.bucket))
  const [manual, setManual] = useState<boolean | null>(null)
  const expanded = manual ?? anyActive
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!anyActive) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [anyActive])
  const stopRows = rows.filter(stoppable)
  const stopAll = async () => {
    setStopping(true)
    setProblem(null)
    // One scoped call: the daemon withdraws queued briefs and cancels only the assignments named, only in this conversation.
    try { await rpc('delegation.cancelGroup', { originSessionId, delegationIds: stopRows.map((row) => row.delegationId) }) } catch (reason) { setProblem(reason instanceof Error ? reason.message : String(reason)) }
    setStopping(false)
    setConfirmAll(false)
  }
  const faces = [...new Map(rows.map((row) => [row.agent?.id ?? row.key, row])).values()]
  const title = rows.length === 1 ? `Assigned to ${rows[0].name}` : `Assigned to ${rows.length} ${nouns}`
  const names = faces.length <= 2 ? faces.map((row) => row.name).join(' and ') : `${faces.slice(0, 2).map((row) => row.name).join(', ')} +${faces.length - 2}`
  const total = groupElapsed(rows, now)
  const attention = rows.some((row) => row.bucket === 'approval')
  const failed = rows.some((row) => row.bucket === 'failed' || row.bucket === 'interrupted')
  const id = `delegation-group-${rows[0].key}`.replace(/[^A-Za-z0-9_-]/g, '')
  return <section className={`delegation-group${expanded ? ' open' : ''}${anyActive ? ' active' : ''}${attention ? ' attention' : ''}${failed ? ' failed' : ''}`} aria-label={title}>
    {/* Owner, 28 October 2026: a "Messaged" chip like "Message from", centred, that opens in place. */}
    <div className="team-chip-row delegation-chip-row">
      <button type="button" className="team-chip delegation-head" aria-expanded={expanded} aria-controls={id} onClick={() => setManual(!expanded)}>
        <span>Messaged</span>
        <span className="delegation-faces" aria-hidden="true">{faces.slice(0, 3).map((row) => <Art key={row.agent?.id ?? row.key} agent={row.agent} name={row.name} size={18} mood={MOOD[row.bucket]} />)}{faces.length > 3 && <span className="delegation-more">+{faces.length - 3}</span>}</span>
        <b className="delegation-names">{names}</b>
        <em className="delegation-summary">{summarizeBuckets(rows)}{total !== '—' && <> · <time aria-label="Elapsed time">{total}</time></>}</em>
        <ChevronDown size={12} className={`delegation-caret${expanded ? ' open' : ''}`} aria-hidden="true" />
      </button>
    </div>
    {expanded && <ul id={id} className="delegation-list">{rows.map((row) => <Row key={row.key} row={row} now={now} onOpen={onOpen} onError={setProblem} onFollowUp={onFollowUp} />)}</ul>}
    {((stopRows.length > 1 && !!originSessionId) || problem) && <div className="delegation-foot">
      {problem && <p className="delegation-error" role="alert">{problem}</p>}
      {stopRows.length > 1 && !!originSessionId && (confirmAll
        ? <span className="delegation-stop-confirm" role="group" aria-label="Stop all assignments?"><button type="button" className="delegation-stop danger" disabled={stopping} onClick={() => void stopAll()}>{stopping ? 'Stopping…' : `Stop all ${stopRows.length}`}</button><button type="button" className="delegation-stop" disabled={stopping} onClick={() => setConfirmAll(false)}>Keep</button></span>
        : <button type="button" className="delegation-stop" onClick={() => setConfirmAll(true)}><Square size={10} aria-hidden="true" />Stop all {stopRows.length}</button>)}
    </div>}
  </section>
}
