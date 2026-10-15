import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Bell, ChevronDown, Download, Laptop, Monitor, Plus, QrCode, Send, ShieldAlert, Smartphone, WifiOff } from 'lucide-react'
import { fetchSnapshot, listenForDaemonEvents, rpc } from '../tauri'
import type { Agent, PermissionRequest, Session, Snapshot } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentLook } from '../blob/look'
import { agentColorHex } from '../ui/agentColor'
import { ApprovalCard } from '../ui/ApprovalCard'
import { blobState, peerLine } from '../ui/CompanionTeam'
import { StatusDot } from '../ui/StatusDot'
import { mainSessionFor } from '../ui/teamSelectors'
import { useEntityNoun } from '../ui/vocabulary'
import logo from '../assets/bloblex-128.png'
import type { RemoteHost, RemoteHostState, RemoteTier } from './remoteContract'

type Screen = 'connect' | 'bots' | 'chat' | 'device'
const KEY = 'bitbots.remote.client'

interface ClientPrefs { paired: boolean; deviceName: string; notifications: boolean }

function readPrefs(): ClientPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<ClientPrefs>
    return { paired: raw.paired === true, deviceName: typeof raw.deviceName === 'string' && raw.deviceName ? raw.deviceName : 'This phone', notifications: raw.notifications === true }
  } catch { return { paired: false, deviceName: 'This phone', notifications: false } }
}
function writePrefs(next: ClientPrefs) { try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* private mode */ } }

const HOST_WORD: Record<RemoteHostState, string> = { online: 'Online', asleep: 'Asleep', offline: 'Offline', reconnecting: 'Reconnecting' }
const TIER_WORD: Record<RemoteTier, string> = { viewer: 'View only', chat: 'Chat', operator: 'Chat and approve' }

