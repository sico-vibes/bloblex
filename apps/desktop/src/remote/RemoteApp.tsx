import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, Download, List, LogOut, Monitor, RefreshCw, Send, ShieldAlert, Smartphone, WifiOff } from 'lucide-react'
import { fetchSnapshot, listenForDaemonEvents, previewMode, rpc } from '../tauri'
import type { Agent, PermissionRequest, Session, Snapshot } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentLook } from '../blob/look'
import { agentColorHex } from '../ui/agentColor'
import { ApprovalCard } from '../ui/ApprovalCard'
import { blobState, peerLine } from '../ui/CompanionTeam'
import { StatusDot } from '../ui/StatusDot'
import { isAutomationSession, isSideSession, mainSessionFor } from '../ui/teamSelectors'
import { useEntityNoun } from '../ui/vocabulary'
import logo from '../assets/bloblex-128.png'
import type { RemoteTier } from './remoteContract'
import type { RemoteConnectionStatus, RemoteMe } from './remoteTransport'
import { codeFromHash, createPreviewDeviceApi, describeThisDevice, errorCode, type RemoteDeviceApi } from './deviceApi'
import { applyUpdate, onUpdateReady } from './serviceWorker'

type Screen = 'checking' | 'connect' | 'waiting' | 'bots' | 'chat' | 'device'
const TIER_WORD: Record<RemoteTier, string> = { viewer: 'View only', chat: 'Chat', operator: 'Chat and approve' }
/** How often the waiting screen asks whether the owner has decided (PROTOCOL §4.3). */
export const PAIR_POLL_MS = 2000

/** One line under a name, never a repeat of the role chip next to it. */
function subtitle(agent: Agent, sessions: Session[], state: ReturnType<typeof blobState>): string {
  const line = peerLine(agent, sessions, state)
  return line.trim() === (agent.role ?? '').trim() ? 'Ready' : line
}

/** A bot's own conversations on the phone: not archived, not bot-to-bot, not scheduled; newest first. */
export function phoneConversations(sessions: readonly Session[], agentId: string): Session[] {
  return sessions
    .filter((session) => session.agentId === agentId && !session.archived && !isSideSession(session) && !isAutomationSession(session))
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
}

