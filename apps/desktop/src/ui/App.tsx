import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { emit, listen } from '@tauri-apps/api/event'
import {
  Activity, ArrowDownToLine, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronUp, CircleHelp, Clock3, Code2, Copy, FileText, FolderOpen,
  Gauge, GitBranch, Home, Laptop, LoaderCircle, MessageCircle, MessageSquarePlus, MoreHorizontal, PanelRight, Paperclip, Play, Plus,
  RefreshCw, Search, Settings2, ShieldAlert, Square, Terminal, Volume2, VolumeX, X,
} from 'lucide-react'
import { BlobCanvas, type BlobMood } from '../blob/BlobCanvas'
import { disposeCompanionAudio, playCompanionCue, setCompanionSoundsEnabled, unlockCompanionAudioFromGesture } from '../blob/soundCues'
import { CompanionFsm, type CompanionMode } from '../blob/companionFsm'
import { buildConversationItems, type ConversationItem } from './conversation'
import { deriveCompanionStatus } from './companionStatus'
import { moneyMinor, records, tokenValue, usageTokenBuckets, valuationLabel } from './usagePresentation'
import { isPendingPermissionLive, nextPermissionDeadline, selectPendingPermission } from './permissionSelection'
import { PermissionChoiceButton } from './PermissionChoiceButton'
import bloblexLogo from '../assets/bloblex-128.png'
import { sessionsForPauseRequest } from './trayActions'
import { budgetValue, findApplicableBudget } from './budgetPresentation'
import { applyEvent, formatUnknownSafe, isPermissionReplyAllowed, labelize, providerColor, type ConnectionState, type DaemonEvent, type PermissionRequest, type Runtime, type Session, type Snapshot } from '../types'
import { companionMonitorOptions, currentCompanionMonitor, ensureDaemon, fetchSnapshot, getActiveRuntime, getActiveSession, inDesktop, inspectLocalFile, listenForActiveRuntime, listenForActiveSession, listenForDaemonConnection, listenForDaemonEvents, listenForOpenSettings, openInEditor, openProjectFolder, quitBloblex, refreshTrayMenu, resolveProjectFile, revealInExplorer, rpc, selectLocalFile, setActiveRuntime, setActiveSession, setCloseToTray, setCompanionMode, setCompanionMonitor, setCompanionVisibility, showMainSettings, showMainWindow, startDaemonEventStream } from '../tauri'

