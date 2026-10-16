// FIX21 companion panels. Kept out of App.tsx so the companion component only
// grows where it must: the live activity summary (C9), a per-message copy
// button (C10) and the Remote row (C13).
import { useEffect, useRef, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import type { Agent, Runtime, Session } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentLook } from '../blob/look'
import { agentColorHex } from './agentColor'
import { blobState, sessionSteps } from './CompanionTeam'
import { mainSessionFor } from './teamSelectors'
import { StatusDot, type BotStatus } from './StatusDot'
import { HelpTip } from './SettingsParts'
import type { ReactNode } from 'react'

/** A companion setting's title with its explanation behind a "?", like the main Settings rows. */
export function CompanionSettingCopy({ label, hint, detail }: { label: ReactNode; hint?: ReactNode; detail?: ReactNode }) {
  return <span className="cset-copy">
    <span className="cset-title"><strong>{label}</strong>{hint && <HelpTip text={hint} align="start" placement="bottom" />}</span>
    {detail && <small>{detail}</small>}
  </span>
}
import { useEntityNoun } from './vocabulary'
import type { RemoteStatus } from '../remote/remoteContract'
import { rpc } from '../tauri'

/** "45s", "3m 4s", "1h 2m": the elapsed time shown beside a working bot. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** When each working bot started its current busy stretch, tracked across renders. */
export function useWorkingSince(agents: readonly Agent[], sessions: readonly Session[], runtimes: readonly Runtime[], connected: boolean, now: number): Map<string, number> {
  const since = useRef<Map<string, number>>(new Map())
  const map = since.current
  const busy = new Set<string>()
  for (const agent of agents) {
    if (agent.archived || agent.hidden === true) continue
    if (blobState(agent, sessions, runtimes, connected) === 'working') busy.add(agent.id)
  }
  for (const id of [...map.keys()]) if (!busy.has(id)) map.delete(id)
  for (const id of busy) if (!map.has(id)) map.set(id, now)
  return map
}

function MiniFace({ agent, size = 20, mood = 'idle' }: { agent: Agent; size?: number; mood?: 'idle' | 'offline' }) {
  return <BlobCanvas decorative color={agentColorHex(agent.color)} size={size} mini mood={mood} look={agentLook(agent)} label={agent.name} />
}

/** One line per working bot: face, name, the step it is on, a status dot and elapsed. */
export function CompanionActivitySummary({ agents, sessions, runtimes, connected, workingSince, now, onOpen }: {
  agents: readonly Agent[]
  sessions: readonly Session[]
  runtimes: readonly Runtime[]
  connected: boolean
  workingSince: ReadonlyMap<string, number>
  now: number
  onOpen: (sessionId: string | null) => void
}) {
  const nouns = useEntityNoun({ plural: true })
  const rows = agents.filter((agent) => !agent.archived && agent.hidden !== true).flatMap((agent) => {
    const session = mainSessionFor(sessions, agent.id)
    if (blobState(agent, sessions, runtimes, connected) !== 'working') return []
    const steps = sessionSteps(session)
    const current = [...steps].reverse().find((step) => step.running) ?? steps.at(-1)
    return [{ agent, session, title: current?.title ?? 'Working…', since: workingSince.get(agent.id) ?? now }]
  })
  if (rows.length === 0) return <p className="companion-empty">Nothing is running.</p>
  return <div className="companion-working-list">
    {rows.map(({ agent, session, title, since }) => <button type="button" key={agent.id} className="companion-activity-row working" onClick={() => onOpen(session?.id ?? null)} aria-label={`${agent.name} is working: ${title}`} title={title}>
      <MiniFace agent={agent} size={20} />
      <span><strong>{agent.name}</strong><small className="shimmer">{title}</small></span>
      <StatusDot status="working" />
      <em className="companion-elapsed">{formatElapsed(now - since)}</em>
    </button>)}
    <p className="cset-note" aria-hidden="true">{rows.length} of {agents.length} {nouns} working</p>
  </div>
}

/** The companion settings' Remote row (C13): read-only status plus a Settings shortcut. */
const REMOTE_DOT: Record<RemoteStatus['link'], BotStatus> = { online: 'working', connecting: 'waiting', reconnecting: 'waiting', off: 'offline', error: 'failed' }

/** The companion settings' Remote row (C13): read-only status plus a Settings shortcut. */
export function CompanionRemoteRow({ onOpenSettings }: { onOpenSettings: (page: 'Remote') => void }) {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    let alive = true
    void rpc<RemoteStatus>('remote.status').then((value) => { if (alive) setStatus(value) }).catch(() => { if (alive) setUnavailable(true) })
    return () => { alive = false }
  }, [])
  if (unavailable) return null
  const on = status?.enabled === true
  const devices = status?.connectedCount ?? 0
  const summary = !status ? 'Checking…' : on ? (devices > 0 ? `On, ${devices} device${devices === 1 ? '' : 's'} connected` : 'On, no devices connected') : 'Off'
  return <div className="cset-row">
    <span className="cset-copy"><strong className="companion-remote-copy">{on && status && <StatusDot status={REMOTE_DOT[status.link]} label={status.link} />}Remote</strong><small>{summary}</small></span>
    <button type="button" className="btn small secondary" onClick={() => onOpenSettings('Remote')} aria-label="Open Remote settings"><SlidersHorizontal size={12} aria-hidden="true" />Settings</button>
  </div>
}