function shortWhen(iso: string | undefined): string {
  const time = Date.parse(iso ?? '')
  if (!Number.isFinite(time)) return ''
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes} min`
  if (minutes < 1440) return `${Math.round(minutes / 60)} h`
  return `${Math.round(minutes / 1440)} d`
}

/** The phone shows plain text; Markdown emphasis markers would just be noise. */
function plain(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
}

export function formatCode(value: string): string {
  const clean = value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 8)
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean
}

const messageOf = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback

/** Words for a refused send, by the gateway's code. */
function sendProblem(reason: unknown, hostName: string): string {
  switch (errorCode(reason)) {
    case 'quiet_hours': return `Quiet hours are on at ${hostName}, so this device can only read right now.`
    case 'tier_required': return 'This device can only view. Ask for Chat on the computer, in Settings › Remote.'
    case 'rate_limited': return 'Too many messages at once. Wait a moment and try again.'
    case 'network': return `Could not reach ${hostName}. Your message was not sent.`
    default: return messageOf(reason, 'The message was not sent.')
  }
}

/**
 * The phone/browser side of Remote mode: pair with the computer (the owner
 * approves it there), then see the bots, chat and, when allowed, approve. It
 * talks through `rpc` and the event stream like the desktop UI; `device`
 * answers who this device is, pairing and the connection state.
 */
export function RemoteApp({ device: deviceProp, pollMs = PAIR_POLL_MS }: { device?: RemoteDeviceApi; pollMs?: number } = {}) {
  const device = useMemo(() => deviceProp ?? createPreviewDeviceApi(), [deviceProp])
  const noun = useEntityNoun()
  const nouns = useEntityNoun({ plural: true })
  const [screen, setScreen] = useState<Screen>('checking')
  const [me, setMe] = useState<RemoteMe | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingName, setPendingName] = useState('')
  const [connection, setConnection] = useState<RemoteConnectionStatus>('connecting')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [agentId, setAgentId] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<Record<string, Session>>({})
  const [listOpen, setListOpen] = useState(false)
  const [updateReady, setUpdateReady] = useState(false)

  const signedIn = me !== null
  const hostName = me?.host.name ?? 'your computer'
  const tier: RemoteTier = me?.device.tier ?? 'viewer'
  const agents = useMemo(() => (snapshot?.agents ?? []).filter((agent) => !agent.archived && agent.hidden !== true), [snapshot])
  const sessions = snapshot?.sessions ?? []
  const runtimes = snapshot?.runtimes ?? []
  const online = connection === 'online'

  const signOut = useCallback((message: string | null) => {
    setMe(null)
    setSnapshot(null)
    setNotice(message)
    setScreen('connect')
  }, [])

  const check = useCallback(async () => {
    try {
      const next = await device.me()
      setMe(next)
      setScreen((current) => current === 'checking' || current === 'connect' || current === 'waiting' ? 'bots' : current)
    } catch (reason) {
      const code = errorCode(reason)
      if (code === 'device_revoked') { signOut('This device was removed on the computer. Pair it again to come back.'); return }
      if (code === 'network') { setNotice('Could not reach the computer. Check that it is awake and on Tailscale.'); setScreen('connect'); return }
      // Not paired: a pairing may still be waiting for the owner.
      const state = await device.pairStatus().catch(() => 'expired' as const)
      setScreen(state === 'pending' ? 'waiting' : 'connect')
    }
  }, [device, signOut])

  useEffect(() => { void check() }, [check])
  useEffect(() => device.onConnection((status) => {
    setConnection(status)
    if (status === 'signed_out') signOut('This device was signed out. Pair it again to come back.')
  }), [device, signOut])
  useEffect(() => onUpdateReady(() => setUpdateReady(true)), [])

  const refresh = useCallback(async () => {
    try { setSnapshot(await fetchSnapshot()) } catch (reason) {
      const code = errorCode(reason)
      if (code === 'unauthorized' || code === 'device_revoked') signOut('This device was signed out. Pair it again to come back.')
    }
  }, [signOut])

  useEffect(() => {
    if (!signedIn) return
    void refresh()
    let stop: (() => void) | null = null
    let timer: number | null = null
    void listenForDaemonEvents((event) => {
      if (!/^(session|message|turn|permission|agent|queue)\./.test(event.type)) return
      // Coalesce a burst of events into one snapshot read.
      if (timer !== null) return
      timer = window.setTimeout(() => { timer = null; void refresh() }, 250)
    }).then((fn) => { stop = fn }).catch(() => undefined)
    return () => { stop?.(); if (timer !== null) window.clearTimeout(timer) }
  }, [signedIn, refresh])

  // While the owner decides, ask every two seconds.
  useEffect(() => {
    if (screen !== 'waiting') return
    const timer = window.setInterval(() => {
      void device.pairStatus().then((state) => {
        if (state === 'approved') void check()
        else if (state === 'rejected') { setNotice('The computer declined this device.'); setScreen('connect') }
        else if (state === 'expired') { setNotice('The code expired before it was approved. Show a new one on the computer.'); setScreen('connect') }
      }).catch(() => undefined)
    }, pollMs)
    return () => window.clearInterval(timer)
  }, [screen, device, check, pollMs])

  const connect = async (code: string, name: string) => {
    setNotice(null)
    const about = describeThisDevice(typeof navigator === 'undefined' ? '' : navigator.userAgent)
    const deviceName = name.trim() || (about.kind === 'phone' ? 'My phone' : about.kind === 'tablet' ? 'My tablet' : 'My browser')
    try {
      await device.pair({ code: code.replace('-', ''), name: deviceName, ...about })
      setPendingName(deviceName)
      setScreen('waiting')
      try { history.replaceState(null, '', location.pathname) } catch { /* not in a browser */ }
    } catch (reason) {
      setNotice(errorCode(reason) === 'network' ? 'Could not reach the computer. Check that it is awake and on Tailscale.' : 'That code did not work. Check it, or show a new one on the computer.')
    }
  }

  const logout = async () => {
    await device.logout().catch(() => undefined)
    signOut(null)
  }

  const waiting = agents.filter((agent) => blobState(agent, sessions, runtimes, online) === 'waiting')
  const activeAgent = agents.find((agent) => agent.id === agentId) ?? null
  const conversations = activeAgent ? phoneConversations(sessions, activeAgent.id) : []
  const listed = conversations.find((session) => session.id === conversationId) ?? (activeAgent ? mainSessionFor(sessions, activeAgent.id) : null)
  // A conversation other than the newest may arrive without its messages; load it once.
  const activeSession = listed ? (Array.isArray(listed.messages) ? listed : loaded[listed.id] ? { ...loaded[listed.id], ...listed, messages: loaded[listed.id].messages } : listed) : null
  useEffect(() => {
    if (!listed || Array.isArray(listed.messages) || loaded[listed.id]) return
    let cancelled = false
    void rpc<Session>('session.get', { sessionId: listed.id }).then((full) => { if (!cancelled && full?.id) setLoaded((current) => ({ ...current, [full.id]: full })) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [listed, loaded])
  const openAgent = (id: string) => { setAgentId(id); setConversationId(null); setListOpen(false); setScreen('chat') }
  const preApproval = screen === 'checking' || screen === 'connect' || screen === 'waiting'

  return <div className="rm-stage">
    <div className="rm-phone" data-screen={screen}>
      {previewMode && <p className="rm-ribbon" role="note">Preview · simulated, not connected to a computer</p>}
      {updateReady && <p className="rm-update" role="status">A new version is ready.<button type="button" onClick={applyUpdate}>Reload</button></p>}
      {screen === 'checking' && <main className="rm-connect rm-checking" aria-busy="true"><img src={logo} alt="" width="56" height="56" /><p>Connecting…</p></main>}
      {screen === 'connect' && <ConnectScreen notice={notice} onConnect={connect} nouns={nouns} />}
      {screen === 'waiting' && <WaitingScreen name={pendingName} onCancel={() => setScreen('connect')} />}
      {!preApproval && <>
        <header className="rm-top">
          {screen === 'chat'
            ? <button type="button" className="rm-icon" aria-label={`Back to ${nouns}`} onClick={() => setScreen('bots')}><ArrowLeft size={19} /></button>
            : <img className="rm-logo" src={logo} alt="" width="26" height="26" />}
          {screen === 'chat' && activeAgent
            ? <>
              <div className="rm-title"><strong>{activeAgent.name}</strong><small>{activeSession?.title?.trim() || peerLine(activeAgent, sessions, blobState(activeAgent, sessions, runtimes, online))}</small></div>
              {conversations.length > 1 && <button type="button" className="rm-icon rm-list-button" aria-label={`${activeAgent.name}'s conversations`} aria-haspopup="dialog" onClick={() => setListOpen(true)}><List size={19} /></button>}
            </>
            : <div className="rm-host" aria-label={`Computer: ${hostName}, ${online ? 'online' : 'not connected'}`}>
              <StatusDot status={online ? 'working' : connection === 'reconnecting' || connection === 'connecting' ? 'waiting' : 'offline'} />
              <span><strong>{hostName}</strong><small>{online ? TIER_WORD[tier] : connection === 'offline' ? 'Offline' : 'Connecting…'}</small></span>
            </div>}
        </header>
        {!online && <p className="rm-connection" role="status">{connection === 'offline' ? `Offline. Bitbots will reconnect to ${hostName} when the network is back.` : `Reconnecting to ${hostName}…`}</p>}
        {me?.quietHoursActive && <p className="rm-connection quiet" role="status">Quiet hours: this device can read but not send.</p>}
        <main className="rm-main">
          {screen === 'bots' && <BotsScreen hostName={hostName} agents={agents} sessions={sessions} runtimes={runtimes} online={online} loaded={snapshot !== null} waiting={waiting} nouns={nouns} onOpen={openAgent} onRetry={() => void refresh()} />}
          {screen === 'chat' && activeAgent && <ChatScreen key={activeSession?.id ?? 'none'} agent={activeAgent} session={activeSession} permissions={snapshot?.permissions ?? []} hostName={hostName} online={online} tier={tier}
            canApprove={tier === 'operator' && me?.approvalsFromRemote === true} quiet={me?.quietHoursActive === true} nouns={nouns} />}
          {screen === 'device' && me && <DeviceScreen me={me} noun={noun} onLogout={() => void logout()} />}
        </main>
        <nav className="rm-tabs" aria-label="Sections">
          <button type="button" className={screen === 'bots' || screen === 'chat' ? 'on' : ''} onClick={() => setScreen('bots')}><Monitor size={19} aria-hidden="true" /><span>{nouns.charAt(0).toUpperCase() + nouns.slice(1)}</span>{waiting.length > 0 && <i className="rm-badge" aria-label={`${waiting.length} need you`}>{waiting.length}</i>}</button>
          <button type="button" className={screen === 'device' ? 'on' : ''} onClick={() => setScreen('device')}><Smartphone size={19} aria-hidden="true" /><span>This device</span></button>
        </nav>
      </>}
      {listOpen && activeAgent && <ConversationSheet agentName={activeAgent.name} conversations={conversations} current={activeSession?.id ?? null}
        onClose={() => setListOpen(false)} onChoose={(id) => { setConversationId(id); setListOpen(false) }} />}
    </div>
  </div>
}