type ContextTab = 'Details' | 'Runtime' | 'Files'
export function App() {
  const companion = new URLSearchParams(location.search).has('companion')
  useEffect(() => {
    document.documentElement.classList.toggle('companion-surface', companion)
    return () => document.documentElement.classList.remove('companion-surface')
  }, [companion])
  useEffect(() => () => { if (companion) disposeCompanionAudio() }, [companion])
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [connection, setConnection] = useState<ConnectionState>(inDesktop ? 'connecting' : 'disconnected')
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [selectedRuntimeId, setSelectedRuntimeId] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [tab, setTab] = useState<ContextTab>('Details')
  const [composer, setComposer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [usageSheet, setUsageSheet] = useState(false)
  const [usagePeriod, setUsagePeriod] = useState<'today' | 'month'>('today')
  const [settingsSheet, setSettingsSheet] = useState(false)
  const [settingsInitialPage, setSettingsInitialPage] = useState<'General' | 'Runtimes'>('General')
  const [diffViewer, setDiffViewer] = useState<{ path: string; content: string } | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [runtimeMenu, setRuntimeMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [usageSummary, setUsageSummary] = useState<Record<string, unknown> | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [budgetAlertActive, setBudgetAlertActive] = useState(false)
  const [permissionClock, setPermissionClock] = useState(() => Date.now())
  const [runtimeExplainerDismissed, setRuntimeExplainerDismissed] = useState(() => localStorage.getItem('bloblex.runtimeExplainer.dismissed') === '1')
  const [inspectorOpen, setInspectorOpen] = useState(() => localStorage.getItem('bloblex.inspector.open') === '1')
  const [search, setSearch] = useState('')
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const runtimeRowFocus = useRef<HTMLButtonElement | null>(null)
  const messageListRef = useRef<HTMLElement>(null)
  const stickToBottom = useRef(true)
  const queuedEvents = useRef<DaemonEvent[]>([])
  const hydrating = useRef(true)
  const refreshingRef = useRef(false)
  const refreshAgain = useRef(false)

  const runtimes = snapshot?.runtimes ?? []
  const sessions = snapshot?.sessions ?? []
  const selectedRuntime = runtimes.find((runtime) => runtime.id === selectedRuntimeId) ?? runtimes[0] ?? null
  const selectedSession = sessions.find((session) => session.id === selectedSessionId && (!selectedRuntime || session.runtimeId === selectedRuntime.id))
    ?? sessions.find((session) => session.id === activeSessionId && (!selectedRuntime || session.runtimeId === selectedRuntime.id))
    ?? sessions.filter((session) => session.runtimeId === selectedRuntime?.id).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0]
    ?? null
  const sessionMessages = selectedSession?.messages ?? selectedSession?.turns?.flatMap((turn) => Array.isArray(turn.messages) ? turn.messages : []) ?? selectedSession?.events ?? []
  const conversationItems = selectedSession ? buildConversationItems(selectedSession) : []
  const activePermission = selectPendingPermission(snapshot?.permissions ?? [], selectedSession?.id, activeSessionId, permissionClock)
  const agentName = selectedRuntime ? labelize(selectedRuntime.provider) : 'No runtime selected'
  const accent = providerColor(selectedRuntime?.provider)
  const companionPermission = activePermission ?? undefined
  const companionSessionRecord = sessions.find((session) => session.id === companionPermission?.sessionId)
    ?? sessions.find((session) => session.id === activeSessionId && session.runtimeId === selectedRuntimeId)
    ?? selectedSession
  const companionSession = companionSessionRecord
  const companionRuntime = runtimes.find((runtime) => runtime.id === companionSession?.runtimeId) ?? runtimes.find((runtime) => runtime.id === selectedRuntimeId) ?? selectedRuntime
  const alertSessionId = typeof snapshot?.latestBudgetAlert?.sessionId === 'string' ? snapshot.latestBudgetAlert.sessionId : null
  const budgetWarningFor = (item: Session | null) => budgetAlertActive && (!alertSessionId || alertSessionId === item?.id)
  const companionStatus = deriveCompanionStatus({ connected: connection === 'connected', runtime: companionRuntime, session: companionSession, permissionPending: !!companionPermission, budgetWarning: budgetWarningFor(companionSession) })
  const previousCueMood = useRef<string | null>(null)
  const previousPermissionCue = useRef<string | null>(null)
  const selectedBudget = findApplicableBudget(snapshot?.budgets, selectedRuntime, selectedSession, selectedRuntime?.hostId)
  const currentProjectName = selectedSession?.projectPath?.split(/[\\/]/).filter(Boolean).pop()

  useEffect(() => {
    if (!companion) return
    const previous = previousCueMood.current
    if (previous && previous !== companionStatus.mood && (companionStatus.mood === 'success' || companionStatus.mood === 'error')) {
      playCompanionCue(companionStatus.mood === 'success' ? 'completion' : 'error')
    }
    previousCueMood.current = companionStatus.mood
  }, [companion, companionStatus.mood])

  useEffect(() => {
    if (!companion) return
    if (companionPermission?.id && companionPermission.id !== previousPermissionCue.current) playCompanionCue('approval')
    previousPermissionCue.current = companionPermission?.id ?? null
  }, [companion, companionPermission?.id])

  const refresh = useCallback(async () => {
    if (!inDesktop) return
    if (refreshingRef.current) { refreshAgain.current = true; return }
    refreshingRef.current = true
    hydrating.current = true
    setRefreshing(true)
    try {
      await ensureDaemon()
      let next = await fetchSnapshot()
      const replay = await rpc<{ events?: DaemonEvent[]; replayAvailable?: boolean }>('events.replay', { afterSequence: next.sequence ?? 0 })
      if (replay.replayAvailable === false) next = await fetchSnapshot()
      await startDaemonEventStream()
      const queued = [...(replay.replayAvailable === false ? [] : replay.events ?? []), ...queuedEvents.current]
        .filter((event) => (event.sequence ?? 0) > (next.sequence ?? 0))
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
      queuedEvents.current = []
      hydrating.current = false
      setSnapshot(queued.reduce((state, event) => applyEvent(state, event), next))
      setConnection('connected')
      setError(null)
    } catch (reason) {
      hydrating.current = false
      setConnection('disconnected')
      setError(messageOf(reason))
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
      if (refreshAgain.current) {
        refreshAgain.current = false
        window.setTimeout(() => void refresh(), 0)
      }
    }
  }, [])

  useEffect(() => {
    if (!activePermission?.sessionId) return
    const target = sessions.find((item) => item.id === activePermission.sessionId)
    if (!target) return
    if (target.runtimeId !== selectedRuntimeId) setSelectedRuntimeId(target.runtimeId)
    if (target.id !== selectedSessionId) setSelectedSessionId(target.id)
    if (target.id !== activeSessionId) {
      setActiveSessionId(target.id)
      void setActiveSession(target.id)
      void setActiveRuntime(target.runtimeId)
    }
  }, [activePermission?.id, activePermission?.sessionId, sessions, selectedRuntimeId, selectedSessionId, activeSessionId])

  useEffect(() => {
    const deadline = nextPermissionDeadline(snapshot?.permissions ?? [], permissionClock)
    if (deadline === null) return
    const timer = window.setTimeout(() => setPermissionClock(Date.now()), Math.min(Math.max(1, deadline - permissionClock + 1), 2_147_000_000))
    return () => window.clearTimeout(timer)
  }, [snapshot?.permissions, permissionClock])

  useEffect(() => {
    if (!snapshot?.latestBudgetAlert) { setBudgetAlertActive(false); return }
    setBudgetAlertActive(true)
    const timer = window.setTimeout(() => setBudgetAlertActive(false), 4200)
    return () => window.clearTimeout(timer)
  }, [snapshot?.latestBudgetAlert])

  useLayoutEffect(() => {
    const element = messageListRef.current
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight
  }, [selectedSession?.id, sessionMessages, selectedSession?.tools, selectedSession?.files, selectedSession?.turns])

  useEffect(() => {
    if (!inDesktop) return
    let unlistenEvents: (() => void) | undefined
    let unlistenConnection: (() => void) | undefined
    let cancelled = false
    void listenForDaemonEvents((event) => {
      if (event.type === 'replay.gap') {
        queuedEvents.current = []
        hydrating.current = true
        setConnection('disconnected')
        if (refreshingRef.current) refreshAgain.current = true
        else void refresh()
      } else if (hydrating.current) queuedEvents.current.push(event)
      else setSnapshot((current) => current ? applyEvent(current, event) : current)
    }).then((stop) => { if (cancelled) stop(); else unlistenEvents = stop })
    void listenForDaemonConnection((connected) => {
      if (connected && hydrating.current) return
      setConnection(connected ? 'connected' : 'disconnected')
      if (connected) setError(null)
    }).then((stop) => { if (cancelled) stop(); else unlistenConnection = stop })
    return () => { cancelled = true; unlistenEvents?.(); unlistenConnection?.() }
  }, [])

  useEffect(() => {
    if (!inDesktop || companion) return
    let cancelled = false
    let unlistenPause: (() => void) | undefined
    let unlistenNotice: (() => void) | undefined
    void listen<string>('bloblex-tray-notice', (event) => setError(event.payload)).then((stop) => { if (cancelled) stop(); else unlistenNotice = stop })
    void listen('bloblex-pause-all-requested', () => {
      if (!window.confirm('Pause all agents? Bloblex will send a cancellation request for every active session. A cancelled turn may not be resumable.')) return
      void (async () => {
        try {
          const response = await rpc<{ sessions?: Session[] }>('session.list')
          const targets = sessionsForPauseRequest(response.sessions ?? [])
          if (!targets.length) { setError('There are no active sessions to cancel.'); return }
          const results = await Promise.all(targets.map(async (session) => {
            try { await rpc('session.cancel', { sessionId: session.id }); return { session, error: null } }
            catch (reason) { return { session, error: messageOf(reason) } }
          }))
          await refresh()
          const failures = results.filter((result) => result.error)
          void refreshTrayMenu().catch(() => undefined)
          setError(failures.length
            ? `Cancellation requested for ${results.length - failures.length} of ${results.length} active sessions. ${failures.map(({ session, error: failure }) => `${session.title || session.id}: ${failure}`).join(' · ')}`
            : `Cancellation requested for ${results.length} active sessions. Provider confirmation may take a moment.`)
        } catch (reason) { setError(`Could not list active sessions: ${messageOf(reason)}`) }
      })()
    }).then((stop) => { if (cancelled) stop(); else unlistenPause = stop })
    return () => { cancelled = true; unlistenPause?.(); unlistenNotice?.() }
  }, [companion, refresh])

  useEffect(() => {
    if (!inDesktop || connection !== 'disconnected') return
    const timer = window.setInterval(() => { if (!refreshing) void refresh() }, 3000)
    return () => window.clearInterval(timer)
  }, [connection, refresh, refreshing])

  useEffect(() => {
    if (!inDesktop) return
    let mounted = true
    const connect = async () => {
      if (refreshingRef.current) {
        window.setTimeout(() => { if (mounted) void connect() }, 40)
        return
      }
      refreshingRef.current = true
      hydrating.current = true
      try {
        await ensureDaemon()
        let initial = await fetchSnapshot()
        const replay = await rpc<{ events?: DaemonEvent[]; replayAvailable?: boolean }>('events.replay', { afterSequence: initial.sequence ?? 0 })
        if (replay.replayAvailable === false) initial = await fetchSnapshot()
        if (!mounted) return
        const storedActive = await getActiveSession()
        const storedRuntime = await getActiveRuntime()
        setActiveSessionId(storedActive)
        setSelectedRuntimeId(storedRuntime)
        setSnapshot(initial)
        setConnection('connected')
        await startDaemonEventStream()
        const missedWhileSubscribing = [...(replay.replayAvailable === false ? [] : replay.events ?? []), ...queuedEvents.current]
          .filter((event) => (event.sequence ?? 0) > (initial.sequence ?? 0))
          .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
        queuedEvents.current = []
        hydrating.current = false
        setSnapshot((current) => missedWhileSubscribing.reduce((state, event) => applyEvent(state ?? initial, event), current ?? initial))
      } catch (reason) {
        hydrating.current = false
        if (mounted) {
          setConnection('disconnected')
          setError(messageOf(reason))
        }
      } finally {
        refreshingRef.current = false
        if (refreshAgain.current) { refreshAgain.current = false; window.setTimeout(() => void refresh(), 0) }
      }
    }
    void connect()
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    if (!inDesktop) return
    let unlisten: (() => void) | undefined
    let cancelled = false
    void listenForActiveRuntime((runtimeId) => setSelectedRuntimeId(runtimeId)).then((stop) => { if (cancelled) stop(); else unlisten = stop })
    return () => { cancelled = true; unlisten?.() }
  }, [])

  useEffect(() => {
    if (!inDesktop) return
    let unlisten: (() => void) | undefined
    let cancelled = false
    void listenForOpenSettings(() => setSettingsSheet(true)).then((stop) => { if (cancelled) stop(); else unlisten = stop })
    return () => { cancelled = true; unlisten?.() }
  }, [])

  useEffect(() => {
    if (selectedRuntime && selectedRuntime.id !== selectedRuntimeId) setSelectedRuntimeId(selectedRuntime.id)
  }, [selectedRuntime, selectedRuntimeId])

  useEffect(() => {
    if (selectedRuntime) void setActiveRuntime(selectedRuntime.id)
  }, [selectedRuntime?.id])

  useEffect(() => {
    if (!inDesktop) return
    let unlisten: (() => void) | undefined
    let cancelled = false
    void listenForActiveSession((sessionId) => { setActiveSessionId(sessionId); setSelectedSessionId(sessionId) }).then((stop) => { if (cancelled) stop(); else unlisten = stop })
    return () => { cancelled = true; unlisten?.() }
  }, [])

  useEffect(() => {
    if (selectedSession && selectedSession.runtimeId !== selectedRuntimeId) setSelectedRuntimeId(selectedSession.runtimeId)
    if (selectedSession && selectedSession.id !== activeSessionId) {
      setActiveSessionId(selectedSession.id)
      void setActiveSession(selectedSession.id)
    } else if (!selectedSession && selectedSessionId === null && activeSessionId !== null) {
      setActiveSessionId(null)
      void setActiveSession(null)
    }
  }, [selectedSession, selectedRuntimeId, activeSessionId, selectedSessionId])

  const doRpc = useCallback(async <T,>(method: string, params: Record<string, unknown> = {}) => {
    setBusy(true)
    setError(null)
    try {
      const result = await rpc<T>(method, params)
      return result
    } catch (reason) {
      setError(messageOf(reason))
      throw reason
    } finally {
      setBusy(false)
    }
  }, [])

  const newSession = async (runtimeId?: string) => {
    const targetRuntime = runtimeId ? runtimes.find((item) => item.id === runtimeId) : selectedRuntime
    if (!targetRuntime) return
    try {
      const projectPath = await openProjectFolder()
      if (!projectPath) return
      const result = await doRpc<Session | { session: Session }>('session.new', { runtimeId: targetRuntime.id, projectPath })
      const session = (result as { session?: Session }).session ?? result as Session
      setSelectedSessionId(session.id)
      void refreshTrayMenu().catch(() => undefined)
      await refresh()
    } catch { /* The actionable error is shown inline. */ }
  }

  const sendPrompt = async () => {
    const text = composer.trim()
    if (!text || !selectedSession || busy || selectedSession.state === 'waiting_permission') return
    try {
      await doRpc('session.prompt', { sessionId: selectedSession.id, text })
      setComposer('')
      await refresh()
    } catch { /* The actionable error is shown inline. */ }
  }

  const cancelTurn = async () => {
    if (!selectedSession) return
    try { await doRpc('session.cancel', { sessionId: selectedSession.id }); void refreshTrayMenu().catch(() => undefined); await refresh() } catch { /* inline */ }
  }

  const resumeSession = async () => {
    if (!selectedSession?.resumable || busy) return
    try { await doRpc('session.resume', { sessionId: selectedSession.id }); void refreshTrayMenu().catch(() => undefined); await refresh() } catch { /* inline */ }
  }

  const answerPermission = async (permission: PermissionRequest, choice: string) => {
    const now = Date.now()
    if (!isPendingPermissionLive(permission, now) || !isPermissionReplyAllowed(permission, choice)) {
      setPermissionClock(now)
      await refresh()
      setError('This approval expired or is no longer pending. No reply was sent. Check the refreshed request state before continuing.')
      return
    }
    try { await doRpc('permission.reply', { permissionId: permission.id, choice }); await refresh() } catch (reason) {
      await refresh()
      setError(messageOf(reason))
    }
  }

  const refreshRuntimes = async () => {
    try { await doRpc('runtime.refresh'); await refresh() } catch { /* inline */ }
  }

  const showUsage = async (period: 'today' | 'month' = usagePeriod) => {
    setUsageSheet(true)
    setUsagePeriod(period)
    const today = new Date()
    const from = period === 'today' ? new Date(today.getFullYear(), today.getMonth(), today.getDate()) : new Date(today.getFullYear(), today.getMonth(), 1)
    try {
      const summary = await doRpc<Record<string, unknown>>('usage.summary', { from: from.toISOString(), to: new Date().toISOString() })
      setUsageSummary(summary)
    } catch { setUsageSummary(null) }
  }

  if (companion) {
    return <Companion runtime={companionRuntime} runtimes={runtimes} session={companionSession} usage={snapshot?.usageSummary} connected={connection === 'connected'} appError={error} activityLabel={companionStatus.label} budgetWarning={budgetWarningFor(companionSession)} permission={companionPermission} onReply={answerPermission} onNewSession={newSession} onOpenMain={() => void showMainWindow(companionSession?.id)} onOpenSettings={() => void showMainSettings(companionSession?.id)} onSendPrompt={(sessionId, text) => doRpc('session.prompt', { sessionId, text }).then(() => { void refreshTrayMenu().catch(() => undefined); return refresh() })} onCancelTurn={(sessionId) => doRpc('session.cancel', { sessionId }).then(() => { void refreshTrayMenu().catch(() => undefined); return refresh() })} onSelectRuntime={(runtimeId) => { const next = sessions.filter((item) => item.runtimeId === runtimeId).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0] ?? null; setSelectedRuntimeId(runtimeId); setSelectedSessionId(next?.id ?? null); void setActiveRuntime(runtimeId); void setActiveSession(next?.id ?? null) }} />
  }

  const query = search.trim().toLowerCase()
  const runtimeRows = runtimes.map((runtime) => {
    const runtimeSessions = sessions.filter((session) => session.runtimeId === runtime.id).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    return { runtime, latest: runtimeSessions[0] ?? null, sessions: runtimeSessions }
  }).filter(({ runtime, sessions: owned }) => !query || labelize(runtime.provider).toLowerCase().includes(query) || owned.some((session) => formatUnknownSafe(session.title, session.projectPath ?? '').toLowerCase().includes(query)))
  const selectedMood = deriveCompanionStatus({ connected: connection === 'connected', runtime: selectedRuntime, session: selectedSession, budgetWarning: budgetWarningFor(selectedSession), composing: !!composer.trim() }).mood
  const sessionBusy = ['working', 'starting', 'waiting_permission'].includes(selectedSession?.state ?? '')
  const lastAgentIndex = conversationItems.reduce((last, item, index) => item.kind === 'message' && !isUserMessage(item.value) ? index : last, -1)
  const selectRuntime = (runtime: Runtime, latest: Session | null) => { setSelectedRuntimeId(runtime.id); void setActiveRuntime(runtime.id); setSelectedSessionId(latest?.id ?? null); setActiveSessionId(latest?.id ?? null); void setActiveSession(latest?.id ?? null) }
  const openRuntimeMenu = (runtimeId: string, element: HTMLButtonElement, x: number, y: number) => { runtimeRowFocus.current = element; setRuntimeMenu({ id: runtimeId, x, y }) }
  const toggleInspector = () => setInspectorOpen((open) => { localStorage.setItem('bloblex.inspector.open', open ? '0' : '1'); return !open })

  return (
    <main className={`app-shell ${inspectorOpen ? 'inspector-open' : ''}`} style={{ '--agent-accent': accent } as React.CSSProperties}>
      <aside className="sidebar" aria-label="Agents">
        <div className="sidebar-top">
          <div className="brand-lockup"><img className="brand-logo" src={bloblexLogo} alt="Bloblex logo" /><strong>Bloblex</strong></div>
          <button className="icon-button" title="New session" aria-label="New session" disabled={!selectedRuntime || busy || connection !== 'connected'} onClick={() => void newSession()}><Plus size={18} /></button>
        </div>
        <label className="sidebar-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search" aria-label="Search agents and conversations" /></label>
        <nav className="bot-list runtime-list">
          {runtimeRows.map(({ runtime, latest }) => {
            const selected = runtime.id === selectedRuntime?.id
            const runtimeMood = deriveCompanionStatus({ connected: connection === 'connected', runtime, session: latest }).mood
            const preview = latestPreview(latest) ?? (connection === 'connected' ? labelize(runtime.status, 'Ready') : 'Daemon disconnected')
            return <button className={`bot-row runtime-row ${selected ? 'selected' : ''}`} key={runtime.id} aria-current={selected ? 'true' : undefined}
              onContextMenu={(event) => { event.preventDefault(); openRuntimeMenu(runtime.id, event.currentTarget, event.clientX, event.clientY) }}
              onKeyDown={(event) => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openRuntimeMenu(runtime.id, event.currentTarget, rect.left + 28, rect.bottom) } }}
              onClick={() => selectRuntime(runtime, latest)}>
              <BlobCanvas color={providerColor(runtime.provider)} size={42} mood={runtimeMood} label={labelize(runtime.provider)} />
              <span className="bot-row-copy">
                <span className="bot-row-top"><strong>{labelize(runtime.provider)}</strong>{latest?.updatedAt && <time>{shortTime(latest.updatedAt)}</time>}</span>
                <span className="bot-row-preview">{preview}</span>
              </span>
            </button>
          })}
          {connection === 'connected' && runtimes.length === 0 && <div className="rail-empty">No coding CLIs detected yet.<button onClick={() => void refreshRuntimes()}>Scan again</button></div>}
          {connection === 'connected' && runtimes.length > 0 && runtimeRows.length === 0 && <div className="rail-empty">Nothing matches “{search}”.</div>}
          {connection !== 'connected' && <div className="rail-empty">Connect to your local runtime to see installed agents.</div>}
        </nav>
        {runtimeMenu && <RuntimeContextMenu runtime={runtimes.find((item) => item.id === runtimeMenu.id) ?? null} session={sessions.filter((item) => item.runtimeId === runtimeMenu.id).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0] ?? null} position={runtimeMenu} onClose={() => { setRuntimeMenu(null); window.setTimeout(() => runtimeRowFocus.current?.focus(), 0) }} onNew={() => { const id = runtimeMenu.id; setSelectedRuntimeId(id); setRuntimeMenu(null); void setActiveRuntime(id); void newSession(id) }} onResume={(target) => { setRuntimeMenu(null); setSelectedRuntimeId(target.runtimeId); setSelectedSessionId(target.id); void setActiveSession(target.id); void doRpc('session.resume', { sessionId: target.id }).then(() => { void refreshTrayMenu().catch(() => undefined); return refresh() }).catch(() => undefined) }} onSettings={() => { setSelectedRuntimeId(runtimeMenu.id); setSettingsInitialPage('Runtimes'); setRuntimeMenu(null); setSettingsSheet(true) }} onStop={(target) => { setRuntimeMenu(null); void doRpc('session.cancel', { sessionId: target.id }).then(() => { void refreshTrayMenu().catch(() => undefined); return refresh() }).catch(() => undefined) }} />}

        <div className="sidebar-foot">
          <button className="sidebar-link" onClick={() => void showUsage()} disabled={connection !== 'connected'}><Gauge size={15} />Usage</button>
          <button className="sidebar-link" onClick={() => void refreshRuntimes()} disabled={connection !== 'connected' || refreshing}><RefreshCw size={15} className={refreshing ? 'spinning' : ''} />Find agents</button>
          <div className="sidebar-profile">
            <span className={`presence-ring ${connection}`}><i /></span>
            <span className="sidebar-profile-copy"><strong>{connection === 'connected' ? 'Local runtime' : connection === 'connecting' ? 'Connecting…' : 'Runtime offline'}</strong><small>{connection === 'connected' ? 'Private to this device' : connection === 'connecting' ? 'Checking daemon' : 'No agent state available'}</small></span>
            <button className="icon-button settings-trigger" title="Settings" aria-label="Settings" onClick={() => { setSettingsInitialPage('General'); setSettingsSheet(true) }}><Settings2 size={16} /></button>
          </div>
        </div>
      </aside>

      <section className="conversation-pane">
        <header className="chat-header">
          <div className="chat-title">
            {selectedRuntime ? <BlobCanvas color={accent} size={28} mood={selectedMood} label={agentName} /> : <span className="agent-placeholder"><Code2 size={15} /></span>}
            <strong>{agentName}</strong>
            {selectedRuntime && <i className={`status-dot ${connection === 'connected' ? statusClass(selectedRuntime.status) : 'muted'}`} />}
            {sessions.length > 0 && selectedRuntime && <div className="session-switcher-wrap"><select aria-label="Current conversation" value={selectedSession?.id ?? ''} onChange={(event) => setSelectedSessionId(event.target.value)}><option value="" disabled>Select a conversation</option>{sessions.filter((session) => session.runtimeId === selectedRuntime.id).map((session) => <option value={session.id} key={session.id}>{formatUnknownSafe(session.title, session.projectPath?.split(/[\\/]/).pop() ?? 'New session')}</option>)}</select><ChevronDown size={13} /></div>}
          </div>
          <div className="header-actions">
            <button className="pill-button" disabled={!selectedRuntime || busy || connection !== 'connected'} onClick={() => void newSession()}><Plus size={13} />Session</button>
            {selectedRuntime && <button className="model-pill" title="Runtime settings" onClick={() => { setSettingsInitialPage('Runtimes'); setSettingsSheet(true) }}><span className="model-pill-mark" style={{ background: accent }} />{labelize(selectedRuntime.provider)}<span className="model-pill-model">{selectedSession?.model ?? 'CLI default'}</span><ChevronDown size={13} /></button>}
            {selectedSession?.resumable && !sessionBusy && <button className="icon-button" title="Resume conversation" aria-label="Resume conversation" disabled={busy || connection !== 'connected'} onClick={() => void resumeSession()}><Play size={15} /></button>}
            <button className={`icon-button ${inspectorOpen ? 'active' : ''}`} title="Toggle details" aria-label="Toggle context pane" aria-pressed={inspectorOpen} onClick={toggleInspector}><PanelRight size={16} /></button>
            <div className="more-menu-wrap" onKeyDown={(event) => { if (event.key === 'Escape') setMoreOpen(false) }}>
              <button className="icon-button" title="More options" aria-label="More options" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}><MoreHorizontal size={17} /></button>
              {moreOpen && <div className="more-menu" role="menu"><button role="menuitem" disabled={!selectedRuntime || busy} onClick={() => { setMoreOpen(false); void newSession() }}><MessageSquarePlus size={15} />New session</button><button role="menuitem" disabled={refreshing} onClick={() => { setMoreOpen(false); void refresh() }}><RefreshCw size={15} />Refresh state</button><button role="menuitem" disabled={!selectedSession} onClick={() => { setMoreOpen(false); void showUsage() }}><Gauge size={15} />Usage details</button><span className="more-menu-separator" /><button role="menuitem" className="danger-menu-item" onClick={() => void quitBloblex()}><X size={15} />Quit Bloblex</button></div>}
            </div>
          </div>
        </header>

        {error && <div className="inline-error" role="alert"><ShieldAlert size={16} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}><X size={15} /></button></div>}

        {selectedSession && !runtimeExplainerDismissed && <RuntimeExplainer onDismiss={() => { localStorage.setItem('bloblex.runtimeExplainer.dismissed', '1'); setRuntimeExplainerDismissed(true) }} />}

        {!selectedSession ? <>{activePermission && <PermissionCard permission={activePermission} onReply={(choice) => void answerPermission(activePermission, choice)} />}<EmptyConversation connected={connection === 'connected'} hasRuntime={!!selectedRuntime} accent={accent} mood={selectedMood} agentName={agentName} onNewSession={() => void newSession()} onRefresh={() => void refreshRuntimes()} /></> : <>
          <section ref={messageListRef} className="message-list" aria-label="Conversation" onScroll={(event) => { const node = event.currentTarget; stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72 }}>
            <div className="chat-column">
              <div className="conversation-meta"><span><FolderOpen size={13} />{selectedSession.projectPath ?? 'Project path unavailable'}</span><span className="meta-divider" /><span><Clock3 size={13} />{labelize(selectedSession.state, 'Unknown state')}</span></div>
              {conversationItems.length === 0 ? <div className="session-first-state"><BlobCanvas color={accent} size={112} mood={selectedMood} label={agentName} /><h2>Ready when you are.</h2><p>This conversation is connected to <code>{selectedSession.projectPath ?? 'a project'}</code>. Ask {agentName} to explore the code or make a change.</p><div className="session-facts"><span><GitBranch size={13} />{selectedRuntime?.version ?? 'CLI version unknown'}</span><span><Laptop size={13} />{labelize(selectedSession.state, 'Idle')}</span></div></div> : conversationItems.map((item, index) => item.kind === 'message'
                ? <MessageItem key={item.id} message={item.value!} accent={accent} agentName={agentName} showAvatar={!isUserMessage(item.value) && (index === 0 || conversationItems[index - 1].kind !== 'message' || isUserMessage(conversationItems[index - 1].value))} mood={index === lastAgentIndex ? selectedMood : 'idle'} />
                : <ActivityItem key={item.id} item={item} />)}
              {activePermission && <PermissionCard permission={activePermission} onReply={(choice) => void answerPermission(activePermission, choice)} />}
              {selectedSession.state === 'working' && <div className="working-indicator"><BlobCanvas color={accent} size={28} mood="working" label={`${agentName} working`} /><span className="typing"><i /><i /><i /></span>{agentName} is working</div>}
            </div>
          </section>
          <div className="composer-wrap">
            <div className="composer-box">
              <button className="composer-tool" aria-label="Attach files" title="File attachments are not available from this runtime yet" disabled><Plus size={18} /></button>
              <textarea ref={composerRef} value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendPrompt() } }} placeholder={`Message ${agentName}`} aria-label={`Message ${agentName}`} disabled={connection !== 'connected' || busy || selectedSession.state === 'waiting_permission'} rows={1} />
              <button className={`send-button ${['working', 'waiting_permission'].includes(selectedSession.state ?? '') ? 'cancel' : ''}`} onClick={['working', 'waiting_permission'].includes(selectedSession.state ?? '') ? () => void cancelTurn() : () => void sendPrompt()} disabled={busy || (!composer.trim() && !['working', 'waiting_permission'].includes(selectedSession.state ?? ''))} aria-label={['working', 'waiting_permission'].includes(selectedSession.state ?? '') ? 'Cancel turn' : 'Send message'}>{busy ? <LoaderCircle size={16} className="spinning" /> : ['working', 'waiting_permission'].includes(selectedSession.state ?? '') ? <Square size={12} fill="currentColor" /> : <ArrowUp size={17} />}</button>
            </div>
            <div className="composer-note">{currentProjectName ? <><FolderOpen size={11} />{currentProjectName}<span>·</span></> : null}Agent actions run on your device. You approve what matters.</div>
          </div>
        </>}
      </section>

      <aside className="context-pane" aria-label="Conversation details" aria-hidden={!inspectorOpen} inert={!inspectorOpen}>
        <div className="context-tabs" role="tablist" aria-label="Conversation context">{(['Details', 'Runtime', 'Files'] as ContextTab[]).map((name, index, tabs) => <button key={name} type="button" id={`context-tab-${name.toLowerCase()}`} role="tab" aria-controls="context-panel" aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} className={tab === name ? 'active' : ''} onClick={() => setTab(name)} onKeyDown={(event) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const targetIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length; const target = tabs[targetIndex]; setTab(target); document.getElementById(`context-tab-${target.toLowerCase()}`)?.focus() }}>{name}</button>)}</div>
        <div id="context-panel" role="tabpanel" aria-labelledby={`context-tab-${tab.toLowerCase()}`} tabIndex={0} className="context-tab-panel">
          {tab === 'Details' && <DetailsPane runtime={selectedRuntime} session={selectedSession} connected={connection === 'connected'} budgetWarning={budgetWarningFor(selectedSession)} budget={selectedBudget} usage={snapshot?.usageSummary ?? null} onUsage={() => void showUsage()} />}
          {tab === 'Runtime' && <RuntimePane runtime={selectedRuntime} connected={connection === 'connected'} onRefresh={() => void refreshRuntimes()} refreshing={refreshing} />}
          {tab === 'Files' && <FilesPane session={selectedSession} onOpen={(path) => void openInEditor(path, selectedSession?.projectPath).catch((reason) => setError(messageOf(reason)))} onReveal={(path) => void revealInExplorer(path, selectedSession?.projectPath).catch((reason) => setError(messageOf(reason)))} onCopy={async (path) => { try { await navigator.clipboard.writeText(await resolveProjectFile(path, selectedSession?.projectPath)) } catch (reason) { setError(messageOf(reason)) } }} onDiff={(path, content) => setDiffViewer({ path, content })} />}
        </div>
        <div className="context-footer"><span>Bloblex for Windows</span><span>Local mode</span></div>
      </aside>

      {usageSheet && <UsageSheet summary={usageSummary} period={usagePeriod} loading={busy && usageSummary === null} onPeriodChange={(period) => { setUsageSummary(null); void showUsage(period) }} onClose={() => setUsageSheet(false)} />}
      {settingsSheet && <SettingsSheet snapshot={snapshot} runtime={selectedRuntime} session={selectedSession} initialPage={settingsInitialPage} onClose={() => setSettingsSheet(false)} onRefresh={refreshRuntimes} onError={setError} />}
      {diffViewer && <DiffViewer path={diffViewer.path} content={diffViewer.content} onClose={() => setDiffViewer(null)} />}
    </main>
  )
}