function ago(iso: string | null): string {
  if (!iso) return 'a while ago'
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (seconds < 90) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`
  return `${Math.round(seconds / 86_400)} d ago`
}

function hostStatus(state: RemoteHostState) {
  return <StatusDot status={state === 'online' ? 'working' : state === 'reconnecting' ? 'waiting' : 'offline'} label={HOST_WORD[state]} />
}

/** One line under a name, never a repeat of the role chip next to it. */
function subtitle(agent: Agent, sessions: Session[], state: ReturnType<typeof blobState>): string {
  const line = peerLine(agent, sessions, state)
  return line.trim() === (agent.role ?? '').trim() ? 'Ready' : line
}

/** The phone shows plain text; Markdown emphasis markers would just be noise. */
function plain(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
}

function formatCode(value: string): string {
  const clean = value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 8)
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean
}

/**
 * The phone/browser side of Remote mode (preview). A phone-first shell: connect,
 * pick a computer, pick a bot, chat. It talks only through the same `rpc`
 * bridge as the desktop UI, here answered by the simulator, and it is labelled
 * as a preview everywhere it could be mistaken for a live connection.
 */
export function RemoteApp() {
  const noun = useEntityNoun()
  const nouns = useEntityNoun({ plural: true })
  const [prefs, setPrefs] = useState<ClientPrefs>(readPrefs)
  const [screen, setScreen] = useState<Screen>(prefs.paired ? 'bots' : 'connect')
  const [hosts, setHosts] = useState<RemoteHost[]>([])
  const [hostId, setHostId] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [agentId, setAgentId] = useState<string | null>(null)
  const [sheet, setSheet] = useState<null | 'hosts'>(null)
  const [busy, setBusy] = useState(false)

  const host = hosts.find((item) => item.id === hostId) ?? hosts.find((item) => item.state === 'online') ?? hosts[0] ?? null
  const agents = useMemo(() => (snapshot?.agents ?? []).filter((agent) => !agent.archived && agent.hidden !== true), [snapshot])
  const sessions = snapshot?.sessions ?? []
  const runtimes = snapshot?.runtimes ?? []
  const online = host?.state === 'online'

  const refresh = useCallback(async () => {
    try {
      const [list, snap] = await Promise.all([rpc<RemoteHost[]>('remote.hosts.list'), fetchSnapshot()])
      setHosts(list)
      setSnapshot(snap)
      setHostId((current) => current ?? list.find((item) => item.state === 'online')?.id ?? list[0]?.id ?? null)
    } catch { /* the preview bridge can fail only while reloading */ }
  }, [])

  useEffect(() => {
    if (!prefs.paired) return
    void refresh()
    let stop: (() => void) | null = null
    void listenForDaemonEvents((event) => {
      if (event.type.startsWith('remote.') || event.type.startsWith('session.') || event.type.startsWith('permission.')) void refresh()
    }).then((fn) => { stop = fn }).catch(() => undefined)
    return () => stop?.()
  }, [prefs.paired, refresh])

  const connect = async (code: string, deviceName: string) => {
    setBusy(true)
    await new Promise((resolve) => window.setTimeout(resolve, 900))
    const next = { ...prefs, paired: true, deviceName: deviceName.trim() || 'This phone' }
    writePrefs(next)
    setPrefs(next)
    setBusy(false)
    void code
    setScreen('bots')
  }

  const chooseHost = async (id: string) => {
    setSheet(null)
    setHostId(id)
    try { await rpc('remote.hosts.select', { hostId: id }) } catch { /* ignore */ }
    setScreen('bots')
    void refresh()
  }

  const forget = () => {
    const next = { ...prefs, paired: false }
    writePrefs(next)
    setPrefs(next)
    setScreen('connect')
  }

  const waiting = agents.filter((agent) => blobState(agent, sessions, runtimes, !!online) === 'waiting')
  const activeAgent = agents.find((agent) => agent.id === agentId) ?? null

  return <div className="rm-stage">
    <div className="rm-phone" data-screen={screen}>
      <p className="rm-ribbon" role="note">Preview · simulated, not connected to a relay</p>
      {screen === 'connect' && <ConnectScreen busy={busy} onConnect={connect} nouns={nouns} />}
      {screen !== 'connect' && <>
        <header className="rm-top">
          {screen === 'chat'
            ? <button type="button" className="rm-icon" aria-label="Back to bots" onClick={() => setScreen('bots')}><ArrowLeft size={19} /></button>
            : <img className="rm-logo" src={logo} alt="" width="26" height="26" />}
          {screen === 'chat' && activeAgent
            ? <div className="rm-title"><strong>{activeAgent.name}</strong><small>{peerLine(activeAgent, sessions, blobState(activeAgent, sessions, runtimes, !!online))}</small></div>
            : <button type="button" className="rm-host" onClick={() => setSheet('hosts')} aria-haspopup="dialog" aria-label={`Computer: ${host?.name ?? 'none'}. Switch computer`}>
              {host && hostStatus(host.state)}
              <span><strong>{host?.name ?? 'No computer'}</strong>{host && <small>{HOST_WORD[host.state]}</small>}</span>
              <ChevronDown size={15} aria-hidden="true" />
            </button>}
        </header>
        <main className="rm-main">
          {screen === 'bots' && <BotsScreen host={host} agents={agents} sessions={sessions} runtimes={runtimes} online={!!online} waiting={waiting} nouns={nouns} onOpen={(id) => { setAgentId(id); setScreen('chat') }} onRetry={() => void refresh()} onSwitch={() => setSheet('hosts')} />}
          {screen === 'chat' && activeAgent && <ChatScreen agent={activeAgent} session={mainSessionFor(sessions, activeAgent.id)} permissions={snapshot?.permissions ?? []} host={host} online={!!online} noun={noun} />}
          {screen === 'device' && <DeviceScreen prefs={prefs} host={host} onPrefs={(next) => { writePrefs(next); setPrefs(next) }} onForget={forget} />}
        </main>
        <nav className="rm-tabs" aria-label="Sections">
          <button type="button" className={screen === 'bots' || screen === 'chat' ? 'on' : ''} onClick={() => setScreen('bots')}><Monitor size={19} aria-hidden="true" /><span>{nouns.charAt(0).toUpperCase() + nouns.slice(1)}</span>{waiting.length > 0 && <i className="rm-badge" aria-label={`${waiting.length} need you`}>{waiting.length}</i>}</button>
          <button type="button" className={screen === 'device' ? 'on' : ''} onClick={() => setScreen('device')}><Smartphone size={19} aria-hidden="true" /><span>This device</span></button>
        </nav>
      </>}
      {sheet === 'hosts' && <HostSheet hosts={hosts} current={host?.id ?? null} onClose={() => setSheet(null)} onChoose={(id) => void chooseHost(id)} onAdd={() => { setSheet(null); setScreen('connect') }} />}
    </div>
  </div>
}

function ConnectScreen({ busy, onConnect, nouns }: { busy: boolean; onConnect: (code: string, name: string) => void; nouns: string }) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const complete = code.replace('-', '').length === 8
  return <main className="rm-connect">
    <img src={logo} alt="" width="56" height="56" />
    <h1>Connect to your computer</h1>
    <p>Open Bitbots on the computer, go to Settings &gt; Remote and choose “Show pairing code”. Then enter it here.</p>
    <label className="rm-field">Pairing code
      <input className="rm-code" inputMode="text" autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX" value={code}
        onChange={(event) => setCode(formatCode(event.target.value))} aria-describedby="rm-code-hint" />
    </label>
    <label className="rm-field">Name this device
      <input autoComplete="off" placeholder="This phone" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
    </label>
    <button type="button" className="rm-primary" disabled={!complete || busy} onClick={() => onConnect(code, name)}>{busy ? 'Connecting…' : 'Connect'}</button>
    <button type="button" className="rm-secondary" disabled title="Needs a camera; not available in the preview"><QrCode size={16} aria-hidden="true" />Scan QR code</button>
    <p id="rm-code-hint" className="rm-hint">Codes work once and expire after five minutes. Your messages are sealed between this device and your computer; the relay only passes them along. Any 8 characters work in this preview. Your {nouns} stay on your computer.</p>
  </main>
}

function BotsScreen({ host, agents, sessions, runtimes, online, waiting, nouns, onOpen, onRetry, onSwitch }: {
  host: RemoteHost | null; agents: Agent[]; sessions: Session[]; runtimes: NonNullable<Snapshot['runtimes']>; online: boolean; waiting: Agent[]; nouns: string
  onOpen: (id: string) => void; onRetry: () => void; onSwitch: () => void
}) {
  if (host && host.state !== 'online') {
    return <section className="rm-away" aria-live="polite">
      <span className="rm-away-icon"><WifiOff size={24} aria-hidden="true" /></span>
      <h2>{host.name} is {host.state === 'asleep' ? 'asleep' : host.state === 'reconnecting' ? 'reconnecting' : 'offline'}</h2>
      <p>{host.state === 'asleep'
        ? `It went to sleep ${ago(host.lastSeenAt)}. Wake the computer and it will show up here. To prevent this, turn on Keep awake in Settings > Remote on that computer.`
        : `Last seen ${ago(host.lastSeenAt)}. Your ${nouns} are there, but Bitbots can't reach the computer right now. Nothing you type is queued.`}</p>
      <div className="rm-away-actions">
        <button type="button" className="rm-primary" onClick={onRetry}>Check again</button>
        <button type="button" className="rm-secondary" onClick={onSwitch}><Laptop size={16} aria-hidden="true" />Switch computer</button>
      </div>
    </section>
  }
  return <section>
    {waiting.length > 0 && <p className="rm-need" role="status"><StatusDot status="waiting" /> {waiting.length === 1 ? '1 needs you' : `${waiting.length} need you`}</p>}
    <ul className="rm-bots">
      {agents.map((agent) => {
        const state = blobState(agent, sessions, runtimes, online)
        return <li key={agent.id}>
          <button type="button" className={`rm-bot state-${state}`} onClick={() => onOpen(agent.id)}>
            <span className="rm-bot-face"><BlobCanvas decorative color={agentColorHex(agent.color)} size={40} mini mood={state === 'offline' ? 'offline' : 'idle'} look={agentLook(agent)} label={agent.name} /></span>
            <span className="rm-bot-copy">
              <span className="rm-bot-name"><strong>{agent.name}</strong>{agent.role?.trim() && <span className="rm-role">{agent.role.trim()}</span>}</span>
              <small className={state === 'waiting' ? 'warn' : ''}>{subtitle(agent, sessions, state)}</small>
            </span>
            {state === 'waiting' && <StatusDot status="waiting" />}
            {state === 'working' && <StatusDot status="working" />}
          </button>
        </li>
      })}
    </ul>
    {agents.length === 0 && <p className="rm-empty">No {nouns} on this computer yet. Create one in Bitbots on the computer and it will appear here.</p>}
  </section>
}