function ConversationSheet({ agentName, conversations, current, onClose, onChoose }: { agentName: string; conversations: Session[]; current: string | null; onClose: () => void; onChoose: (id: string) => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return <div className="rm-sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="rm-sheet" role="dialog" aria-modal="true" aria-label={`${agentName}'s conversations`}>
      <span className="rm-grab" aria-hidden="true" />
      <h2>Conversations with {agentName}</h2>
      <ul className="rm-convos">
        {conversations.map((session) => <li key={session.id}>
          <button type="button" className={session.id === current ? 'on' : ''} aria-current={session.id === current ? 'true' : undefined} onClick={() => onChoose(session.id)}>
            <span><strong>{session.title?.trim() || 'New conversation'}</strong><small>{shortWhen(session.updatedAt ?? session.createdAt)}</small></span>
            {session.id === current && <Check size={16} aria-hidden="true" />}
          </button>
        </li>)}
      </ul>
      <p className="rm-hint rm-sheet-hint">Start new conversations on the computer.</p>
    </section>
  </div>
}

function ConnectScreen({ notice, onConnect, nouns }: { notice: string | null; onConnect: (code: string, name: string) => Promise<void>; nouns: string }) {
  const [code, setCode] = useState(() => formatCode(codeFromHash(typeof location === 'undefined' ? '' : location.hash)))
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const complete = code.replace('-', '').length === 8
  const submit = async () => {
    if (!complete || busy) return
    setBusy(true)
    try { await onConnect(code, name) } finally { setBusy(false) }
  }
  return <main className="rm-connect">
    <img src={logo} alt="" width="56" height="56" />
    <h1>Connect to your computer</h1>
    <p>On the computer, open Bitbots, go to Settings › Remote and choose “Show pairing code”. Scanning its QR code fills the code in for you.</p>
    {notice && <p className="rm-notice" role="alert">{notice}</p>}
    <label className="rm-field">Pairing code
      <input className="rm-code" inputMode="text" autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX" value={code}
        onChange={(event) => setCode(formatCode(event.target.value))} aria-describedby="rm-code-hint" onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} />
    </label>
    <label className="rm-field">Name this device
      <input autoComplete="off" placeholder="My phone" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} />
    </label>
    <button type="button" className="rm-primary" disabled={!complete || busy} onClick={() => void submit()}>{busy ? 'Connecting…' : 'Connect'}</button>
    <p id="rm-code-hint" className="rm-hint">Codes work once and expire after five minutes. Your computer asks you to approve this device before it can see anything. Your {nouns} stay on your computer.</p>
  </main>
}