function EmptyConversation({ connected, hasRuntime, accent, mood, agentName, onNewSession, onRefresh }: { connected: boolean; hasRuntime: boolean; accent: string; mood: BlobMood; agentName: string; onNewSession: () => void; onRefresh: () => void }) {
  return <div className="empty-conversation"><div className="empty-art">{hasRuntime ? <BlobCanvas color={accent} size={128} mood={connected ? mood : 'offline'} label={agentName} /> : <BlobCanvas color="#e6e9ee" size={128} mood={connected ? 'idle' : 'offline'} label="Bloblex" />}</div><h1>{!connected ? 'Connect to your local runtime' : hasRuntime ? `Start a conversation with ${agentName}` : 'Find your coding agent'}</h1><p className="empty-description">{!connected ? 'Bloblex keeps its daemon and agent sessions on this device. Reconnect to load the latest state.' : hasRuntime ? 'Choose a project folder. Your selected CLI starts a real session there.' : 'We only show agents installed on this device. Refresh to scan for Claude Code, Codex, or OpenCode.'}</p><button className="primary-button" onClick={!connected ? onRefresh : hasRuntime ? onNewSession : onRefresh} disabled={!connected && !hasRuntime}><FolderOpen size={15} />{!connected ? 'Try again' : hasRuntime ? 'Choose a project' : 'Scan for agents'}</button></div>
}

function RuntimeContextMenu({ runtime, session, position, onClose, onNew, onResume, onSettings, onStop }: { runtime: Runtime | null; session: Session | null; position: { x: number; y: number }; onClose: () => void; onNew: () => void; onResume: (session: Session) => void; onSettings: () => void; onStop: (session: Session) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }, [])
  useEffect(() => {
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key === 'Escape') onClose()
      if (event instanceof MouseEvent && ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close) }
  }, [onClose])
  const active = session && ['working', 'starting', 'cancelling', 'waiting_permission'].includes(session.state ?? '')
  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
    let target = -1
    if (event.key === 'ArrowDown') target = (index + 1) % buttons.length
    else if (event.key === 'ArrowUp') target = (index - 1 + buttons.length) % buttons.length
    else if (event.key === 'Home') target = 0
    else if (event.key === 'End') target = buttons.length - 1
    if (target >= 0 && buttons.length) { event.preventDefault(); buttons[target]?.focus() }
  }
  return <div ref={ref} className="runtime-context-menu" role="menu" aria-label={`${labelize(runtime?.provider)} runtime actions`} onKeyDown={moveFocus} style={{ left: Math.max(8, Math.min(position.x, window.innerWidth - 210)), top: Math.max(8, Math.min(position.y, window.innerHeight - 190)) }}>
    <strong className="runtime-context-title">{labelize(runtime?.provider, 'Runtime')}</strong>
    <button role="menuitem" onClick={onNew}><MessageSquarePlus size={14} />New session</button>
    <button role="menuitem" disabled={!session?.resumable || !!active} onClick={() => session && onResume(session)}><Play size={14} />Resume session</button>
    <button role="menuitem" onClick={onSettings}><Settings2 size={14} />Runtime settings</button>
    <button role="menuitem" className="danger-menu-item" disabled={!active} onClick={() => session && onStop(session)}><Square size={13} />Stop active session</button>
  </div>
}