function ChatScreen({ agent, session, permissions, host, online, noun }: { agent: Agent; session: Session | null; permissions: PermissionRequest[]; host: RemoteHost | null; online: boolean; noun: string }) {
  const [draft, setDraft] = useState('')
  const [sent, setSent] = useState<Array<{ id: string; text: string }>>([])
  const logRef = useRef<HTMLDivElement>(null)
  const tier: RemoteTier = host?.tier ?? 'chat'
  const canSend = online && tier !== 'viewer'
  const messages = (session?.messages ?? []).filter((message) => (message.role === 'user' || message.role === 'assistant') && String(message.content ?? '').trim())
  const pending = permissions.find((item) => item.sessionId === session?.id && item.kind !== 'question') ?? null
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }) }, [messages.length, sent.length])
  const send = async () => {
    const text = draft.trim()
    if (!text || !canSend || !session) return
    setDraft('')
    setSent((current) => [...current, { id: `local-${Date.now()}`, text }])
    try { await rpc('session.prompt', { sessionId: session.id, text }) } catch { /* the preview bridge may not model prompts */ }
  }
  return <section className="rm-chat">
    <div className="rm-log" ref={logRef} role="log" aria-live="polite" aria-label={`Conversation with ${agent.name}`}>
      {messages.length === 0 && sent.length === 0 && <p className="rm-empty">Nothing here yet. Say hello to {agent.name}.</p>}
      {messages.slice(-30).map((message) => <p key={message.id} className={`rm-msg ${message.role}`}>{plain(String(message.content))}</p>)}
      {sent.map((message) => <p key={message.id} className="rm-msg user">{message.text}</p>)}
    </div>
    {pending && (tier === 'operator'
      ? <div className="rm-approval"><ApprovalCard permission={pending} focusOnMount={false} onReply={async (choice) => { await rpc('permission.reply', { permissionId: pending.id, choice }); return true }} /></div>
      : <div className="rm-approval locked" role="status">
        <ShieldAlert size={18} aria-hidden="true" />
        <div><strong>{agent.name} is asking permission</strong><small>This device can’t approve. Approve it on {host?.name ?? 'your computer'}, or ask for “Chat and approve” in Settings &gt; Remote.</small></div>
      </div>)}
    <form className="rm-composer" onSubmit={(event) => { event.preventDefault(); void send() }}>
      <textarea rows={1} value={draft} placeholder={!online ? 'Computer is offline' : tier === 'viewer' ? 'View only on this device' : `Message ${agent.name}`} disabled={!canSend}
        aria-label={`Message ${agent.name}`} onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
      <button type="submit" className="rm-send" aria-label="Send" disabled={!canSend || !draft.trim()}><Send size={17} aria-hidden="true" /></button>
    </form>
    <p className="rm-tier">{TIER_WORD[tier]} · a message here runs on {host?.name ?? 'your computer'}, within its approval mode. {noun === 'bot' ? 'Bots' : 'Blobs'} never leave it.</p>
  </section>
}