function WaitingScreen({ name, onCancel }: { name: string; onCancel: () => void }) {
  return <main className="rm-connect rm-waiting" aria-live="polite">
    <span className="rm-waiting-icon" aria-hidden="true"><Monitor size={26} /></span>
    <h1>Approve on your computer</h1>
    <p>Bitbots on your computer is asking whether to let <b>{name || 'this device'}</b> in. Choose what it may do and approve it there.</p>
    <span className="rm-waiting-dots" aria-hidden="true"><i /><i /><i /></span>
    <button type="button" className="rm-secondary" onClick={onCancel}>Use a different code</button>
  </main>
}

function BotsScreen({ hostName, agents, sessions, runtimes, online, loaded, waiting, nouns, onOpen, onRetry }: {
  hostName: string; agents: Agent[]; sessions: Session[]; runtimes: NonNullable<Snapshot['runtimes']>; online: boolean; loaded: boolean; waiting: Agent[]; nouns: string
  onOpen: (id: string) => void; onRetry: () => void
}) {
  if (!online && !loaded) {
    return <section className="rm-away" aria-live="polite">
      <span className="rm-away-icon"><WifiOff size={24} aria-hidden="true" /></span>
      <h2>Can’t reach {hostName}</h2>
      <p>Your {nouns} are there, but this device can’t reach the computer right now. Check that it is awake and signed in to Tailscale. Nothing you type is queued.</p>
      <div className="rm-away-actions"><button type="button" className="rm-primary" onClick={onRetry}><RefreshCw size={16} aria-hidden="true" />Check again</button></div>
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
    {loaded && agents.length === 0 && <p className="rm-empty">No {nouns} on this computer yet. Create one in Bitbots on the computer and it will appear here.</p>}
  </section>
}

function ChatScreen({ agent, session, permissions, hostName, online, tier, canApprove, quiet, nouns }: {
  agent: Agent; session: Session | null; permissions: PermissionRequest[]; hostName: string; online: boolean; tier: RemoteTier; canApprove: boolean; quiet: boolean; nouns: string
}) {
  const [draft, setDraft] = useState('')
  const [sent, setSent] = useState<Array<{ id: string; text: string }>>([])
  const [problem, setProblem] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const canSend = online && tier !== 'viewer' && !quiet && !!session
  const messages = (session?.messages ?? []).filter((message) => (message.role === 'user' || message.role === 'assistant') && String(message.content ?? '').trim())
  // A sent message shows at once and gives way to the copy the computer saved.
  const saved = new Set(messages.filter((message) => message.role === 'user').map((message) => String(message.content).trim()))
  const local = sent.filter((message) => !saved.has(message.text))
  const pending = permissions.find((item) => item.sessionId === session?.id && item.kind !== 'question') ?? null
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }) }, [messages.length, local.length])
  const send = async () => {
    const text = draft.trim()
    if (!text || !canSend || !session) return
    setDraft('')
    setProblem(null)
    const id = `local-${Date.now()}`
    setSent((current) => [...current, { id, text }])
    try { await rpc('session.prompt', { sessionId: session.id, text }) } catch (reason) {
      setSent((current) => current.filter((message) => message.id !== id))
      setDraft(text)
      setProblem(sendProblem(reason, hostName))
    }
  }
  const placeholder = !online ? 'Not connected' : tier === 'viewer' ? 'View only on this device' : quiet ? 'Quiet hours: reading only' : `Message ${agent.name}`
  return <section className="rm-chat">
    <div className="rm-log" ref={logRef} role="log" aria-live="polite" aria-label={`Conversation with ${agent.name}`}>
      {messages.length === 0 && local.length === 0 && <p className="rm-empty">Nothing here yet. Say hello to {agent.name}.</p>}
      {messages.slice(-30).map((message) => <p key={message.id} className={`rm-msg ${message.role}`}>{plain(String(message.content))}</p>)}
      {local.map((message) => <p key={message.id} className="rm-msg user pending">{message.text}</p>)}
    </div>
    {pending && (canApprove
      ? <div className="rm-approval"><ApprovalCard permission={pending} focusOnMount={false} onReply={async (choice) => { await rpc('permission.reply', { permissionId: pending.id, choice }); return true }} /></div>
      : <div className="rm-approval locked" role="status">
        <ShieldAlert size={18} aria-hidden="true" />
        <div><strong>{agent.name} is asking permission</strong><small>{tier === 'operator' ? `Approving from devices is off on ${hostName}. Approve it on the computer.` : `This device can’t approve. Approve it on ${hostName}, or give this device “Chat and approve” in Settings › Remote.`}</small></div>
      </div>)}
    {problem && <p className="rm-send-problem" role="alert">{problem}</p>}
    <form className="rm-composer" onSubmit={(event) => { event.preventDefault(); void send() }}>
      <textarea rows={1} value={draft} placeholder={placeholder} disabled={!canSend}
        aria-label={`Message ${agent.name}`} onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
      <button type="submit" className="rm-send" aria-label="Send" disabled={!canSend || !draft.trim()}><Send size={17} aria-hidden="true" /></button>
    </form>
    <p className="rm-tier">{TIER_WORD[tier]} · a message here runs on {hostName}, within its approval mode. Your {nouns} never leave it.</p>
  </section>
}