function MessageItem({ message, accent, agentName, showAvatar, mood }: { message: Record<string, unknown>; accent: string; agentName: string; showAvatar: boolean; mood: BlobMood }) {
  const isUser = isUserMessage(message)
  const role = String(message.role ?? message.kind ?? 'assistant').toLowerCase()
  const text = typeof message.text === 'string' ? message.text : typeof message.content === 'string' ? message.content : typeof message.delta === 'string' ? message.delta : ''
  const toolName = typeof message.toolName === 'string' ? message.toolName : typeof message.tool === 'string' ? message.tool : undefined
  const eventType = typeof message.eventType === 'string' ? message.eventType : ''
  const isTool = Boolean(toolName) || eventType.startsWith('tool.') || eventType.startsWith('command.')
  const isError = message.status === 'error' || role === 'error' || eventType === 'turn.error'
  const time = typeof message.createdAt === 'string' ? new Date(message.createdAt) : null
  const stamp = time && !Number.isNaN(time.valueOf()) ? <time>{time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time> : null
  return <article className={`message-row ${isUser ? 'user' : 'agent'} ${showAvatar ? 'group-start' : ''}`}>
    {!isUser && <span className="message-avatar">{showAvatar && <BlobCanvas color={accent} size={30} mood={isError ? 'error' : mood} label={`${agentName} avatar`} />}</span>}
    <div className="message-content">
      {showAvatar && <div className="message-byline">{agentName}{stamp}</div>}
      {isTool ? <div className={`activity-card ${isError ? 'error' : ''}`}><div className="activity-heading"><Terminal size={14} /><strong>{labelize(toolName ?? eventType.replace('.', ' '))}</strong><span>{isError ? 'Failed' : formatUnknownSafe(String(message.status ?? ''), 'Activity')}</span></div><p>{text || (typeof message.command === 'string' ? message.command : typeof message.summary === 'string' ? message.summary : 'Details are unavailable for this event.')}</p>{typeof message.path === 'string' && <code>{message.path}</code>}</div> : <div className={`message-bubble ${isError ? 'message-error' : ''}`}><SafeMessageText text={text || 'Message content unavailable.'} /></div>}
      {isUser && stamp && <div className="message-byline user-stamp">{stamp}</div>}
    </div>
  </article>
}

function isUserMessage(message: Record<string, unknown> | undefined) {
  return String(message?.role ?? message?.kind ?? 'assistant').toLowerCase() === 'user'
}

function latestPreview(session: Session | null) {
  if (!session) return null
  const last = (session.messages ?? []).at(-1)
  const text = last && (typeof last.content === 'string' ? last.content : typeof last.text === 'string' ? last.text : '')
  if (text) return `${isUserMessage(last) ? 'You: ' : ''}${text.replace(/\s+/g, ' ').slice(0, 90)}`
  return formatUnknownSafe(session.title, session.projectPath?.split(/[\\/]/).pop() ?? 'New session')
}

/** Compact surfaces show prose without markdown markers or code fences. */
function plainText(text: string) {
  return text.replace(/```[\s\S]*?```/g, ' [code] ').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim()
}

function shortTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return ''
  const now = new Date()
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function ActivityItem({ item }: { item: ConversationItem }) {
  const activity = item.activity ?? {}
  const file = item.activityKind === 'file'
  const failed = ['error', 'failed', 'rejected'].includes(String(activity.state ?? activity.status ?? '').toLowerCase()) || item.activityKind === 'turn'
  const title = item.activityKind === 'turn' ? 'Turn failed' : file ? labelize(activity.operation, 'File change') : formatUnknownSafe(activity.title, formatUnknownSafe(activity.kind, 'Agent activity'))
  const detail = file ? String(activity.path ?? 'Changed file') : String(activity.command ?? activity.summary ?? activity.detail ?? activity.output ?? '')
  const timeValue = activity.completedAt ?? activity.startedAt ?? activity.createdAt
  const time = typeof timeValue === 'string' ? new Date(timeValue) : null
  return <article className={`activity-card timeline-activity ${failed ? 'error' : ''}`}>
    <div className="activity-heading">{file ? <FileText size={15} /> : <Terminal size={15} />}<strong>{title}</strong><span>{labelize(activity.state ?? activity.status, file ? 'Reported' : 'Activity')}</span>{time && !Number.isNaN(time.valueOf()) && <time>{time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}</div>
    {detail && <p>{detail}</p>}
    {typeof activity.exitCode === 'number' && <small>Exit code {activity.exitCode}</small>}
    {typeof activity.diff === 'string' && <details className="activity-detail"><summary>View reported diff</summary><pre>{activity.diff}</pre></details>}
    {typeof activity.output === 'string' && activity.output !== detail && <details className="activity-detail"><summary>Output</summary><pre>{activity.output}</pre></details>}
  </article>
}

function SafeMessageText({ text }: { text: string }) {
  const blocks = text.split(/```([^\n`]*)\n([\s\S]*?)```/g)
  return <div className="safe-markdown">{blocks.map((part, index) => {
    if (index % 3 === 1) return null
    if (index % 3 === 2) return <CodeBlock key={`code-${index}`} language={blocks[index - 1]?.trim()} code={part.replace(/\n$/, '')} />
    return part.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((inline, inlineIndex) => inline.startsWith('`') && inline.endsWith('`')
      ? <code key={`${index}-${inlineIndex}`}>{inline.slice(1, -1)}</code>
      : inline.startsWith('**') && inline.endsWith('**')
        ? <strong key={`${index}-${inlineIndex}`}>{inline.slice(2, -2)}</strong>
        : <span key={`${index}-${inlineIndex}`}>{inline}</span>)
  })}</div>
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); window.setTimeout(() => setCopied(false), 1200) } catch { setCopied(false) }
  }
  return <div className="message-code"><div className="message-code-header"><span>{language || 'Code'}</span><button onClick={() => void copy()} aria-label="Copy code"><Copy size={13} />{copied ? 'Copied' : 'Copy'}</button></div><pre><code>{code}</code></pre></div>
}

function RuntimeExplainer({ onDismiss }: { onDismiss: () => void }) {
  return <aside className="runtime-explainer" role="note" aria-label="About local agent runtimes"><CircleHelp size={17} /><span><strong>How Bloblex connects</strong><small>Bloblex coordinates coding-agent CLIs installed on this device. Sign in with each provider’s own CLI; Bloblex does not provide model access. Actions that need approval wait for your choice.</small></span><button className="icon-button quiet" aria-label="Dismiss runtime explanation" title="Dismiss" onClick={onDismiss}><X size={15} /></button></aside>
}

function PermissionCard({ permission, onReply }: { permission: PermissionRequest; onReply: (choice: string) => void }) {
  const choices = permission.choices ?? []
  const detail = typeof permission.detail === 'string' ? permission.detail : typeof permission.description === 'string' ? permission.description : typeof permission.command === 'string' ? permission.command : null
  const tool = typeof permission.tool === 'string' ? permission.tool : null
  const deadline = typeof permission.expiresAt === 'string' ? Date.parse(permission.expiresAt) : Number.NaN
  return <section className="permission-card"><div className="permission-icon"><ShieldAlert size={17} /></div><div className="permission-copy"><strong>{formatUnknownSafe(permission.title, 'Approval requested')}</strong><p>{detail ?? `The agent requested permission${tool ? ` to use ${tool}` : ''}.`}</p>{Number.isFinite(deadline) && <small className="permission-deadline">Expires {new Date(deadline).toLocaleTimeString()}</small>}<div className="permission-actions">{choices.map((choice) => <PermissionChoiceButton key={choice} permission={permission} choice={choice} className="permission-choice" onReply={onReply}>{permissionChoiceLabel(choice)}</PermissionChoiceButton>)}</div></div></section>
}

function DetailsPane({ runtime, session, connected, budgetWarning, budget, usage, onUsage }: { runtime: Runtime | null; session: Session | null; connected: boolean; budgetWarning: boolean; budget: Record<string, unknown> | null; usage: Record<string, unknown> | null; onUsage: () => void }) {
  const mood = deriveCompanionStatus({ connected, runtime, session, budgetWarning }).mood
  return <div className="context-scroll"><section className="selected-agent"><BlobCanvas color={providerColor(runtime?.provider)} size={54} mood={mood} label={labelize(runtime?.provider)} /><div><h2>{runtime ? labelize(runtime.provider) : 'No agent selected'}</h2><p>{labelize(runtime?.protocolFamily, 'Local coding agent')}</p><span className="context-status"><i className={`status-dot ${connected ? statusClass(runtime?.status) : 'muted'}`} />{connected ? labelize(runtime?.status, 'Unknown') : 'Daemon disconnected'}</span></div></section>
    <section className="context-section"><div className="section-heading"><h3>Current session</h3><MessageSquarePlus size={16} /></div>{session ? <div className="current-task"><strong>{formatUnknownSafe(session.title, fileNameForPath(session.projectPath ?? '') ?? 'Untitled session')}</strong><p>{session.projectPath ?? 'Project path unavailable'}</p><span>{labelize(session.state, 'Unknown state')}</span></div> : <div className="context-empty">No conversation selected.</div>}</section>
    <section className="context-section usage-section"><div className="section-heading"><h3>Usage</h3><ArrowDownToLine size={15} /></div><div className="details-usage-grid"><div><span>Input tokens</span><strong>{tokenValue(usage?.inputTokens)}</strong></div><div><span>Output tokens</span><strong>{tokenValue(usage?.outputTokens)}</strong></div><div><span>Provider actual</span><strong>{moneyMinor(usage?.providerReportedCostMinor, usage?.providerReportedCurrency)}</strong></div><div><span>API estimate</span><strong>{moneyMinor(usage?.apiEstimateMinor, usage?.apiEstimateCurrency)}</strong></div></div><small className="usage-scope">All runtimes - all time</small>{budget && <div className="details-budget"><span>{labelize(budget.metric)} {labelize(budget.period)} budget</span><strong>{budgetValue(budget.remaining, budget.metric)} remaining of {budgetValue(budget.hardLimit, budget.metric)}</strong></div>}<button className="usage-summary" onClick={onUsage}><span className="usage-leading"><span className="usage-icon"><Code2 size={16} /></span><span><strong>Usage details</strong><small>Open date-bounded summary</small></span></span><ChevronDown size={15} /></button>{budgetWarning && <p className="budget-inline-warning" role="status">A budget warning was reported for this session.</p>}<p className="honesty-note">Provider-reported cost and API estimates are separate. Unknown prices stay unknown; totals may be partial.</p></section>
  </div>
}

function RuntimePane({ runtime, connected, refreshing, onRefresh }: { runtime: Runtime | null; connected: boolean; refreshing: boolean; onRefresh: () => void }) {
  if (!runtime) return <div className="context-empty centered">{connected ? 'No runtime selected.' : 'Runtime details appear when the daemon is connected.'}</div>
  const host = runtime.host
  const auth = labelize(runtime.authState, 'Unknown')
  return <div className="context-scroll"><section className="runtime-summary"><div className="runtime-summary-icon"><Laptop size={19} /></div><div><strong>{typeof host?.name === 'string' ? host.name : 'This computer'}</strong><span>{labelize(host?.kind, 'Windows')}</span></div><button className="icon-button quiet" title="Refresh runtime" onClick={onRefresh} disabled={refreshing}><RefreshCw size={14} className={refreshing ? 'spinning' : ''} /></button></section><div className="runtime-detail-list">
    <InfoRow icon={<CircleHelp size={15} />} label="Daemon" value={connected ? 'Connected' : 'Disconnected'} good={connected} />
    <InfoRow icon={<Terminal size={15} />} label="Agent CLI" value={runtime.executablePath ?? 'Path unknown'} mono />
    <InfoRow icon={<Code2 size={15} />} label="Version" value={runtime.version ?? 'Unknown'} />
    <InfoRow icon={<ShieldAlert size={15} />} label="Authentication" value={auth} good={runtime.authState === 'authenticated'} />
    <InfoRow icon={<GitBranch size={15} />} label="Protocol" value={labelize(runtime.protocolFamily, 'Unknown')} />
    <InfoRow icon={<Laptop size={15} />} label="Host" value={typeof host?.name === 'string' ? host.name : runtime.hostId ?? 'Local'} />
  </div><section className="context-section capabilities"><div className="section-heading"><h3>Capabilities</h3></div>{Array.isArray(runtime.capabilities) ? <div className="capability-list">{runtime.capabilities.map((capability) => <span key={String(capability)}>{labelize(capability)}</span>)}</div> : runtime.capabilities && typeof runtime.capabilities === 'object' ? <div className="capability-list">{Object.entries(runtime.capabilities).filter(([, enabled]) => enabled).map(([name]) => <span key={name}>{labelize(name)}</span>)}</div> : <p className="context-empty">Not reported by this runtime.</p>}</section></div>
}

function FilesPane({ session, onOpen, onReveal, onCopy, onDiff }: { session: Session | null; onOpen: (path: string) => void; onReveal: (path: string) => void; onCopy: (path: string) => void; onDiff: (path: string, content: string) => void }) {
  const files = session?.files ?? []
  return <div className="context-scroll"><section className="files-heading"><div className="files-icon"><FileText size={17} /></div><div><h3>Files in this session</h3><p>Changes reported by the runtime</p></div></section>{files.length === 0 ? <div className="files-empty"><FileText size={21} /><strong>No files reported</strong><span>File activity appears here when the agent reports edits.</span></div> : <div className="file-list">{files.map((file, index) => { const path = String(file.path ?? file.filePath ?? 'Unknown path'); const diff = typeof file.diff === 'string' ? file.diff : typeof file.patch === 'string' ? file.patch : null; return <article className="file-row" key={String(file.id ?? path) + index}><FileText size={16} /><span className="file-main"><strong>{path.split(/[\\/]/).pop()}</strong><small>{path}</small></span>{typeof file.addedLines === 'number' && <em>+{file.addedLines}</em>}{typeof file.additions === 'number' && file.addedLines === undefined && <em>+{file.additions}</em>}{typeof file.removedLines === 'number' && <i>−{file.removedLines}</i>}{typeof file.deletions === 'number' && file.removedLines === undefined && <i>−{file.deletions}</i>}<span className="file-actions"><button title="Open in configured editor" aria-label={`Open ${path} in editor`} disabled={path === 'Unknown path'} onClick={() => onOpen(path)}><Code2 size={13} /></button><button title="Reveal in File Explorer" aria-label={`Reveal ${path} in File Explorer`} disabled={path === 'Unknown path'} onClick={() => onReveal(path)}><FolderOpen size={13} /></button><button title="Copy absolute path" aria-label={`Copy ${path}`} disabled={path === 'Unknown path'} onClick={() => onCopy(path)}><Copy size={13} /></button><button title={diff ? 'View reported diff' : 'No diff reported'} aria-label={`View diff for ${path}`} disabled={!diff} onClick={() => diff && onDiff(path, diff)}><FileText size={13} /></button></span></article> })}</div>}<p className="honesty-note">Paths are resolved inside the session project. The default editor is Notepad; configured editors run directly with argument arrays, never through a shell.</p></div>
}

function DiffViewer({ path, content, onClose }: { path: string; content: string; onClose: () => void }) {
  const dialogRef = useDialogAccessibility(onClose)
  return <div className="sheet-backdrop diff-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section ref={dialogRef} className="diff-sheet" role="dialog" aria-modal="true" aria-labelledby="diff-title"><header><div><p className="eyebrow">FILE CHANGE</p><h2 id="diff-title">{fileNameForPath(path)}</h2><small>{path}</small></div><button className="icon-button" data-dialog-initial-focus aria-label="Close diff" onClick={onClose}><X size={17} /></button></header><pre>{content}</pre></section></div>
}


function useDialogAccessibility(onClose: () => void) {
  const ref = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusables = () => Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')).filter((node) => !node.hasAttribute('aria-hidden'))
    const initial = root.querySelector<HTMLElement>('[data-dialog-initial-focus]') ?? focusables()[0]
    const frame = requestAnimationFrame(() => initial?.focus())
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) { event.preventDefault(); root.focus(); return }
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', keydown); previous?.focus() }
  }, [])
  return ref
}

function InfoRow({ icon, label, value, good, mono }: { icon: React.ReactNode; label: string; value: string; good?: boolean; mono?: boolean }) {
  return <div className="info-row"><span className="info-icon">{icon}</span><span className="info-label">{label}</span><span className={`info-value ${mono ? 'mono' : ''} ${good ? 'good' : ''}`}>{value}</span></div>
}

function UsageSheet({ summary, period, loading, onPeriodChange, onClose }: { summary: Record<string, unknown> | null; period: 'today' | 'month'; loading: boolean; onPeriodChange: (period: 'today' | 'month') => void; onClose: () => void }) {
  const dialogRef = useDialogAccessibility(onClose)
  const valuations = records(summary?.valuations)
  const subscriptions = records(summary?.subscriptions)
  return <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section ref={dialogRef} className="usage-sheet" role="dialog" aria-modal="true" aria-labelledby="usage-title">
    <header><div><p className="eyebrow">{summary ? `${shortDate(summary.from)} – ${shortDate(summary.to)}` : 'USAGE'}</p><h2 id="usage-title">Usage summary</h2><small className="usage-scope">All runtimes on this device · requested period</small></div><button className="icon-button" data-dialog-initial-focus aria-label="Close usage summary" onClick={onClose}><X size={17} /></button></header>
    <div className="usage-period-switch" aria-label="Usage date range"><button className={period === 'today' ? 'active' : ''} aria-pressed={period === 'today'} onClick={() => onPeriodChange('today')}>Today</button><button className={period === 'month' ? 'active' : ''} aria-pressed={period === 'month'} onClick={() => onPeriodChange('month')}>This month</button></div>
    {loading ? <div className="sheet-loading"><LoaderCircle className="spinning" /><span>Loading the daemon summary…</span></div> : summary ? <div className="usage-sheet-body">
      <section className="usage-block"><div className="usage-block-heading"><h3>Token usage</h3><span>Mutually exclusive buckets</span></div><div className="usage-token-grid">{usageTokenBuckets(summary).map((bucket) => <div className="usage-token" key={bucket.key}><span>{bucket.label}</span><strong>{bucket.value}</strong></div>)}</div></section>
      <section className="usage-block"><div className="usage-block-heading"><h3>Cost basis</h3><span>Values stay separate</span></div><div className="usage-cost-grid">
        <div><span>Recorded provider actual</span><strong>{moneyMinor(summary.providerReportedCostMinor, summary.providerReportedCurrency)}</strong><small>{typeof summary.providerReportedCurrency === 'string' ? summary.providerReportedCurrency : 'Currency unknown'}</small></div>
        <div><span>Recorded API-rate estimate</span><strong>{moneyMinor(summary.apiEstimateMinor, summary.apiEstimateCurrency)}</strong><small>{typeof summary.apiEstimateCurrency === 'string' ? summary.apiEstimateCurrency : 'Currency unknown'}</small></div>
        <div><span>Monthly subscription total</span><strong>{moneyMinor(summary.subscriptionFixedMinor, summary.subscriptionCurrency)}</strong><small>{typeof summary.subscriptionCurrency === 'string' ? summary.subscriptionCurrency : 'Plans are listed separately below'}</small></div>
      </div><p className="usage-honesty">{summary.pricingStatus === 'available' ? 'Recorded API-equivalent values use configured rates; they are not the provider’s bill and may cover only records with known prices.' : 'No API-rate valuation is available for this period. Unknown amounts are not shown as zero.'} Provider totals may be partial when some events have no known price.</p>
        {valuations.length > 0 && <div className="usage-valuation-list">{valuations.map((item, index) => <div key={String(item.basis ?? index)}><strong>{valuationLabel(item.basis)}</strong><span>{moneyMinor(item.amountMinor, item.currency)}</span><small>{typeof item.eventCount === 'number' ? `${item.eventCount} usage records` : 'Record count unknown'} · {String(item.status ?? 'status unknown')}</small></div>)}</div>}
      </section>
      <section className="usage-block"><div className="usage-block-heading"><h3>Configured subscriptions</h3><span>Monthly user-entered fees</span></div>{subscriptions.length ? <div className="usage-subscriptions">{subscriptions.map((plan, index) => <div key={String(plan.id ?? `${plan.provider ?? 'plan'}-${index}`)}><strong>{String(plan.provider ?? 'Provider')}</strong><span>{moneyMinor(plan.monthlyMinor, plan.currency)} / month</span><small>Renewal day {typeof plan.renewalDay === 'number' ? plan.renewalDay : 'unknown'} · quota {String(plan.quotaState ?? 'unknown')}</small></div>)}</div> : <p className="usage-empty-line">No subscription fees have been configured.</p>}</section>
    </div> : <div className="sheet-empty"><CircleHelp size={20} /><strong>Usage summary unavailable</strong><p>The daemon did not return a summary. Bloblex will not estimate a zero cost from missing data.</p></div>}
    <footer>Provider-reported charges, API-rate estimates, and subscription fees are separate values.</footer>
  </section></div>
}

function shortDate(value: unknown) {
  if (typeof value !== 'string') return 'unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

type SettingsPage = 'General' | 'Runtimes' | 'Agents' | 'Usage & budgets' | 'Permissions' | 'WSL' | 'Updates' | 'Developer'

function SettingsSheet({ snapshot, runtime, session, initialPage, onClose, onRefresh, onError }: { snapshot: Snapshot | null; runtime: Runtime | null; session: Session | null; initialPage: 'General' | 'Runtimes'; onClose: () => void; onRefresh: () => void; onError: (error: string | null) => void }) {
  const dialogRef = useDialogAccessibility(onClose)
  const [page, setPage] = useState<SettingsPage>(initialPage)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [data, setData] = useState<Record<string, unknown>>({})
  const [companionVisible, setCompanionVisible] = useState(true)
  const [closeToTray, setCloseToTrayValue] = useState(true)
  const [monitors, setMonitors] = useState<string[]>([])
  const [companionMonitor, setCompanionMonitorValue] = useState<string | null>(null)
  const [soundsEnabled, setSoundsEnabled] = useState(false)
  const [editorExecutable, setEditorExecutable] = useState('')
  const [editorArgs, setEditorArgs] = useState('[]')
  const [profileName, setProfileName] = useState('')
  const [profileProvider, setProfileProvider] = useState('codex')
  const [profileProtocol, setProfileProtocol] = useState('codex_app_server')
  const [profilePath, setProfilePath] = useState('')
  const [profileArgs, setProfileArgs] = useState('[]')
  const [budgetScope, setBudgetScope] = useState('global')
  const [budgetPeriod, setBudgetPeriod] = useState('day')
  const [budgetMetric, setBudgetMetric] = useState('tokens')
  const [budgetLimit, setBudgetLimit] = useState('')
  const [editingBudgetId, setEditingBudgetId] = useState<string | null>(null)
  const [editingBudgetScopeId, setEditingBudgetScopeId] = useState<string | null>(null)
  const [priceProvider, setPriceProvider] = useState('')
  const [priceModel, setPriceModel] = useState('')
  const [priceAliases, setPriceAliases] = useState('')
  const [priceInput, setPriceInput] = useState('')
  const [priceOutput, setPriceOutput] = useState('')
  const [priceCurrency, setPriceCurrency] = useState('')
  const [editingPricingId, setEditingPricingId] = useState<string | null>(null)
  const [planProvider, setPlanProvider] = useState('')
  const [planCurrency, setPlanCurrency] = useState('')
  const [planMonthlyAmount, setPlanMonthlyAmount] = useState('')
  const [planRenewalDay, setPlanRenewalDay] = useState('1')
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!inDesktop) return
    setLoading(true)
    setFormError(null)
    const methods = ['settings.get', 'runtime.profile.list', 'budget.list', 'pricing.list', 'subscription.list', 'daemon.health']
    const entries = await Promise.all(methods.map(async (method) => {
      try { return [method, await rpc(method)] as const }
      catch (reason) { return [method, { loadError: messageOf(reason) }] as const }
    }))
    const result = Object.fromEntries(entries)
    setData(result)
    const preferences = recordFrom(result['settings.get'])
    const settings = recordFrom(preferences.settings ?? preferences)
    if (typeof settings.showCompanion === 'boolean') setCompanionVisible(settings.showCompanion)
    if (typeof settings.closeToTray === 'boolean') setCloseToTrayValue(settings.closeToTray)
    void Promise.all([companionMonitorOptions(), currentCompanionMonitor()]).then(([available, current]) => {
      setMonitors(available)
      setCompanionMonitorValue(current)
    }).catch(() => { setMonitors([]); setCompanionMonitorValue(null) })
    if (typeof settings['companion.soundsEnabled'] === 'boolean') {
      setSoundsEnabled(settings['companion.soundsEnabled'])
    }
    if (typeof settings.editorExecutable === 'string') setEditorExecutable(settings.editorExecutable)
    if (Array.isArray(settings.editorArgs) && settings.editorArgs.every((argument) => typeof argument === 'string')) setEditorArgs(JSON.stringify(settings.editorArgs))
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const submit = async (method: string, params: Record<string, unknown>, successMessage: string) => {
    setSaving(true)
    setFormError(null)
    try {
      const result = await rpc(method, params)
      await load()
      setNotice(successMessage)
      onError(null)
      return result
    } catch (reason) {
      const errorText = messageOf(reason)
      setFormError(errorText)
      onError(errorText)
      return null
    } finally { setSaving(false) }
  }

  const setCompanion = async (visible: boolean) => {
    setSaving(true)
    setFormError(null)
    try {
      await setCompanionVisibility(visible)
      setCompanionVisible(visible)
    } catch (reason) {
      setFormError(messageOf(reason))
    } finally { setSaving(false) }
  }

  const updateCloseToTray = async (enabled: boolean) => {
    setSaving(true)
    setFormError(null)
    try { await setCloseToTray(enabled); setCloseToTrayValue(enabled) }
    catch (reason) { setFormError(messageOf(reason)) }
    finally { setSaving(false) }
  }

  const updateCompanionMonitor = async (monitorName: string) => {
    setSaving(true)
    setFormError(null)
    try { await setCompanionMonitor(monitorName); setCompanionMonitorValue(monitorName); setNotice(`Companion moved to ${monitorName}.`) }
    catch (reason) { setFormError(messageOf(reason)) }
    finally { setSaving(false) }
  }

  const setSounds = async (enabled: boolean) => {
    setSoundsEnabled(enabled)
    setSaving(true)
    setFormError(null)
    try {
      await rpc('settings.set', { key: 'companion.soundsEnabled', value: enabled })
      try { await emit('bloblex-sounds-changed', enabled) } catch { /* persisted value hydrates on the companion's next connection */ }
      setNotice(enabled ? 'Companion sounds enabled.' : 'Companion sounds muted.')
    } catch (reason) {
      const message = messageOf(reason)
      setSoundsEnabled(!enabled)
      setFormError(message)
      onError(message)
    } finally { setSaving(false) }
  }

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault()
    let args: unknown
    try { args = JSON.parse(profileArgs) } catch { setFormError('Fixed arguments must be a valid JSON array of strings.'); return }
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) { setFormError('Fixed arguments must be a valid JSON array of strings.'); return }
    const result = await submit('runtime.profile.save', { profile: { name: profileName, provider: profileProvider, protocolFamily: profileProtocol, executablePath: profilePath, args, workingDirectoryPolicy: 'per_session' } }, 'Profile saved.')
    if (result) { setProfileName(''); setProfilePath(''); setProfileArgs('[]') }
  }

  const saveBudget = async (event: React.FormEvent) => {
    event.preventDefault()
    const enteredLimit = Number(budgetLimit)
    if (!Number.isSafeInteger(enteredLimit) || enteredLimit <= 0) { setFormError('Enter a positive whole-number limit.'); return }
    const selectedScopeId = budgetScope === 'host' ? snapshot?.hosts?.[0]?.id : budgetScope === 'runtime' ? runtime?.id : budgetScope === 'agent' ? runtime?.provider : budgetScope === 'project' ? session?.projectPath : budgetScope === 'session' ? session?.id : undefined
    const scopeId = editingBudgetId ? editingBudgetScopeId ?? selectedScopeId : selectedScopeId
    if (budgetScope !== 'global' && !scopeId) { setFormError(`Select an active ${budgetScope} before creating this budget.`); return }
    const result = await submit('budget.set', { ...(editingBudgetId ? { id: editingBudgetId } : {}), scopeType: budgetScope, ...(scopeId ? { scopeId } : {}), period: budgetPeriod, metric: budgetMetric, hardLimit: enteredLimit, warningThresholds: [50, 80, 95], enabled: true }, editingBudgetId ? 'Budget policy updated.' : 'Budget policy saved.')
    if (result) { setBudgetLimit(''); setEditingBudgetId(null); setEditingBudgetScopeId(null) }
  }

  const savePricing = async (event: React.FormEvent) => {
    event.preventDefault()
    const inputPerMillion = Number(priceInput)
    const outputPerMillion = Number(priceOutput)
    if (!priceProvider.trim() || !priceModel.trim() || !priceCurrency.trim() || !Number.isFinite(inputPerMillion) || !Number.isFinite(outputPerMillion) || inputPerMillion < 0 || outputPerMillion < 0) { setFormError('Enter a provider, model, currency, and non-negative input/output rates.'); return }
    const currency = priceCurrency.trim().toUpperCase()
    let inputMinor: number, outputMinor: number
    try { inputMinor = toMinorUnits(inputPerMillion, currency); outputMinor = toMinorUnits(outputPerMillion, currency) } catch { setFormError('Enter valid currency amounts and a three-letter currency code.'); return }
    const rule = { id: editingPricingId ?? crypto.randomUUID(), provider: priceProvider.trim(), canonicalModelId: priceModel.trim(), aliases: priceAliases.split(',').map((value) => value.trim()).filter(Boolean), inputPerMillion: inputMinor, outputPerMillion: outputMinor, currency, effectiveFrom: new Date().toISOString(), isUserOverride: true }
    const result = await submit('pricing.override', { rule }, editingPricingId ? 'Pricing override updated.' : 'Pricing override saved.')
    if (result) { setEditingPricingId(null); setPriceProvider(''); setPriceModel(''); setPriceAliases(''); setPriceInput(''); setPriceOutput(''); setPriceCurrency('') }
  }

  const savePlan = async (event: React.FormEvent) => {
    event.preventDefault()
    const monthlyAmount = Number(planMonthlyAmount)
    const renewalDay = Number(planRenewalDay)
    if (!planProvider.trim() || !planCurrency.trim() || !Number.isFinite(monthlyAmount) || monthlyAmount < 0 || !Number.isInteger(renewalDay) || renewalDay < 1 || renewalDay > 31) { setFormError('Enter provider, currency, a non-negative monthly fee, and renewal day (1–31).'); return }
    let monthlyMinor: number
    try { monthlyMinor = toMinorUnits(monthlyAmount, planCurrency.trim().toUpperCase()) } catch { setFormError('Enter a valid three-letter currency code.'); return }
    const result = await submit('subscription.save', { plan: { id: editingPlanId ?? crypto.randomUUID(), provider: planProvider.trim(), billingMode: 'subscription', currency: planCurrency.trim().toUpperCase(), monthlyMinor, renewalDay, quotaState: 'unknown' } }, editingPlanId ? 'Subscription plan updated.' : 'Subscription plan saved.')
    if (result) { setEditingPlanId(null); setPlanProvider(''); setPlanCurrency(''); setPlanMonthlyAmount(''); setPlanRenewalDay('1') }
  }

  const saveEditor = async (event: React.FormEvent) => {
    event.preventDefault()
    let args: unknown
    try { args = JSON.parse(editorArgs) } catch { setFormError('Editor arguments must be a JSON array of strings.'); return }
    if (!Array.isArray(args) || !args.every((argument) => typeof argument === 'string')) { setFormError('Editor arguments must be a JSON array of strings.'); return }
    setSaving(true); setFormError(null)
    try {
      await rpc('settings.set', { key: 'editorExecutable', value: editorExecutable.trim() })
      await rpc('settings.set', { key: 'editorArgs', value: args })
      await load(); setNotice('Editor preference saved.'); onError(null)
    } catch (reason) { setFormError(messageOf(reason)); onError(messageOf(reason)) }
    finally { setSaving(false) }
  }

  const deleteBudget = (policyId: string) => submit('budget.delete', { policyId }, 'Budget policy removed.')
  const setBudgetEnabled = (policy: Record<string, unknown>, enabled: boolean) => submit('budget.set', { ...policy, enabled }, enabled ? 'Budget policy enabled.' : 'Budget policy paused.')
  const editBudget = (policy: Record<string, unknown>) => {
    if (typeof policy.id !== 'string') return
    setEditingBudgetId(policy.id)
    setEditingBudgetScopeId(typeof policy.scopeId === 'string' ? policy.scopeId : null)
    setBudgetScope(String(policy.scopeType ?? 'global'))
    setBudgetPeriod(String(policy.period ?? 'day'))
    setBudgetMetric(String(policy.metric ?? 'tokens'))
    setBudgetLimit(String(policy.hardLimit ?? ''))
  }
  const editPricing = (rule: Record<string, unknown>) => {
    if (typeof rule.id !== 'string' || typeof rule.currency !== 'string') return
    setEditingPricingId(rule.id)
    setPriceProvider(String(rule.provider ?? ''))
    setPriceModel(String(rule.canonicalModelId ?? ''))
    setPriceAliases(Array.isArray(rule.aliases) ? rule.aliases.map(String).join(', ') : '')
    setPriceInput(String(minorToMajor(rule.inputPerMillion, rule.currency)))
    setPriceOutput(String(minorToMajor(rule.outputPerMillion, rule.currency)))
    setPriceCurrency(rule.currency)
  }
  const editPlan = (plan: Record<string, unknown>) => {
    if (typeof plan.id !== 'string' || typeof plan.currency !== 'string') return
    setEditingPlanId(plan.id)
    setPlanProvider(String(plan.provider ?? ''))
    setPlanCurrency(plan.currency)
    setPlanMonthlyAmount(String(minorToMajor(plan.monthlyMinor, plan.currency)))
    setPlanRenewalDay(String(plan.renewalDay ?? '1'))
  }
  const deleteProfile = (profileId: string) => submit('runtime.profile.delete', { profileId }, 'Runtime profile removed.')
  const pages: SettingsPage[] = ['General', 'Runtimes', 'Agents', 'Usage & budgets', 'Permissions', 'WSL', 'Updates', 'Developer']
  return <div className="sheet-backdrop settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section ref={dialogRef} className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <header className="settings-header"><div><p className="eyebrow">BLOBLEX</p><h2 id="settings-title">Settings</h2></div><button className="icon-button" data-dialog-initial-focus aria-label="Close settings" onClick={onClose}><X size={17} /></button></header>
    <div className="settings-layout"><nav className="settings-nav" aria-label="Settings pages">{pages.map((item) => <button className={page === item ? 'selected' : ''} key={item} onClick={() => { setPage(item); setFormError(null); setNotice(null) }}>{item}</button>)}</nav>
      <div className="settings-content">
        {formError && <div className="inline-error settings-error" role="alert"><ShieldAlert size={15} /><span>{formError}</span></div>}
        {notice && <div className="settings-success" role="status"><Check size={14} />{notice}</div>}
        {loading && <div className="settings-loading"><LoaderCircle size={17} className="spinning" />Loading saved settings…</div>}
        {!loading && page === 'General' && <><section className="settings-section"><h3>Desktop behavior</h3><SettingsRow title="Desktop companion" description="Show or hide the draggable bill capsule."><button className={`toggle ${companionVisible ? 'on' : ''}`} role="switch" aria-checked={companionVisible} onClick={() => void setCompanion(!companionVisible)} disabled={saving}><i /></button></SettingsRow><SettingsRow title="Close to tray" description="When enabled, closing the main window hides Bloblex and keeps the tray controls available."><button className={`toggle ${closeToTray ? 'on' : ''}`} role="switch" aria-label="Close to tray" aria-checked={closeToTray} onClick={() => void updateCloseToTray(!closeToTray)} disabled={saving}><i /></button></SettingsRow><SettingsRow title="Companion monitor" description="Choose a connected display; the capsule moves to its bottom center and remembers the selection."><select className="settings-select" aria-label="Companion monitor" value={companionMonitor ?? ''} onChange={(event) => void updateCompanionMonitor(event.target.value)} disabled={saving || monitors.length === 0}>{monitors.length === 0 ? <option value="">No displays reported</option> : monitors.map((monitor) => <option key={monitor} value={monitor}>{monitor}</option>)}</select></SettingsRow><SettingsRow title="Start with Windows" description="Startup registration is not available in this build."><span className="setting-value">Unavailable</span></SettingsRow><SettingsRow title="Sounds" description="Optional original synthesized cues; muted unless you enable them."><button className={`toggle ${soundsEnabled ? 'on' : ''}`} role="switch" aria-label="Companion sounds" aria-checked={soundsEnabled} onClick={() => void setSounds(!soundsEnabled)} disabled={saving}><i /></button></SettingsRow><SettingsRow title="Local daemon" description="Provider authentication remains managed by its own CLI."><span className="setting-value">{snapshot?.daemon?.state ? labelize(snapshot.daemon.state) : 'Unknown'}</span></SettingsRow></section><form className="settings-form" onSubmit={(event) => void saveEditor(event)}><h3>File editor</h3><p className="settings-intro">Changed files open in the editor you configure. Leave the executable blank to use Notepad.</p><label>Editor executable<input value={editorExecutable} onChange={(event) => setEditorExecutable(event.target.value)} placeholder="C:\\Program Files\\Microsoft VS Code\\Code.exe" /></label><label>Arguments (JSON array; use {'{file}'} and {'{project}'} placeholders)<input value={editorArgs} onChange={(event) => setEditorArgs(event.target.value)} spellCheck={false} /></label><button className="primary-button" disabled={saving}><Check size={14} />Save editor</button></form></>}
        {!loading && page === 'Runtimes' && <section className="settings-section"><h3>Detected local runtimes</h3><RuntimeSettingsList runtimes={snapshot?.runtimes ?? []} /><button className="secondary-button settings-action" onClick={onRefresh} disabled={saving}><RefreshCw size={14} />Refresh detected runtimes</button><h3>Custom runtime profiles</h3><RuntimeProfiles value={data['runtime.profile.list']} onDelete={(id) => void deleteProfile(id)} /><form className="settings-form" onSubmit={(event) => void saveProfile(event)}><h4>Add a profile</h4><label>Profile name<input value={profileName} onChange={(event) => setProfileName(event.target.value)} required /></label><div className="settings-form-row"><label>Provider<select value={profileProvider} onChange={(event) => { setProfileProvider(event.target.value); setProfileProtocol(event.target.value === 'claude' ? 'claude_stream' : event.target.value === 'opencode' ? 'acp' : 'codex_app_server') }}><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="opencode">OpenCode</option></select></label><label>Protocol<select value={profileProtocol} onChange={(event) => setProfileProtocol(event.target.value)}><option value="claude_stream">Claude stream</option><option value="codex_app_server">Codex app-server</option><option value="acp">ACP</option></select></label></div><label>Executable path<input value={profilePath} onChange={(event) => setProfilePath(event.target.value)} placeholder="C:\\Tools\\agent.exe" required /></label><label>Fixed arguments, JSON array<input value={profileArgs} onChange={(event) => setProfileArgs(event.target.value)} spellCheck={false} /></label><button className="primary-button" disabled={saving}><Plus size={14} />Save profile</button></form></section>}
        {!loading && page === 'Agents' && <section className="settings-section"><h3>Agent defaults</h3><p className="settings-intro">Bloblex keeps the original circular character and assigns its own accent by provider. Model and authentication defaults stay with each installed CLI.</p><RuntimeSettingsList runtimes={snapshot?.runtimes ?? []} /><div className="settings-availability"><strong>Project folder</strong><span>Choose a folder when creating each session; no global default is stored.</span></div><div className="settings-availability"><strong>Default model</strong><span>Configured in the provider CLI. Bloblex does not override it.</span></div></section>}
        {!loading && page === 'Permissions' && <section className="settings-section"><h3>Permission handling</h3><p className="settings-intro">Provider requests are shown with the choices returned by that provider. Bloblex sends the selected choice through unchanged.</p><div className="settings-availability"><strong>Global policy defaults</strong><span>Not available in this build. Each permission requires an explicit choice; Bloblex never auto-approves.</span></div><div className="settings-availability"><strong>Pending requests</strong><span>{(snapshot?.permissions ?? []).length} request{(snapshot?.permissions ?? []).length === 1 ? '' : 's'} currently waiting</span></div></section>}
        {!loading && page === 'Usage & budgets' && <section className="settings-section"><h3>Budget policies</h3><BudgetPolicies value={data['budget.list']} onDelete={(id) => void deleteBudget(id)} onToggle={(policy, enabled) => void setBudgetEnabled(policy, enabled)} onEdit={editBudget} /><form className="settings-form" onSubmit={(event) => void saveBudget(event)}><h4>{editingBudgetId ? 'Edit admission policy' : 'Add an admission policy'}</h4><div className="settings-form-row"><label>Scope<select value={budgetScope} onChange={(event) => setBudgetScope(event.target.value)}><option value="global">All runtimes</option><option value="host">This host</option><option value="runtime">Selected runtime</option><option value="agent">Selected provider</option><option value="project">Current project</option><option value="session">Current session</option></select></label><label>Period<select value={budgetPeriod} onChange={(event) => setBudgetPeriod(event.target.value)}><option value="turn">Per turn</option><option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option><option value="year">Yearly</option></select></label></div><div className="settings-form-row"><label>Measure<select value={budgetMetric} onChange={(event) => setBudgetMetric(event.target.value)}><option value="tokens">Tokens</option><option value="input_tokens">Input tokens</option><option value="turns">Turns</option><option value="runtime_minutes">Runtime minutes</option></select></label><label>{budgetMetric === 'runtime_minutes' ? 'Minutes' : budgetMetric === 'turns' ? 'Turns' : budgetMetric === 'input_tokens' ? 'Input token limit' : 'Token limit'}<input type="number" min="1" step="1" value={budgetLimit} onChange={(event) => setBudgetLimit(event.target.value)} required /></label></div><p className="form-hint">These admission limits use the daemon’s known estimates. Cost-based and concurrent-session caps are unavailable because safe admission values are not yet reported.</p><div className="settings-form-actions"><button className="primary-button" disabled={saving}><Check size={14} />{editingBudgetId ? 'Update budget policy' : 'Save budget policy'}</button>{editingBudgetId && <button type="button" className="secondary-button" onClick={() => { setEditingBudgetId(null); setBudgetLimit('') }}>Cancel edit</button>}</div></form><h3>Pricing rules</h3><PricingRules value={data['pricing.list']} onEdit={editPricing} /><form className="settings-form" onSubmit={(event) => void savePricing(event)}><h4>{editingPricingId ? 'Edit pricing override' : 'Add a pricing override'}</h4><div className="settings-form-row"><label>Provider<input value={priceProvider} onChange={(event) => setPriceProvider(event.target.value)} required /></label><label>Canonical model ID<input value={priceModel} onChange={(event) => setPriceModel(event.target.value)} required /></label></div><label>Aliases, comma-separated<input value={priceAliases} onChange={(event) => setPriceAliases(event.target.value)} /></label><div className="settings-form-row"><label>Input cost per million tokens<input type="number" min="0" step="any" value={priceInput} onChange={(event) => setPriceInput(event.target.value)} required /></label><label>Output cost per million tokens<input type="number" min="0" step="any" value={priceOutput} onChange={(event) => setPriceOutput(event.target.value)} required /></label></div><label>Currency<input value={priceCurrency} onChange={(event) => setPriceCurrency(event.target.value)} placeholder="GBP" required /></label><div className="settings-form-actions"><button className="primary-button" disabled={saving}><Plus size={14} />{editingPricingId ? 'Update pricing override' : 'Save pricing override'}</button>{editingPricingId && <button type="button" className="secondary-button" onClick={() => { setEditingPricingId(null); setPriceProvider(''); setPriceModel(''); setPriceAliases(''); setPriceInput(''); setPriceOutput(''); setPriceCurrency('') }}>Cancel edit</button>}</div></form><h3>Subscription plans</h3><SubscriptionPlans value={data['subscription.list']} onEdit={editPlan} /><form className="settings-form" onSubmit={(event) => void savePlan(event)}><h4>{editingPlanId ? 'Edit monthly subscription fee' : 'Add a monthly subscription fee'}</h4><div className="settings-form-row"><label>Provider<input value={planProvider} onChange={(event) => setPlanProvider(event.target.value)} required /></label><label>Currency<input value={planCurrency} onChange={(event) => setPlanCurrency(event.target.value.toUpperCase())} placeholder="GBP" maxLength={3} required /></label></div><div className="settings-form-row"><label>Monthly fee<input type="number" min="0" step="0.01" value={planMonthlyAmount} onChange={(event) => setPlanMonthlyAmount(event.target.value)} required /></label><label>Renewal day<input type="number" min="1" max="31" value={planRenewalDay} onChange={(event) => setPlanRenewalDay(event.target.value)} required /></label></div><div className="settings-form-actions"><button className="primary-button" disabled={saving}><Plus size={14} />{editingPlanId ? 'Update subscription' : 'Save subscription'}</button>{editingPlanId && <button type="button" className="secondary-button" onClick={() => { setEditingPlanId(null); setPlanProvider(''); setPlanCurrency(''); setPlanMonthlyAmount(''); setPlanRenewalDay('1') }}>Cancel edit</button>}</div><p className="form-hint">Fixed monthly fees are never added to API-rate estimates. Quota stays unknown unless reported.</p></form></section>}
        {!loading && page === 'WSL' && <section className="settings-section"><h3>Windows Subsystem for Linux</h3><p className="settings-intro">WSL distributions and their installed CLIs are reported by runtime discovery. Bloblex will not start or modify a distribution from this screen.</p>{(snapshot?.hosts ?? []).filter((host) => host.kind === 'wsl').length ? (snapshot?.hosts ?? []).filter((host) => host.kind === 'wsl').map((host) => <div className="host-row" key={String(host.id)}><Laptop size={16} /><span><strong>{String(host.name ?? host.id ?? 'WSL distribution')}</strong><small>{labelize(host.status, 'Unknown')}</small></span><span className={`status-dot ${statusClass(String(host.status ?? ''))}`} /></div>) : <div className="host-empty"><Terminal size={18} /><strong>No WSL runtime reported</strong><span>The daemon has not reported a configured WSL host. Refresh discovery to check again.</span></div>}<button className="secondary-button settings-action" onClick={onRefresh} disabled={saving}><RefreshCw size={14} />Discover runtimes</button></section>}
        {!loading && page === 'Updates' && <section className="settings-section"><h3>Updates and distribution</h3><div className="release-status"><ShieldAlert size={17} /><span><strong>Local build, unsigned</strong><small>Updater is disabled until signing keys and an update endpoint are configured.</small></span></div><p className="settings-intro">Local NSIS and MSI packaging is available. Public Windows distribution requires an approved code-signing identity or Store submission. Bloblex does not update provider CLIs.</p></section>}
        {!loading && page === 'Developer' && <section className="settings-section"><h3>Runtime diagnostics</h3><SettingData method="daemon.health" value={data['daemon.health']} /><h4>Detected runtime state</h4><SettingData method="runtime.list" value={snapshot?.runtimes ?? []} /><p className="settings-intro">Diagnostics shown here come from the local daemon. Prompts and provider credentials are excluded by the IPC contract.</p><button className="secondary-button settings-action" onClick={() => void load()} disabled={loading}><RefreshCw size={14} />Refresh diagnostics</button></section>}
      </div>
    </div>
  </section></div>
}

function SettingsRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <div className="settings-row"><span><strong>{title}</strong><small>{description}</small></span>{children}</div>
}

function RuntimeSettingsList({ runtimes }: { runtimes: Runtime[] }) {
  if (!runtimes.length) return <p className="settings-data-empty">No installed runtime was reported. Use Find an agent to scan again.</p>
  return <div className="settings-entity-list">{runtimes.map((item) => <article className="settings-entity" key={item.id}><span className="settings-entity-dot" style={{ background: providerColor(item.provider) }} /><span className="settings-entity-main"><strong>{labelize(item.provider)}</strong><small>{labelize(item.status, 'Status unknown')} · {labelize(item.authState, 'Auth unknown')} · {item.version ?? 'Version unknown'}</small><small className="settings-entity-path">{item.executablePath ?? 'Executable path unavailable'}</small></span></article>)}</div>
}

function RuntimeProfiles({ value, onDelete }: { value: unknown; onDelete: (id: string) => void }) {
  const profiles = records(value)
  if (!profiles.length) return <p className="settings-data-empty">No custom profiles saved.</p>
  return <div className="settings-entity-list">{profiles.map((profile, index) => <article className="settings-entity" key={String(profile.id ?? index)}><span className="settings-entity-main"><strong>{String(profile.name ?? profile.provider ?? 'Runtime profile')}</strong><small>{labelize(profile.protocolFamily)} · {profile.hostId ? String(profile.hostId) : 'Local host'}</small><small className="settings-entity-path">{String(profile.executablePath ?? 'Executable unavailable')}</small></span>{typeof profile.id === 'string' && <button className="settings-row-action danger" onClick={() => onDelete(profile.id as string)}>Remove</button>}</article>)}</div>
}

function BudgetPolicies({ value, onDelete, onToggle, onEdit }: { value: unknown; onDelete: (id: string) => void; onToggle: (policy: Record<string, unknown>, enabled: boolean) => void; onEdit: (policy: Record<string, unknown>) => void }) {
  const policies = records(value)
  if (!policies.length) return <p className="settings-data-empty">No budget policies configured.</p>
  const supported = new Set(['tokens', 'input_tokens', 'turns', 'runtime_minutes'])
  return <div className="settings-entity-list">{policies.map((policy, index) => {
    const metric = String(policy.metric ?? 'tokens')
    const enabled = policy.enabled !== false
    const limit = metric === 'cost_minor' || metric.endsWith('_cost_minor') ? moneyMinor(policy.hardLimit, policy.currency) : tokenValue(Number(policy.hardLimit))
    const consumed = typeof policy.consumed === 'number' ? policy.consumed : null
    const reserved = typeof policy.reserved === 'number' ? policy.reserved : null
    const remaining = typeof policy.remaining === 'number' ? tokenValue(policy.remaining) : 'Unknown'
    const amountLabel = ['turns', 'runtime_minutes'].includes(metric) ? metric === 'turns' ? 'turns' : 'minutes' : 'tokens'
    return <article className="settings-entity budget-policy" key={String(policy.id ?? index)}>
      <span className={`budget-policy-state ${enabled ? 'enabled' : ''}`} aria-label={enabled ? 'Enabled' : 'Paused'} />
      <span className="settings-entity-main"><strong>{labelize(policy.scopeType, 'Global')} {metric === 'tokens' ? 'token cap' : labelize(metric)} · {labelize(policy.period)}</strong>
        <small>Limit {limit} · {enabled && supported.has(metric) ? 'checked at prompt admission' : enabled ? 'cannot be safely enforced; prompts may be blocked' : 'paused'}</small>
        {supported.has(metric) && <small>Used {consumed === null ? 'Unknown' : `${tokenValue(consumed)} ${amountLabel}`} · reserved {reserved === null ? 'Unknown' : tokenValue(reserved)} · remaining {remaining}</small>}
        {!supported.has(metric) && <small>Unsupported admission metric: remove this policy to avoid blocking new prompts.</small>}
      </span>
      <span className="settings-entity-actions">{supported.has(metric) && typeof policy.id === 'string' && <><button className="settings-row-action" onClick={() => onEdit(policy)}>Edit</button><button className="settings-row-action" onClick={() => onToggle(policy, !enabled)}>{enabled ? 'Pause' : 'Enable'}</button></>}{typeof policy.id === 'string' && <button className="settings-row-action danger" onClick={() => onDelete(policy.id as string)}>Remove</button>}</span>
    </article>
  })}</div>
}

function PricingRules({ value, onEdit }: { value: unknown; onEdit: (rule: Record<string, unknown>) => void }) {
  const rules = records(value)
  if (!rules.length) return <p className="settings-data-empty">No pricing rules available. Costs will remain unknown until a rule is configured.</p>
  return <div className="settings-entity-list">{rules.map((rule, index) => <article className="settings-entity" key={String(rule.id ?? index)}><span className="settings-entity-main"><strong>{String(rule.provider ?? 'Provider')} · {String(rule.canonicalModelId ?? 'Model')}</strong><small>Input {moneyMajor(rule.inputPerMillion, rule.currency)} / 1M · output {moneyMajor(rule.outputPerMillion, rule.currency)} / 1M</small><small>{rule.isUserOverride ? 'User override' : 'Catalog rule'} · {String(rule.effectiveFrom ?? 'effective date unknown')}</small></span>{typeof rule.id === 'string' && <span className="settings-entity-actions"><button className="settings-row-action" onClick={() => onEdit(rule)}>Edit</button></span>}</article>)}</div>
}

function SubscriptionPlans({ value, onEdit }: { value: unknown; onEdit: (plan: Record<string, unknown>) => void }) {
  const plans = records(value)
  if (!plans.length) return <p className="settings-data-empty">No subscription fees configured.</p>
  return <div className="settings-entity-list">{plans.map((plan, index) => <article className="settings-entity" key={String(plan.id ?? index)}><span className="settings-entity-main"><strong>{String(plan.provider ?? 'Provider subscription')}</strong><small>{moneyMinor(plan.monthlyMinor, plan.currency)} / month · renewal day {typeof plan.renewalDay === 'number' ? plan.renewalDay : 'unknown'}</small><small>Quota {String(plan.quotaState ?? 'unknown')} · fee entered by you</small></span>{typeof plan.id === 'string' && <span className="settings-entity-actions"><button className="settings-row-action" onClick={() => onEdit(plan)}>Edit</button></span>}</article>)}</div>
}

function moneyMajor(value: unknown, currency: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return 'Unknown'
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 6 }).format(value) } catch { return 'Unknown' }
}

function SettingData({ method, value }: { method: string; value: unknown }) {
  const data = recordFrom(value)
  if (data.loadError) return <p className="settings-data-error">{String(data.loadError)}</p>
  const list = listFrom(value)
  if (list.length === 0) return <p className="settings-data-empty">No {method.startsWith('pricing') ? 'pricing rules' : method.startsWith('budget') ? 'budget policies' : method.startsWith('subscription') ? 'plans' : method.startsWith('runtime.profile') ? 'saved profiles' : 'details'} reported.</p>
  return <div className="settings-data-list">{list.slice(0, 12).map((item, index) => <div className="settings-data-row" key={String(item.id ?? item.name ?? index)}><strong>{String(item.name ?? item.title ?? item.canonicalModelId ?? item.provider ?? item.id ?? 'Runtime detail')}</strong><small>{String(item.status ?? item.state ?? item.scopeType ?? item.protocolFamily ?? item.version ?? JSON.stringify(item))}</small></div>)}</div>
}

function recordFrom(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function listFrom(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
  const record = recordFrom(value)
  const list = Object.values(record).find((item) => Array.isArray(item))
  return Array.isArray(list) ? list.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : []
}

function toMinorUnits(amount: number, currency: string) {
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid currency code')
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  const result = Math.round(amount * (10 ** digits))
  if (!Number.isSafeInteger(result)) throw new Error('Amount is outside the supported range')
  return result
}

function minorToMajor(value: unknown, currency: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const fractionDigits = new Intl.NumberFormat(undefined, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  return value / (10 ** fractionDigits)
}

function Companion({ runtime, runtimes, session, usage, connected, appError, activityLabel, budgetWarning, permission, onReply, onNewSession, onOpenMain, onOpenSettings, onSendPrompt, onCancelTurn, onSelectRuntime }: { runtime: Runtime | null; runtimes: Runtime[]; session: Session | null; usage?: Record<string, unknown>; connected: boolean; appError: string | null; activityLabel: string; budgetWarning: boolean; permission?: PermissionRequest; onReply: (permission: PermissionRequest, choice: string) => void; onNewSession: () => void; onOpenMain: () => void; onOpenSettings: () => void; onSendPrompt: (sessionId: string, text: string) => Promise<unknown>; onCancelTurn: (sessionId: string) => Promise<unknown>; onSelectRuntime: (runtimeId: string) => void }) {
  const choices = permission?.choices ?? []
  const [view, setView] = useState<'overview' | 'chat' | 'activity' | 'settings'>('overview')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [confused, setConfused] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const [droppedFile, setDroppedFile] = useState<string | null>(null)
  const [fileInfo, setFileInfo] = useState<{ path: string; fileName: string; sizeBytes: number } | null>(null)
  const [preparingFile, setPreparingFile] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [soundsEnabled, setSoundsEnabled] = useState(false)
  const [soundError, setSoundError] = useState<string | null>(null)
  const [dropError, setDropError] = useState<string | null>(null)
  const fileRequest = useRef(0)
  const viewBeforeConfused = useRef<typeof view>('overview')
  const viewBeforeDrop = useRef<typeof view>('overview')
  const viewRef = useRef(view)
  const droppedFileRef = useRef(droppedFile)
  const permissionRef = useRef(permission)
  const sessionRef = useRef(session)
  viewRef.current = view
  droppedFileRef.current = droppedFile
  permissionRef.current = permission
  sessionRef.current = session
  const latestTool = session?.tools?.at(-1)
  const derived = deriveCompanionStatus({ connected, runtime, session, permissionPending: !!permission, budgetWarning, composing: !!draft.trim() })
  const displayMood = derived.mood
  const activity = derived.mood === 'listening' ? derived.label : activityLabel
  const fileStage = dropActive ? 'drop' : preparingFile ? 'preparing' : fileError ? 'error' : droppedFile ? (sending ? 'sending' : 'ready') : undefined
  const fsmRef = useRef<CompanionFsm | null>(null)
  const capsuleRef = useRef<HTMLDivElement>(null)
  const chatLogRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<CompanionMode>('coucou')
  if (!fsmRef.current) fsmRef.current = new CompanionFsm()
  const tall = mode === 'home' && !permission && (view === 'chat' || view === 'activity')
  const presentation = mode === 'home' && tall ? 'home-chat' : mode
  useEffect(() => {
    const fsm = fsmRef.current!
    fsm.onTransition = (_from, to) => setMode(to)
    fsm.launch()
    return () => { fsm.dispose(); void setCompanionMode('petit') }
  }, [])
  useEffect(() => { void setCompanionMode(presentation) }, [presentation])
  useEffect(() => { fileRequest.current++; setDraft(''); setDroppedFile(null); setFileInfo(null); setPreparingFile(false); setFileError(null); setDropError(null) }, [runtime?.id, session?.id])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (view !== 'overview') { setView('overview'); return }
      if (mode === 'home') fsmRef.current?.forcePetit()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [mode, view])
  useEffect(() => {
    if (!inDesktop) return
    let unlisten: (() => void) | undefined
    let cancelled = false
    void getCurrentWindow().onDragDropEvent(({ payload }) => {
      if (payload.type === 'enter') {
        viewBeforeDrop.current = viewRef.current
        setDropError(null)
        setFileError(null)
        setDropActive(true)
        if (!permissionRef.current) {
          setView('chat')
          fsmRef.current?.forceHome()
        }
      } else if (payload.type === 'over') {
        setDropActive(true)
      } else if (payload.type === 'leave') {
        setDropActive(false)
        if (!droppedFileRef.current && !permissionRef.current) {
          setDropError(null)
          setView(viewBeforeDrop.current)
          if (!permissionRef.current) fsmRef.current?.forcePetit()
        }
      } else if (payload.type === 'drop') {
        setDropActive(false)
        const path = payload.paths[0]
        if (!path) setFileError('Windows did not report a file path. Choose a local file again.')
        else if (!sessionRef.current) setDropError('Open or create a session before attaching a local file. The dropped path was not inspected.')
        else if (permissionRef.current) setDropError('Resolve the pending approval before attaching a local file.')
        else {
          setView('chat')
          fsmRef.current?.forceHome()
          void prepareLocalReference(path)
        }
      }
    }).then((stop) => { if (cancelled) stop(); else unlisten = stop }).catch((reason) => setFileError(messageOf(reason)))
    return () => { cancelled = true; unlisten?.() }
  }, [])
  useEffect(() => {
    const fsm = fsmRef.current!
    if (permission) fsm.forceHome(true)
    else if (fsm.pinned) fsm.forcePetit(true)
  }, [permission?.id])
  useEffect(() => {
    const fsm = fsmRef.current!
    if (!session) return
    if (session.state === 'waiting_permission') fsm.forceHome(true)
    else if (['working', 'starting', 'completed', 'error'].includes(session.state ?? '')) fsm.reveal()
  }, [session?.id, session?.state])
  // The native window springs open / curves shut (Coucou's openSpring and
  // 340 ms close curve); the island content cross-fades with it.
  useEffect(() => {
    const element = capsuleRef.current
    if (!element) return
    element.dataset.entering = 'true'
    const timer = window.setTimeout(() => { delete element.dataset.entering }, 30)
    return () => window.clearTimeout(timer)
  }, [presentation])
  useLayoutEffect(() => {
    const log = chatLogRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [view, session?.id, session?.messages?.length, session?.state])
  const toggleExpanded = () => { if (mode === 'home') fsmRef.current?.forcePetit(); else fsmRef.current?.click() }
  const openView = (next: typeof view) => { setView(next); if (mode !== 'home') fsmRef.current?.forceHome() }
  const detail = permission && (typeof permission.detail === 'string' ? permission.detail : typeof permission.description === 'string' ? permission.description : null)
  const beginConfused = () => { viewBeforeConfused.current = view; setConfused(true); if (mode !== 'home') fsmRef.current?.forceHome() }
  const recoverFromConfused = () => { setConfused(false); setView(viewBeforeConfused.current) }
  const prepareLocalReference = async (path: string) => {
    const request = ++fileRequest.current
    setPreparingFile(true)
    setFileError(null)
    setDropError(null)
    setFileInfo(null)
    setDroppedFile(null)
    try {
      const info = await inspectLocalFile(path)
      if (request !== fileRequest.current) return
      setFileInfo(info)
      setDroppedFile(info.path)
    } catch (reason) {
      if (request === fileRequest.current) setFileError(messageOf(reason))
    } finally {
      if (request === fileRequest.current) setPreparingFile(false)
    }
  }
  const chooseCompanionFile = async () => {
    if (!session) { setDropError('Open or create a session before attaching a local file.'); return }
    try { const path = await selectLocalFile(); if (path) void prepareLocalReference(path) }
    catch (reason) { setFileError(messageOf(reason)) }
  }
  const sendCompanionPrompt = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!session || sending || !connected || session.state === 'waiting_permission') return
    const requested = draft.trim() || (droppedFile ? 'Please inspect this local file.' : '')
    if (!requested) return
    const prompt = droppedFile && fileInfo ? `${requested}\n\nLocal file reference selected by the user: ${fileInfo.fileName} (${fileInfo.path}, ${formatBytes(fileInfo.sizeBytes)}). File contents were not read by Bloblex. The provider may only access this path if its own process permissions and working directory allow it.` : requested
    setSending(true)
    setDropError(null)
    try { await onSendPrompt(session.id, prompt); setDraft(''); setDroppedFile(null); setFileInfo(null); setFileError(null) }
    catch (reason) { if (fileInfo) setFileError(messageOf(reason)); else setDropError(messageOf(reason)) }
    finally { setSending(false) }
  }
  const cancelCompanionTurn = () => {
    if (!session || sending) return
    setSending(true)
    void onCancelTurn(session.id).catch((reason) => setDropError(messageOf(reason))).finally(() => setSending(false))
  }
  const toggleSounds = () => {
    const enabled = !soundsEnabled
    setSoundsEnabled(enabled)
    setCompanionSoundsEnabled(enabled)
    if (enabled) void unlockCompanionAudioFromGesture()
    void rpc('settings.set', { key: 'companion.soundsEnabled', value: enabled })
      .then(() => { setSoundError(null); void emit('bloblex-sounds-changed', enabled)?.catch(() => undefined) })
      .catch((reason) => { setSoundsEnabled(!enabled); setCompanionSoundsEnabled(!enabled); setSoundError(messageOf(reason)) })
  }

  useEffect(() => {
    let cancelled = false
    let receivedSoundUpdate = false
    let unlisten: (() => void) | undefined
    void listen<boolean>('bloblex-sounds-changed', (event) => {
      receivedSoundUpdate = true
      const enabled = event.payload === true
      setSoundsEnabled(enabled)
      setCompanionSoundsEnabled(enabled)
    }).then((stop) => {
      if (cancelled) { stop(); return }
      unlisten = stop
      return rpc<Record<string, unknown>>('settings.get').then((result) => {
        const settings = recordFrom(result.settings ?? result)
        const enabled = settings['companion.soundsEnabled'] === true
        if (!cancelled && !receivedSoundUpdate) { setSoundsEnabled(enabled); setCompanionSoundsEnabled(enabled) }
      }).catch(() => undefined)
    })
    return () => { cancelled = true; unlisten?.() }
  }, [])
  const inputTokens = typeof usage?.inputTokens === 'number' ? usage.inputTokens : null
  const outputTokens = typeof usage?.outputTokens === 'number' ? usage.outputTokens : null
  const tokenGlance = inputTokens !== null && outputTokens !== null ? formatCount(inputTokens + outputTokens) : inputTokens !== null ? `${formatCount(inputTokens)} in · out ?` : outputTokens !== null ? `in ? · ${formatCount(outputTokens)} out` : 'Unknown'
  const apiCost = typeof usage?.apiEstimateMinor === 'number' ? formatMinor(usage.apiEstimateMinor, usage.apiEstimateCurrency) : 'Unknown'
  const actualCost = typeof usage?.providerReportedCostMinor === 'number' ? formatMinor(usage.providerReportedCostMinor, usage.providerReportedCurrency) : 'Unknown'
  const recentMessages = (session?.messages ?? []).slice(-4)
  const recentActivities: Array<Record<string, unknown> & { activityKind: 'tool' | 'file' }> = [
    ...(session?.tools ?? []).slice(-4).map((item): Record<string, unknown> & { activityKind: 'tool' } => ({ ...item, activityKind: 'tool' })),
    ...(session?.files ?? []).slice(-4).map((item): Record<string, unknown> & { activityKind: 'file' } => ({ ...item, activityKind: 'file' })),
  ].sort((a, b) => Number(a['sequence'] ?? 0) - Number(b['sequence'] ?? 0)).slice(-5)
  const color = providerColor(runtime?.provider)
  const name = runtime ? labelize(runtime.provider) : 'Bloblex'
  const peers = runtimes.filter((item) => item.id !== runtime?.id).slice(0, 4)
  const statusLine = confused ? 'A little dizzy… back to normal shortly' : appError ?? fileError ?? dropError ?? (preparingFile ? 'Checking local file access…' : activity)
  const shimmering = ['working', 'thinking', 'tool_activity', 'file_activity'].includes(displayMood)
  const sessionBusy = !!session && ['working', 'starting', 'waiting_permission'].includes(session.state ?? '')
  const wash = displayMood === 'success' ? 'green' : displayMood === 'error' ? 'red' : displayMood === 'rate_limited' || displayMood === 'budget_warning' ? 'amber' : null
  const lastReply = [...(session?.messages ?? [])].reverse().find((message) => message.role !== 'user')
  const tickerLines = [...new Set([
    lastReply ? plainText(String(lastReply.content ?? lastReply.text ?? '')) : null,
    latestTool && typeof latestTool.command === 'string' ? latestTool.command : null,
    activity,
  ].filter((line): line is string => !!line))].slice(-2)
  const focusBlob = (size: number) => <BlobCanvas color={color} size={size} mood={displayMood} fileStage={fileStage} soundCues={soundsEnabled} label={name} onDizzy={beginConfused} onDizzyRecovery={recoverFromConfused} />

  return <main className="companion-root" data-mode={mode} style={{ '--agent-accent': color } as React.CSSProperties} onMouseEnter={() => fsmRef.current?.mouseEntered()} onMouseLeave={() => fsmRef.current?.mouseLeft()}>
    <div ref={capsuleRef} className={`companion-capsule island ${mode}`} data-tauri-drag-region>
      {mode === 'petit' ? <div className="companion-compact" data-tauri-drag-region>
        <button className="compact-bot" aria-label="Open companion home" onClick={() => fsmRef.current?.click()}>{focusBlob(40)}</button>
        <button className="compact-copy" onClick={() => fsmRef.current?.click()}><strong>{name}</strong><span role="status" aria-live="polite" className={shimmering ? 'shimmer' : ''}>{statusLine}</span></button>
        {permission && <ShieldAlert className="companion-alert" size={15} aria-label="Approval required" />}
        {peers.length > 0 && <div className="mini-grid" aria-hidden="true" data-tauri-drag-region>{peers.map((item) => <BlobCanvas key={item.id} color={providerColor(item.provider)} size={15} mini mood={!connected || ['offline', 'error'].includes(item.status ?? '') ? 'offline' : 'idle'} label={labelize(item.provider)} />)}</div>}
        <button className="companion-collapse" aria-label="Expand companion" onClick={() => fsmRef.current?.click()}><ChevronUp size={15} /></button>
      </div> : mode === 'coucou' ? <section className="companion-welcome" aria-label="Bloblex welcome animation" data-tauri-drag-region>
        <BlobCanvas color={color} size={100} mood="idle" soundCues={soundsEnabled} label="Bloblex" greeting onGreetingComplete={() => fsmRef.current?.greetComplete()} />
      </section> : <>
        <header className="island-header" data-tauri-drag-region>
          <nav className="tabs" aria-label="Companion navigation">
            <button className={`tab ${view === 'overview' ? 'on' : ''}`} aria-label="Home" title="Home" onClick={() => openView('overview')}><Home size={13} /></button>
            <button className={`tab ${view === 'chat' ? 'on' : ''}`} aria-label="Chat" title="Chat" onClick={() => openView('chat')}><MessageCircle size={13} /></button>
            <button className={`tab ${view === 'activity' ? 'on' : ''}`} aria-label="Activity" title="Activity" onClick={() => openView('activity')}><Activity size={13} /></button>
            <button className="tab" aria-label="New session" title="New session" disabled={!runtime || !connected} onClick={() => { openView('chat'); onNewSession() }}><Plus size={14} /></button>
          </nav>
          <span className="island-drag" data-tauri-drag-region title="Drag companion" aria-hidden="true" />
          <div className="island-actions">
            <button className={view === 'settings' ? 'on' : ''} aria-label="Settings" title="Settings" onClick={() => openView('settings')}><Settings2 size={14} /></button>
            <button className={soundsEnabled ? 'on' : ''} aria-label={soundsEnabled ? 'Mute companion sounds' : 'Enable companion sounds'} aria-pressed={soundsEnabled} title={soundsEnabled ? 'Mute companion sounds' : 'Enable companion sounds'} onClick={toggleSounds}>{soundsEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}</button>
            <button className="companion-collapse" aria-label="Collapse companion" title="Collapse" disabled={!!permission} onClick={toggleExpanded}><ChevronDown size={15} /></button>
          </div>
        </header>
        {confused && <span className="sr-only" role="status" aria-live="polite">A little dizzy. Returning to normal shortly.</span>}
        <section className="island-views companion-content" aria-hidden={mode !== 'home'} inert={mode !== 'home'}>
          {permission ? <div className="island-card wash amber">
            <span className="card-bot">{focusBlob(56)}</span>
            <div className="card-stack">
              <div className="who-row"><i className="who-dot" style={{ background: color }} /><span className="n">{name}</span><span>needs permission</span></div>
              <div className="title">{formatUnknownSafe(permission.title, 'Approval needed')}</div>
              {(detail ?? permission.command) && <div className="code">{detail ?? permission.command}</div>}
              <div className="actions companion-choices">{choices.map((choice) => <PermissionChoiceButton key={choice} permission={permission} choice={choice} className={`btn ${/deny|reject/.test(choice) ? 'secondary' : 'primary'} companion-permission-choice`} onReply={(value) => onReply(permission, value)}>{permissionChoiceLabel(choice)}</PermissionChoiceButton>)}{session && <button className="btn ghost" onClick={cancelCompanionTurn} disabled={sending}>Cancel turn</button>}</div>
            </div>
          </div> : confused ? <div className="island-card wash pink">
            <span className="card-bot">{focusBlob(62)}</span>
            <div className="card-stack"><div className="title">Too many hits at once.</div><div className="sub">Give me a sec — back to work in three seconds.</div></div>
          </div> : dropActive ? <div className="island-card drop-card over">
            <span className="card-bot">{focusBlob(58)}</span>
            <div className="card-stack"><div className="title">Drop to hand this file to {name}</div><div className="drop-tags"><span>Name</span><span>Size</span><span>Access</span></div><div className="sub">Bloblex checks the path only. It never reads file contents.</div></div>
          </div> : view === 'overview' ? <div className="island-overview">
            <div className={`island-card focus ${wash ? `wash ${wash}` : ''}`}>
              <span className="card-bot">{focusBlob(58)}</span>
              <button className="icon-btn jump" aria-label="Open in Bloblex" title="Open in Bloblex" onClick={onOpenMain}><ArrowUpRight size={9} /></button>
              <div className="card-stack">
                <div className="who"><i className={`status-dot ${connected ? statusClass(runtime?.status) : 'muted'}`} /><span className="name">{name}</span><span className="tool">{formatUnknownSafe(session?.title, session?.projectPath?.split(/[\\/]/).pop() ?? (connected ? 'No active session' : 'Offline'))}</span></div>
                <div className="ticker">{tickerLines.map((line, index) => <div key={index} className={`ticker-row ${index === tickerLines.length - 1 ? 'current' : ''}`}><span className={index === tickerLines.length - 1 && shimmering ? 'shimmer' : ''}>{line}</span></div>)}</div>
                <div className="glance" title={`Input ${inputTokens === null ? 'unknown' : inputTokens.toLocaleString()} · Output ${outputTokens === null ? 'unknown' : outputTokens.toLocaleString()} · API estimate ${apiCost}`}><span>Tokens <b>{tokenGlance}</b></span><span>Cost <b>{actualCost}</b></span></div>
              </div>
            </div>
            <div className="island-card pills-card">
              {runtimes.length === 0 ? <p className="companion-empty">No coding agents discovered yet.</p> : <div className="pills">{runtimes.slice(0, 4).map((item) => <button key={item.id} className={`pill ${item.id === runtime?.id ? 'on' : ''}`} style={{ '--pill': providerColor(item.provider) } as React.CSSProperties} onClick={() => onSelectRuntime(item.id)}><BlobCanvas color={providerColor(item.provider)} size={22} mini mood={!connected || ['offline', 'error'].includes(item.status ?? '') ? 'offline' : 'idle'} label={labelize(item.provider)} /><span className="lbl">{labelize(item.provider)}</span></button>)}</div>}
            </div>
          </div> : view === 'chat' ? <div className="island-card chat-card companion-chat-view">
            <span className="card-bot small">{focusBlob(44)}</span>
            <div className="chat-body">
              <div className="chat-log" ref={chatLogRef}>
                {!session && <p className="companion-empty companion-no-session">Open or create a session to chat here. <button type="button" disabled={!runtime || !connected} onClick={() => void onNewSession()}>New session</button></p>}
                {recentMessages.map((message, index) => <div key={String(message.id ?? index)} className={`chat-row ${message.role === 'user' ? 'user' : ''}`}>{message.role === 'user' ? <div className="bubble">{String(message.content ?? message.text ?? '')}</div> : <div className="reply">{plainText(String(message.content ?? message.text ?? '')) || 'Message content unavailable.'}</div>}</div>)}
                {session && recentMessages.length === 0 && <p className="companion-empty">No messages in this conversation yet.</p>}
                {sessionBusy && session?.state !== 'waiting_permission' && <div className="typing" aria-label={`${name} is working`}><i /><i /><i /></div>}
              </div>
              {droppedFile && fileInfo && <div className="chip settled companion-file-ready"><Paperclip size={11} /><span><strong>{fileInfo.fileName}</strong> · {formatBytes(fileInfo.sizeBytes)} · path only</span><button aria-label="Remove local file reference" onClick={() => { fileRequest.current++; setDroppedFile(null); setFileInfo(null); setPreparingFile(false); setFileError(null) }}><X size={11} /></button></div>}
              {preparingFile && <p className="companion-file-note" role="status">Checking the selected path is a readable file… <button type="button" onClick={() => { fileRequest.current++; setPreparingFile(false); setFileInfo(null); setDroppedFile(null) }}>Cancel</button></p>}
              {(fileError ?? dropError ?? appError) && <p className="companion-drop-error" role="alert">{fileError ?? dropError ?? appError}</p>}
              <form className="chat-bar companion-chat-composer" onSubmit={(event) => void sendCompanionPrompt(event)}>
                <button type="button" className="companion-attach" aria-label="Choose a local file" title="Choose a local file" onClick={() => void chooseCompanionFile()} disabled={!connected || !session || preparingFile}><Paperclip size={13} /></button>
                <textarea className="chat-input" aria-label="Message agent" placeholder={connected ? `Ask ${name}…` : 'Daemon disconnected'} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} disabled={!connected || !session || sending || session.state === 'waiting_permission'} rows={1} />
                <button className="send-btn" type={sessionBusy ? 'button' : 'submit'} disabled={!session || sending || preparingFile || (!draft.trim() && !droppedFile && !sessionBusy)} onClick={sessionBusy ? cancelCompanionTurn : undefined} aria-label={sessionBusy ? 'Cancel turn' : 'Send message'}>{sending ? <LoaderCircle size={13} className="spinning" /> : sessionBusy ? <Square size={10} fill="currentColor" /> : <ArrowUp size={14} />}</button>
              </form>
            </div>
          </div> : view === 'activity' ? <div className="island-card list-card companion-activity-view">
            <div className="list-head"><strong>Recent activity</strong><button className="link-btn" onClick={onOpenMain}>View conversation</button></div>
            {recentActivities.length ? recentActivities.map((item, index) => <div key={String(item.id ?? index)} className="companion-activity-row"><span className={`activity-mark ${item.activityKind}`} /><span><strong>{formatUnknownSafe(item.title, formatUnknownSafe(item.path, item.activityKind === 'file' ? 'File change' : 'Agent activity'))}</strong><small>{formatUnknownSafe(item.state, formatUnknownSafe(item.operation, 'Reported'))}{typeof item.command === 'string' ? ` · ${item.command}` : ''}</small></span></div>) : <p className="companion-empty">No tool or file changes reported for this session.</p>}
          </div> : <div className="island-card companion-settings-view">
            <div className="card-stack wide">
              <div className="settings-rows">
                <div className="settings-line"><span>Companion sounds</span><button className={`switch ${soundsEnabled ? 'on' : ''}`} role="switch" aria-checked={soundsEnabled} aria-label="Companion sounds" onClick={toggleSounds} /></div>
                <div className="settings-line"><span>Drag the island by its header to place it anywhere.</span></div>
              </div>
              {soundError && <p className="companion-drop-error" role="alert">{soundError}</p>}
              <div className="actions"><button className="btn primary" onClick={onOpenSettings}>Open Bloblex settings</button><button className="btn secondary" onClick={() => void setCompanionVisibility(false)}>Hide companion</button></div>
            </div>
          </div>}
        </section>
      </>}
    </div>
  </main>
}

function fileNameForPath(path: string) { return path.split('\\').pop()?.split('/').pop() ?? path }

function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB` }

function formatCount(value: number) { return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value) }
function formatMinor(value: number, currency: unknown) {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return 'Unknown'
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: digits }).format(value / (10 ** digits))
}

function permissionChoiceLabel(choice: string) {
  if (choice === 'allow_once') return 'Allow once'
  if (choice === 'allow_session') return 'Allow this session'
  if (choice === 'deny') return 'Deny'
  if (choice === 'reject_once') return 'Reject once'
  if (choice === 'reject_always') return 'Reject always'
  return labelize(choice)
}

function statusClass(status?: string) {
  if (status === 'online' || status === 'ready' || status === 'available' || status === 'connected') return 'good'
  if (status === 'busy' || status === 'working') return 'busy'
  if (status === 'error' || status === 'offline' || status === 'disconnected') return 'bad'
  return 'muted'
}

function messageOf(reason: unknown) {
  if (reason instanceof Error) return reason.message
  return typeof reason === 'string' ? reason : 'The local daemon request failed.'
}
