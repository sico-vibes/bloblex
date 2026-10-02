import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import type { Agent, Runtime, Session } from '../types'
import { labelize } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentColorHex } from './agentColor'
import { deriveCompanionStatus } from './companionStatus'
import { AgentContextMenu } from './AgentContextMenu'
import { activeAgents, rosterGroupLabel, rosterGroups, rosterPreview, rosterRows, runtimeDotClass, runtimeUsable, shortTime } from './rosterSelectors'

export function AgentRoster({ agents, sessions, runtimes, connected, busy, selectedAgentId, query, onQueryChange, onSelect, onCreate, onScan, onNewSession, onEdit, onDuplicate, onArchive }: {
  agents: Agent[]
  sessions: Session[]
  runtimes: Runtime[]
  connected: boolean
  busy: boolean
  selectedAgentId: string | null
  query: string
  onQueryChange: (query: string) => void
  onSelect: (agent: Agent) => void
  onCreate: () => void
  onScan: () => void
  onNewSession: (agent: Agent) => void
  onEdit: (agent: Agent) => void
  onDuplicate: (agent: Agent) => void
  onArchive: (agent: Agent) => void
}) {
  const rows = rosterRows(agents, sessions, query)
  const groups = rosterGroups(rows)
  const showGroups = new Set(rows.map((row) => row.agent.runtimeId)).size > 1
  const active = activeAgents(agents)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const [focusId, setFocusId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ agentId: string; x: number; y: number } | null>(null)
  const menuAgent = agents.find((agent) => agent.id === menu?.agentId) ?? null
  const tabId = rows.some((row) => row.agent.id === focusId)
    ? focusId
    : rows.some((row) => row.agent.id === selectedAgentId) ? selectedAgentId : rows[0]?.agent.id ?? null

  const visibleIds = rows.map((row) => row.agent.id).join('\0')
  const movedFocus = useRef(false)
  useEffect(() => {
    if (!focusId || visibleIds.split('\0').includes(focusId)) { movedFocus.current = false; return }
    if (movedFocus.current) return
    movedFocus.current = true
    const next = visibleIds ? visibleIds.split('\0')[0] : undefined
    if (next) {
      setFocusId(next)
      rowRefs.current.get(next)?.focus()
    } else document.querySelector<HTMLButtonElement>('[aria-label="Create blob"]')?.focus()
  }, [focusId, visibleIds])

  const move = (agentId: string, key: string) => {
    const ids = rows.map((row) => row.agent.id)
    const index = ids.indexOf(agentId)
    if (index < 0 || !ids.length) return
    const next = key === 'ArrowDown' ? ids[(index + 1) % ids.length]
      : key === 'ArrowUp' ? ids[(index - 1 + ids.length) % ids.length]
        : key === 'Home' ? ids[0]
          : key === 'End' ? ids[ids.length - 1] : undefined
    if (!next) return
    setFocusId(next)
    rowRefs.current.get(next)?.focus()
  }

  const openMenu = (agent: Agent, element: HTMLButtonElement, x: number, y: number) => {
    rowRefs.current.set(agent.id, element)
    setFocusId(agent.id)
    setMenu({ agentId: agent.id, x, y })
  }

  const runtimeFor = (runtimeId: string) => runtimes.find((runtime) => runtime.id === runtimeId)

  return <>
    <label className="sidebar-search"><Search size={14} /><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search" aria-label="Search agents and conversations" /></label>
    <nav className="bot-list runtime-list" aria-label="Blobs">
      {showGroups ? groups.map((group) => <div key={group.runtimeId}>
        <div className="roster-group-label">{rosterGroupLabel(runtimeFor(group.runtimeId), group.runtimeId)}</div>
        {group.rows.map((row) => renderRow(row))}
      </div>) : rows.map((row) => renderRow(row))}
      {connected && runtimes.length === 0 && <div className="rail-empty">No coding CLIs detected yet.<button type="button" onClick={onScan}>Scan again</button></div>}
      {connected && runtimes.length > 0 && active.length === 0 && <div className="rail-empty">No blobs yet.<button type="button" onClick={onCreate}>Create blob</button></div>}
      {connected && active.length > 0 && rows.length === 0 && <div className="rail-empty">Nothing matches “{query}”.</div>}
      {!connected && active.length === 0 && <div className="rail-empty">Connect to your local runtime to see installed agents.</div>}
    </nav>
    {menu && menuAgent && <AgentContextMenu
      agent={menuAgent}
      position={menu}
      enabled={{
        newSession: connected && !busy && runtimeUsable(runtimeFor(menuAgent.runtimeId)),
        duplicate: connected && !busy,
        archive: connected && !busy,
      }}
      onClose={() => { setMenu(null); window.setTimeout(() => rowRefs.current.get(menuAgent.id)?.focus(), 0) }}
      onNewSession={() => { setMenu(null); onNewSession(menuAgent) }}
      onEdit={() => { setMenu(null); onEdit(menuAgent) }}
      onDuplicate={() => { setMenu(null); onDuplicate(menuAgent) }}
      onArchive={() => { setMenu(null); onArchive(menuAgent) }}
    />}
  </>

  function renderRow(row: (typeof rows)[number]) {
    const { agent } = row
    const runtime = runtimeFor(agent.runtimeId)
    const status = deriveCompanionStatus({ connected, runtime, session: row.latest })
    const selected = agent.id === selectedAgentId
    return <button
      key={agent.id}
      type="button"
      data-agent-id={agent.id}
      ref={(node) => { if (node) rowRefs.current.set(agent.id, node); else rowRefs.current.delete(agent.id) }}
      className={`bot-row ${selected ? 'selected' : ''}`}
      aria-current={selected ? 'true' : undefined}
      tabIndex={agent.id === tabId ? 0 : -1}
      onClick={() => { setFocusId(agent.id); onSelect(agent) }}
      onContextMenu={(event) => { event.preventDefault(); openMenu(agent, event.currentTarget, event.clientX, event.clientY) }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          openMenu(agent, event.currentTarget, rect.left + 28, rect.bottom)
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          move(agent.id, event.key)
          return
        }
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setFocusId(agent.id); onSelect(agent) }
      }}
    >
      <BlobCanvas color={agentColorHex(agent.color)} size={42} mood={status.mood} label={agent.name} />
      <span className="bot-row-copy">
        <span className="bot-row-top"><strong>{agent.name}</strong>{row.latest?.updatedAt && <time>{shortTime(row.latest.updatedAt)}</time>}</span>
        <span className="bot-row-preview">{rosterPreview(row, connected, status.label)}</span>
        <span className="bot-row-meta"><i className={`status-dot ${connected ? runtimeDotClass(runtime?.status) : 'muted'}`} />{labelize(runtime?.provider, 'Runtime')} · {status.label}</span>
      </span>
    </button>
  }
}