function DeviceScreen({ me, noun, onLogout }: { me: RemoteMe; noun: string; onLogout: () => void }) {
  return <section className="rm-device">
    <h2>{me.device.name}</h2>
    <dl className="rm-facts">
      <div><dt>Connected to</dt><dd>{me.host.name}</dd></div>
      <div><dt>This device may</dt><dd>{TIER_WORD[me.device.tier]}</dd></div>
      <div><dt>Approvals from here</dt><dd>{me.device.tier === 'operator' && me.approvalsFromRemote ? 'Allowed' : 'On the computer only'}</dd></div>
      <div><dt>Connection</dt><dd>Your private Tailscale network</dd></div>
    </dl>
    <div className="rm-card">
      <span className="rm-card-icon"><Download size={18} aria-hidden="true" /></span>
      <div><strong>Install Bitbots on this device</strong><small>On iPhone choose Share, then “Add to Home Screen”. On Android choose “Install app” in the browser menu. It opens full screen like an app.</small></div>
    </div>
    <p className="rm-hint rm-device-hint">What this device may do is set on the computer, in Settings › Remote. A {noun} that needs approval waits there unless this device may approve.</p>
    <button type="button" className="rm-danger" onClick={onLogout}><LogOut size={16} aria-hidden="true" />Sign out of {me.host.name}</button>
  </section>
}