function DeviceScreen({ prefs, host, onPrefs, onForget }: { prefs: ClientPrefs; host: RemoteHost | null; onPrefs: (next: ClientPrefs) => void; onForget: () => void }) {
  return <section className="rm-device">
    <h2>{prefs.deviceName}</h2>
    <dl className="rm-facts">
      <div><dt>Connected to</dt><dd>{host?.name ?? 'No computer'}</dd></div>
      <div><dt>This device may</dt><dd>{TIER_WORD[host?.tier ?? 'chat']}</dd></div>
      <div><dt>Connection</dt><dd>Sealed end to end, through a relay</dd></div>
    </dl>
    <div className="rm-card">
      <span className="rm-card-icon"><Download size={18} aria-hidden="true" /></span>
      <div><strong>Install Bitbots on this device</strong><small>On iPhone choose Share, then “Add to Home Screen”. On Android choose “Install app” in the browser menu. It opens full screen like an app.</small></div>
    </div>
    <div className="rm-card">
      <span className="rm-card-icon"><Bell size={18} aria-hidden="true" /></span>
      <div><strong>Tell me when a bot needs me</strong><small>A quiet notification with no message text. You can change this any time.</small></div>
      <button type="button" role="switch" aria-checked={prefs.notifications} aria-label="Notifications" className={`rm-switch ${prefs.notifications ? 'on' : ''}`} onClick={() => onPrefs({ ...prefs, notifications: !prefs.notifications })}><i /></button>
    </div>
    <button type="button" className="rm-danger" onClick={onForget}><Plus size={16} aria-hidden="true" style={{ transform: 'rotate(45deg)' }} />Forget this computer</button>
  </section>
}

function HostSheet({ hosts, current, onClose, onChoose, onAdd }: { hosts: RemoteHost[]; current: string | null; onClose: () => void; onChoose: (id: string) => void; onAdd: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return <div className="rm-sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="rm-sheet" role="dialog" aria-modal="true" aria-label="Your computers">
      <span className="rm-grab" aria-hidden="true" />
      <h2>Your computers</h2>
      <ul>
        {hosts.map((item) => <li key={item.id}>
          <button type="button" className={item.id === current ? 'on' : ''} onClick={() => onChoose(item.id)}>
            {hostStatus(item.state)}
            <span><strong>{item.name}</strong><small>{HOST_WORD[item.state]}{item.state === 'online' ? ` · ${item.botCount} · ${item.waitingCount} waiting` : ` · last seen ${ago(item.lastSeenAt)}`}</small></span>
          </button>
        </li>)}
      </ul>
      <button type="button" className="rm-secondary" onClick={onAdd}><Plus size={16} aria-hidden="true" />Add a computer</button>
    </section>
  </div>
}
