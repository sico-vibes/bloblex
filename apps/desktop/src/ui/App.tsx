import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { emit, listen } from '@tauri-apps/api/event'
import {
  Activity, ArrowUp, ArrowUpRight, ChevronDown, ChevronUp, CircleHelp, Code2, Copy, FileText, FolderOpen,
  Gauge, Home, LoaderCircle, MessageCircle, MoreHorizontal, PanelRight, Paperclip, Play, Plus,
  RefreshCw, Settings2, ShieldAlert, Square, SquarePen, Terminal, Volume2, VolumeX, X,
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
import { applyEvent, formatUnknownSafe, isPermissionReplyAllowed, labelize, type Agent, type ConnectionState, type DaemonEvent, type PermissionRequest, type Runtime, type Session, type Snapshot } from '../types'
import { agentColorHex } from './agentColor'
import { AgentRoster } from './AgentRoster'
import { ProjectChooser } from './ProjectChooser'
import { effectiveApprovalMode } from '../approvalContract'
import type { ExecutionSendGate } from '../executionContract'
import { parseExecSnapshot } from '../executionContract'
import { turnFailureTitle } from './analyticsFormat'
import { createDraft, createParams, daemonCodeOf, draftFromAgent, duplicateParams, executionFromAgent, isAgentDirty, messageForDaemonCode, updateParams, validateAgentDraft, type AgentDraft } from './agentForm'
import { activeAgents, agentSessions, agentsForRuntime, companionPills, duplicateAgentName, emptyExpandedState, garbageCollectExpanded, legacySessions, nextAgentAfterArchive, parseExpandedState, projectFolderName, projectGroups, projectKey, recentProjects, runtimeUsable, sessionDisplayTitle, sessionForSelection, sessionNewParams, sessionSelectionTarget, type ExpandedState } from './rosterSelectors'
import { AnalyticsView } from './AnalyticsView'
import { ApprovalPill } from './approvalUi'
import { BlobPage, ConfirmDialog } from './BlobPage'
import { UpdateAvailableBanner, useMainUpdateOffer } from './UpdateBanner'
import { SettingsSheet, type SettingsPageId } from './SettingsSheet'
import { ProfileMenu } from './ProfileMenu'
import { Select } from './Select'
import { useClock } from './useClock'
import { stampCompanionDragRegions } from './companionDrag'
import { ensureDaemon, fetchSnapshot, getActiveRuntime, getActiveSession, inDesktop, inspectLocalFile, listenForActiveRuntime, listenForActiveSession, listenForDaemonConnection, listenForDaemonEvents, listenForOpenSettings, openInEditor, openProjectFolder, quitBloblex, refreshTrayMenu, resolveProjectFile, revealInExplorer, rpc, selectLocalFile, setActiveRuntime, setActiveSession, setCompanionMode, setCompanionVisibility, showMainSettings, showMainWindow, startDaemonEventStream } from '../tauri'

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
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [blobPage, setBlobPage] = useState<{ mode: 'create' | 'edit'; agentId: string | null } | null>(null)
  const [analyticsOpen, setAnalyticsOpen] = useState(false)
  const [draft, setDraft] = useState<AgentDraft | null>(null)
  const [baseline, setBaseline] = useState<AgentDraft | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [remoteNotice, setRemoteNotice] = useState<string | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<Agent | null>(null)
  const [rosterAnnouncement, setRosterAnnouncement] = useState('')
  const [archiveNotice, setArchiveNotice] = useState<string | null>(null)
  const [tab, setTab] = useState<ContextTab>('Details')
  const [composer, setComposer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [usageSheet, setUsageSheet] = useState(false)
  const [usagePeriod, setUsagePeriod] = useState<'today' | 'month'>('today')
  const [settingsSheet, setSettingsSheet] = useState(false)
  const [settingsInitialPage, setSettingsInitialPage] = useState<SettingsPageId>('General')
  const [settingsFocus, setSettingsFocus] = useState<null | 'updates'>(null)
  const updateOffer = useMainUpdateOffer(companion)
  const now = useClock(10_000)
  const executionGate = useRef<ExecutionSendGate>({ model: false, thinking: false, serviceTier: false })
  const [appliedModel, setAppliedModel] = useState<string | null>(null)
  const [diffViewer, setDiffViewer] = useState<{ path: string; content: string } | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [usageSummary, setUsageSummary] = useState<Record<string, unknown> | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const agentEventSeq = useRef(new Map<string, number>())
  const hydrateAgentChanges = useCallback((events: DaemonEvent[]) => {
    for (const event of events) {
      if (event.type !== 'agent.changed' || typeof event.payload?.agentId !== 'string') continue
      const prior = snapshotRef.current
      if (prior && typeof event.sequence === 'number' && typeof prior.sequence === 'number' && event.sequence <= prior.sequence) continue
      const agentId = event.payload.agentId
      const eventSequence = typeof event.sequence === 'number' ? event.sequence : Number.POSITIVE_INFINITY
      const seen = agentEventSeq.current.get(agentId)
      if (seen !== undefined && eventSequence <= seen) continue
      agentEventSeq.current.set(agentId, eventSequence)
      void rpc<{ agent?: Agent }>('agent.get', { agentId }).then(({ agent }) => {
        if (!agent?.id) return
        const latest = agentEventSeq.current.get(agent.id)
        if (latest !== undefined && eventSequence < latest) return
        setSnapshot((current) => {
          if (!current) return current
          const agents = [...(current.agents ?? []).filter((item) => item.id !== agent.id), agent]
            .sort((a, b) => a.runtimeId.localeCompare(b.runtimeId) || a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          return { ...current, agents }
        })
        const page = blobPageRef.current
        if (page?.mode === 'edit' && page.agentId === agent.id && !agent.archived) {
          if (draftDirtyRef.current) setRemoteNotice('This blob changed elsewhere. Save will overwrite those fields, or cancel to load the latest.')
          else {
            const next = draftFromAgent(agent)
            setDraft(next)
            setBaseline(next)
            setRemoteNotice(null)
          }
        }
      }).catch(() => undefined)
    }
  }, [])
  const [budgetAlertActive, setBudgetAlertActive] = useState(false)
  const [permissionClock, setPermissionClock] = useState(() => Date.now())
  const [inspectorOpen, setInspectorOpen] = useState(() => storageFlag('bloblex.inspector.open'))
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<ExpandedState>(() => companion ? emptyExpandedState() : readRosterExpanded())
  const [chooser, setChooser] = useState<{ agentId: string; x: number; y: number } | null>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const messageListRef = useRef<HTMLElement>(null)
  const stickToBottom = useRef(true)
  const queuedEvents = useRef<DaemonEvent[]>([])
  const hydrating = useRef(true)
  const refreshingRef = useRef(false)
  const refreshAgain = useRef(false)
  const snapshotRef = useRef<Snapshot | null>(null)
  const selectedAgentIdRef = useRef<string | null>(null)
  const selectedRuntimeIdRef = useRef<string | null>(null)
  const activeSessionIdRef = useRef<string | null>(null)
  const blobPageRef = useRef(blobPage)
  const usageLinkRef = useRef<HTMLButtonElement>(null)
  const draftDirtyRef = useRef(false)
  const rosterOrderRef = useRef<Agent[]>([])
  const selectionBooted = useRef(false)
  const pendingTreeFocus = useRef<string | null>(null)
  const chooserAnchor = useRef<HTMLElement | null>(null)
  const handledArchiveRef = useRef<string | null>(null)
  snapshotRef.current = snapshot
  selectedAgentIdRef.current = selectedAgentId
  selectedRuntimeIdRef.current = selectedRuntimeId
  activeSessionIdRef.current = activeSessionId
  blobPageRef.current = blobPage
  draftDirtyRef.current = !!(draft && baseline && isAgentDirty(draft, baseline))

  const runtimes = snapshot?.runtimes ?? []
  const sessions = snapshot?.sessions ?? []
  const agents = snapshot?.agents ?? []
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null
  const activeSelectedAgent = selectedAgent && !selectedAgent.archived ? selectedAgent : null
  const selectedRuntime = activeSelectedAgent
    ? runtimes.find((runtime) => runtime.id === activeSelectedAgent.runtimeId) ?? null
    : runtimes.find((runtime) => runtime.id === selectedRuntimeId) ?? runtimes[0] ?? null
  const selectedSession = activeSelectedAgent
    ? sessionForSelection(sessions, activeSelectedAgent, selectedSessionId, activeSessionId)
    : sessions.find((session) => session.id === selectedSessionId && (!selectedRuntime || session.runtimeId === selectedRuntime.id))
      ?? sessions.find((session) => session.id === activeSessionId && (!selectedRuntime || session.runtimeId === selectedRuntime.id))
      ?? sessions.filter((session) => session.runtimeId === selectedRuntime?.id).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0]
      ?? null
  const sessionMessages = selectedSession?.messages ?? selectedSession?.turns?.flatMap((turn) => Array.isArray(turn.messages) ? turn.messages : []) ?? selectedSession?.events ?? []
  const conversationItems = selectedSession ? buildConversationItems(selectedSession) : []
  const activePermission = selectPendingPermission(snapshot?.permissions ?? [], selectedSession?.id, activeSessionId, permissionClock)
  const agentName = activeSelectedAgent?.name ?? (selectedRuntime ? labelize(selectedRuntime.provider) : 'No runtime selected')
  const accent = activeSelectedAgent ? agentColorHex(activeSelectedAgent.color) : ''
  const companionPermission = activePermission ?? undefined
  const companionSessionRecord = sessions.find((session) => session.id === companionPermission?.sessionId)
    ?? selectedSession
  const companionSession = companionSessionRecord
  const companionAgent = agents.find((agent) => agent.id === companionSession?.agentId && !agent.archived) ?? activeSelectedAgent
  const companionRuntime = runtimes.find((runtime) => runtime.id === companionAgent?.runtimeId) ?? runtimes.find((runtime) => runtime.id === companionSession?.runtimeId) ?? selectedRuntime
  const alertSessionId = typeof snapshot?.latestBudgetAlert?.sessionId === 'string' ? snapshot.latestBudgetAlert.sessionId : null
  const budgetWarningFor = (item: Session | null) => budgetAlertActive && (!alertSessionId || alertSessionId === item?.id)
  const companionStatus = deriveCompanionStatus({ connected: connection === 'connected', runtime: companionRuntime, session: companionSession, permissionPending: !!companionPermission, budgetWarning: budgetWarningFor(companionSession), now })
  const previousCueMood = useRef<string | null>(null)
  const previousPermissionCue = useRef<string | null>(null)
  const selectedBudget = findApplicableBudget(snapshot?.budgets, selectedRuntime, selectedSession, selectedRuntime?.hostId)
  const currentProjectName = selectedSession?.projectPath?.split(/[\\/]/).filter(Boolean).pop()
  const headerAgent = selectedSession
    ? (selectedSession.agentId ? agents.find((agent) => agent.id === selectedSession.agentId) ?? null : null)
    : activeSelectedAgent
  const headerMode = effectiveApprovalMode(headerAgent)
  const companionMode = effectiveApprovalMode(companionAgent)

  useEffect(() => {
    const sessionId = selectedSession?.id
    if (!sessionId) { setAppliedModel(null); return }
    let cancelled = false
    rpc('exec.snapshot.latest', { sessionId }).then((result) => {
      if (!cancelled) setAppliedModel(parseExecSnapshot(result)?.appliedModelId ?? null)
    }).catch(() => { if (!cancelled) setAppliedModel(null) })
    return () => { cancelled = true }
  }, [selectedSession?.id])

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
      hydrateAgentChanges(queued)
      setConnection(new URLSearchParams(location.search).has('disconnected') ? 'disconnected' : 'connected')
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
  }, [hydrateAgentChanges])

  useEffect(() => {
    if (!activePermission?.sessionId) return
    const target = sessions.find((item) => item.id === activePermission.sessionId)
    if (!target) return
    if (target.agentId) {
      const owner = (snapshot?.agents ?? []).find((agent) => agent.id === target.agentId && !agent.archived)
      if (owner && owner.id !== selectedAgentId) setSelectedAgentId(owner.id)
    }
    if (target.runtimeId !== selectedRuntimeId) setSelectedRuntimeId(target.runtimeId)
    if (target.id !== selectedSessionId) setSelectedSessionId(target.id)
    if (target.id !== activeSessionId) {
      setActiveSessionId(target.id)
      void setActiveSession(target.id)
      void setActiveRuntime(target.runtimeId)
    }
  }, [activePermission?.id, activePermission?.sessionId, sessions, selectedRuntimeId, selectedSessionId, activeSessionId, selectedAgentId, snapshot?.agents])

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
      else {
        setSnapshot((current) => current ? applyEvent(current, event) : current)
        hydrateAgentChanges([event])
      }
    }).then((stop) => { if (cancelled) stop(); else unlistenEvents = stop })
    void listenForDaemonConnection((connected) => {
      if (connected && hydrating.current) return
      setConnection(connected ? 'connected' : 'disconnected')
      if (connected) setError(null)
    }).then((stop) => { if (cancelled) stop(); else unlistenConnection = stop })
    return () => { cancelled = true; unlistenEvents?.(); unlistenConnection?.() }
  }, [hydrateAgentChanges])

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
        setConnection(new URLSearchParams(location.search).has('disconnected') ? 'disconnected' : 'connected')
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
    void listenForActiveRuntime((runtimeId) => {
      const list = snapshotRef.current?.agents ?? []
      const current = list.find((agent) => agent.id === selectedAgentIdRef.current)
      if (!current) { setSelectedRuntimeId(runtimeId); return }
      if (!runtimeId || current.runtimeId === runtimeId) return
      const next = agentsForRuntime(list, runtimeId)[0]
      if (!next) return
      setSelectedAgentId(next.id)
      setSelectedRuntimeId(next.runtimeId)
      setSelectedSessionId(agentSessions(snapshotRef.current?.sessions ?? [], next.id)[0]?.id ?? null)
    }).then((stop) => { if (cancelled) stop(); else unlisten = stop })
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
    void listenForActiveSession((sessionId) => {
      setActiveSessionId(sessionId)
      if (!sessionId) { setSelectedSessionId(null); return }
      const session = snapshotRef.current?.sessions?.find((item) => item.id === sessionId)
      if (!session) { setSelectedSessionId(sessionId); return }
      if (session.agentId) {
        const owner = (snapshotRef.current?.agents ?? []).find((agent) => agent.id === session.agentId && !agent.archived)
        if (owner) { setSelectedAgentId(owner.id); setSelectedRuntimeId(owner.runtimeId) }
        setSelectedSessionId(session.id)
        return
      }
      setSelectedSessionId(session.id)
      const current = (snapshotRef.current?.agents ?? []).find((agent) => agent.id === selectedAgentIdRef.current)
      if (current && current.runtimeId !== session.runtimeId) {
        const next = agentsForRuntime(snapshotRef.current?.agents ?? [], session.runtimeId)[0]
        if (next) { setSelectedAgentId(next.id); setSelectedRuntimeId(next.runtimeId) }
      }
    }).then((stop) => { if (cancelled) stop(); else unlisten = stop })
    return () => { cancelled = true; unlisten?.() }
  }, [])

  useEffect(() => {
    if (!activeSelectedAgent && selectedSession && selectedSession.runtimeId !== selectedRuntimeId) setSelectedRuntimeId(selectedSession.runtimeId)
    if (selectedSession && selectedSession.id !== activeSessionId) {
      setActiveSessionId(selectedSession.id)
      void setActiveSession(selectedSession.id)
    } else if (!selectedSession && selectedSessionId === null && activeSessionId !== null) {
      setActiveSessionId(null)
      void setActiveSession(null)
    }
  }, [activeSelectedAgent, selectedSession, selectedRuntimeId, activeSessionId, selectedSessionId])

  useEffect(() => {
    if (!snapshot || selectionBooted.current) return
    selectionBooted.current = true
    const list = snapshot.agents ?? []
    const active = activeAgents(list)
    if (!active.length) return
    const storedId = readStoredAgentId()
    const stored = storedId ? active.find((agent) => agent.id === storedId) : undefined
    const onRuntime = selectedRuntimeIdRef.current ? agentsForRuntime(list, selectedRuntimeIdRef.current)[0] : undefined
    const agent = stored ?? onRuntime ?? active[0]
    if (!agent) return
    setSelectedAgentId(agent.id)
    setSelectedRuntimeId(agent.runtimeId)
    const storedSession = (snapshot.sessions ?? []).find((session) => session.id === activeSessionIdRef.current)
    const storedOk = !!storedSession && (storedSession.agentId === agent.id || ((storedSession.agentId == null) && storedSession.runtimeId === agent.runtimeId))
    const nextSession = storedOk ? storedSession : agentSessions(snapshot.sessions ?? [], agent.id)[0]
    setSelectedSessionId(nextSession?.id ?? null)
  }, [snapshot])

  useEffect(() => {
    if (!selectionBooted.current) return
    const active = activeAgents(snapshot?.agents ?? [])
    if (selectedAgentId && active.some((agent) => agent.id === selectedAgentId)) writeStoredAgentId(selectedAgentId)
    else if (!selectedAgentId) writeStoredAgentId(null)
  }, [selectedAgentId, snapshot])

  useEffect(() => {
    let focusTimer = 0
    const list = snapshot?.agents ?? []
    const active = activeAgents(list)
    const editorId = blobPage?.mode === 'edit' ? blobPage.agentId : null
    if (selectedAgentId) {
      const current = list.find((agent) => agent.id === selectedAgentId)
      if (!current || current.archived) {
        if (handledArchiveRef.current !== selectedAgentId) {
          handledArchiveRef.current = selectedAgentId
          const prior = rosterOrderRef.current.some((agent) => agent.id === selectedAgentId)
            ? rosterOrderRef.current
            : activeAgents(list.map((agent) => agent.id === selectedAgentId ? { ...agent, archived: false } : agent))
          const name = current?.name || prior.find((agent) => agent.id === selectedAgentId)?.name || 'Blob'
          const next = nextAgentAfterArchive(prior, selectedAgentId)
          const nextSession = next ? agentSessions(snapshot?.sessions ?? [], next.id)[0] ?? null : null
          setRosterAnnouncement(next ? `Archived ${name}. Now showing ${next.name}.` : `Archived ${name}. No blobs left.`)
          setSelectedAgentId(next?.id ?? null)
          setSelectedSessionId(nextSession?.id ?? null)
          if (next) setSelectedRuntimeId(next.runtimeId)
          focusTimer = window.setTimeout(() => {
            const node = next
              ? document.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(next.id)}"]`)
              : document.querySelector<HTMLElement>('[aria-label="Create blob"]')
            node?.focus()
          }, 0)
          if (blobPage && blobPage.agentId === selectedAgentId) {
            setArchiveNotice(`Archived “${name}”. Its conversations stay saved. Restoring a blob is not available yet.`)
            setBlobPage(null)
          }
        }
      }
    }
    if (editorId && editorId !== selectedAgentId) {
      const editor = list.find((agent) => agent.id === editorId)
      if (editor?.archived) {
        setArchiveNotice(`Archived “${editor.name}”. Its conversations stay saved. Restoring a blob is not available yet.`)
        setBlobPage(null)
      }
    }
    rosterOrderRef.current = active
    return () => window.clearTimeout(focusTimer)
  }, [snapshot, selectedAgentId, blobPage])

  useEffect(() => {
    if (companion || !snapshot) return
    setExpanded((current) => {
      const next = garbageCollectExpanded(current, snapshot.agents, snapshot.sessions)
      if (next === current) return current
      writeRosterExpanded(next)
      return next
    })
  }, [companion, snapshot])

  useEffect(() => {
    const id = pendingTreeFocus.current
    if (!id) return
    const node = document.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(id)}"]`)
    if (!node) return
    node.focus()
    pendingTreeFocus.current = null
  })

  const doRpc = useCallback(async <T,>(method: string, params: Record<string, unknown> = {}, mapError?: (reason: unknown) => string) => {
    setBusy(true)
    setError(null)
    try {
      const result = await rpc<T>(method, params)
      return result
    } catch (reason) {
      setError(mapError ? mapError(reason) : messageOf(reason))
      throw reason
    } finally {
      setBusy(false)
    }
  }, [])

  const mergeAgent = (agent: Agent) => {
    setSnapshot((current) => current ? {
      ...current,
      agents: [...(current.agents ?? []).filter((item) => item.id !== agent.id), agent]
        .sort((a, b) => a.runtimeId.localeCompare(b.runtimeId) || a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    } : current)
  }

  const openEdit = (agent: Agent) => {
    setAnalyticsOpen(false)
    const next = draftFromAgent(agent)
    setDraft(next)
    setBaseline(next)
    setFormError(null)
    setRemoteNotice(null)
    setBlobPage({ mode: 'edit', agentId: agent.id })
    if (agent.id !== selectedAgentId) {
      setSelectedAgentId(agent.id)
      setSelectedRuntimeId(agent.runtimeId)
      const owned = agentSessions(sessions, agent.id)
      const current = sessions.find((session) => session.id === selectedSessionId)
      if (!current || current.agentId !== agent.id) setSelectedSessionId(owned[0]?.id ?? null)
    }
  }

  const openCreate = () => {
    setAnalyticsOpen(false)
    const next = createDraft(runtimes, activeSelectedAgent?.runtimeId ?? selectedRuntime?.id ?? null)
    setDraft(next)
    setBaseline(next)
    setFormError(null)
    setRemoteNotice(null)
    setBlobPage({ mode: 'create', agentId: null })
  }

  const closeAnalytics = () => {
    setAnalyticsOpen(false)
    window.setTimeout(() => usageLinkRef.current?.focus(), 0)
  }

  const closeBlobPage = (focusId: string | null) => {
    setBlobPage(null)
    setFormError(null)
    window.setTimeout(() => {
      const row = focusId ? document.querySelector<HTMLButtonElement>(`[data-agent-id="${CSS.escape(focusId)}"]`) : null
      ;(row ?? document.querySelector<HTMLButtonElement>('[aria-label="Create blob"]'))?.focus()
    }, 0)
  }

  const saveBlob = async () => {
    if (!draft || !baseline) return
    const others = activeAgents(agents).filter((agent) => agent.id !== (blobPage?.mode === 'edit' ? blobPage.agentId : undefined)).map((agent) => agent.name)
    if (Object.keys(validateAgentDraft(draft, others)).length > 0) return
    const editing = blobPage?.mode === 'edit' ? agents.find((agent) => agent.id === blobPage.agentId) ?? null : null
    try {
      if (!editing) {
        const result = await doRpc<{ agent?: Agent }>('agent.create', createParams(draft, executionGate.current), (reason) => messageForDaemonCode(daemonCodeOf(reason), 'agent.create'))
        const agent = result.agent
        if (!agent?.id) return
        mergeAgent(agent)
        const next = draftFromAgent(agent)
        setDraft(next)
        setBaseline(next)
        setFormError(null)
        setRemoteNotice(null)
        setSelectedAgentId(agent.id)
        setSelectedRuntimeId(agent.runtimeId)
        setBlobPage({ mode: 'edit', agentId: agent.id })
        return
      }
      const params = updateParams(editing.id, draft, baseline, executionGate.current)
      if (Object.keys(params).length === 1) return
      const result = await doRpc<{ agent?: Agent }>('agent.update', params, (reason) => messageForDaemonCode(daemonCodeOf(reason), 'agent.update', { archived: editing.archived, sentName: Object.prototype.hasOwnProperty.call(params, 'name') }))
      const agent = result.agent
      if (!agent?.id) return
      mergeAgent(agent)
      const next = draftFromAgent(agent)
      setDraft(next)
      setBaseline(next)
      setFormError(null)
      setRemoteNotice(null)
    } catch (reason) {
      const kind = editing ? 'agent.update' : 'agent.create'
      setFormError(messageForDaemonCode(daemonCodeOf(reason), kind, { archived: editing?.archived === true, sentName: editing ? draft.name !== baseline.name : true }))
      setError(null)
    }
  }

  const duplicateAgent = async (agent: Agent) => {
    const name = duplicateAgentName(agent.name, activeAgents(agents).map((item) => item.name))
    try {
      const result = await doRpc<{ agent?: Agent }>('agent.create', duplicateParams(agent, name), (reason) => messageForDaemonCode(daemonCodeOf(reason), 'agent.create'))
      const created = result.agent
      if (!created?.id) return
      mergeAgent(created)
      setSelectedAgentId(created.id)
      setSelectedRuntimeId(created.runtimeId)
      setSelectedSessionId(null)
    } catch (reason) {
      setError(messageForDaemonCode(daemonCodeOf(reason), 'agent.create'))
    }
  }

  const confirmArchive = async () => {
    const agent = archiveTarget
    if (!agent) return
    setArchiveTarget(null)
    try {
      const result = await doRpc<{ agent?: Agent }>('agent.delete', { agentId: agent.id }, (reason) => messageForDaemonCode(daemonCodeOf(reason), 'agent.delete'))
      if (result.agent?.id) mergeAgent(result.agent)
      else mergeAgent({ ...agent, archived: true })
    } catch (reason) {
      setError(messageForDaemonCode(daemonCodeOf(reason), 'agent.delete'))
    }
  }

  const createSession = async (agent: Agent, projectPath: string, source: 'pinned' | 'recent' | 'browse' | 'project') => {
    const mapError = (reason: unknown) => messageForDaemonCode(daemonCodeOf(reason), 'session.new')
    const trimmedDefault = typeof agent.defaultProject === 'string' ? agent.defaultProject.trim() : ''
    try {
      let path = projectPath
      let result: Session | { session?: Session }
      try {
        result = await doRpc<Session | { session?: Session }>('session.new', sessionNewParams(agent.id, path), mapError)
      } catch (reason) {
        const retryDefault = source === 'pinned' && daemonCodeOf(reason) === 'invalid_argument' && !!trimmedDefault && path === trimmedDefault
        if (!retryDefault) return
        const picked = await openProjectFolder()
        if (!picked) return
        path = picked
        result = await doRpc<Session | { session?: Session }>('session.new', sessionNewParams(agent.id, path), mapError)
      }
      const session = unwrapSession(result)
      if (!session?.id) return
      if (session.agentId) {
        const owner = agents.find((item) => item.id === session.agentId && !item.archived)
        if (owner) { setSelectedAgentId(owner.id); setSelectedRuntimeId(owner.runtimeId) }
      }
      setSelectedSessionId(session.id)
      const ownerId = session.agentId && agents.some((item) => item.id === session.agentId && !item.archived) ? session.agentId : agent.id
      const key = projectKey(session.projectPath ?? path) ?? ''
      if (!companion) {
        setExpanded((current) => {
          const prev = current.blobs[ownerId] ?? { open: false, projects: {}, other: false }
          const next: ExpandedState = { v: 1, blobs: { ...current.blobs, [ownerId]: { open: true, projects: { ...prev.projects, [key]: true }, other: prev.other } } }
          writeRosterExpanded(next)
          return next
        })
      }
      const label = projectGroups(sessions, ownerId).find((group) => group.key === key)?.label ?? projectFolderName(session.projectPath ?? path)
      setRosterAnnouncement(`Started ${sessionDisplayTitle(session)} in ${label}.`)
      pendingTreeFocus.current = session.id
      void refreshTrayMenu().catch(() => undefined)
      await refresh()
    } catch { /* The mapped error is shown inline. */ }
  }

  const newSession = (agentId?: string, anchor?: HTMLElement | null) => {
    const agent = agents.find((item) => item.id === (agentId ?? activeSelectedAgent?.id) && !item.archived)
    const runtime = agent ? runtimes.find((item) => item.id === agent.runtimeId) : null
    if (!agent || connection !== 'connected' || busy || !runtimeUsable(runtime)) return
    if (recentProjects(sessions, agent, 8).length === 0) {
      void openProjectFolder().then((picked) => { if (picked) void createSession(agent, picked, 'browse') })
      return
    }
    const node = anchor ?? document.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(agent.id)}"]`)
    chooserAnchor.current = node
    const rect = node?.getBoundingClientRect()
    setChooser({ agentId: agent.id, x: rect?.left ?? 24, y: rect?.bottom ?? 24 })
  }

  const sendPrompt = async () => {
    const text = composer.trim()
    if (!text || !selectedSession || busy || selectedSession.state === 'waiting_permission' || !runtimeUsable(selectedRuntime)) return
    try {
      await doRpc('session.prompt', { sessionId: selectedSession.id, text })
      setComposer('')
      await refresh()
    } catch { /* The actionable error is shown inline. */ }
  }

  const cancelTurn = async (session: Session | null = selectedSession) => {
    if (!session) return
    try { await doRpc('session.cancel', { sessionId: session.id }); void refreshTrayMenu().catch(() => undefined); await refresh() } catch { /* inline */ }
  }

  const resumeSession = async (session: Session | null = selectedSession) => {
    if (!session?.resumable || busy) return
    try { await doRpc('session.resume', { sessionId: session.id }); void refreshTrayMenu().catch(() => undefined); await refresh() } catch { /* inline */ }
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

  const selectAgent = (agent: Agent) => {
    setAnalyticsOpen(false)
    const latest = agentSessions(sessions, agent.id)[0] ?? null
    setSelectedAgentId(agent.id)
    setSelectedRuntimeId(agent.runtimeId)
    setSelectedSessionId(latest?.id ?? null)
    void setActiveRuntime(agent.runtimeId)
    void setActiveSession(latest?.id ?? null)
    setBlobPage((page) => page && page.agentId !== agent.id ? null : page)
  }
  const selectSession = (session: Session) => {
    setAnalyticsOpen(false)
    const target = sessionSelectionTarget(agents, activeSelectedAgent, session)
    if (!target) return
    const owner = activeAgents(agents).find((item) => item.id === target.agentId)
    if (!owner) return
    if (owner.id !== activeSelectedAgent?.id) {
      setSelectedAgentId(owner.id)
      setSelectedRuntimeId(owner.runtimeId)
      void setActiveRuntime(owner.runtimeId)
      setBlobPage((page) => page && page.agentId !== owner.id ? null : page)
    }
    setSelectedSessionId(target.sessionId)
    void setActiveSession(target.sessionId)
  }
  const patchExpanded = (agentId: string, patch: (entry: { open: boolean; projects: Record<string, boolean>; other: boolean }) => { open: boolean; projects: Record<string, boolean>; other: boolean }) => {
    setExpanded((current) => {
      const prev = current.blobs[agentId] ?? { open: false, projects: {}, other: false }
      const next: ExpandedState = { v: 1, blobs: { ...current.blobs, [agentId]: patch(prev) } }
      if (!companion) writeRosterExpanded(next)
      return next
    })
  }
  const chooserAgent = chooser ? agents.find((item) => item.id === chooser.agentId && !item.archived) ?? null : null
  const closeChooser = () => {
    const node = chooserAnchor.current
    chooserAnchor.current = null
    setChooser(null)
    window.setTimeout(() => node?.focus(), 0)
  }
  const chooserView = chooser && chooserAgent ? <ProjectChooser
    agentName={chooserAgent.name}
    options={recentProjects(sessions, chooserAgent, 8)}
    position={chooser}
    onChoose={(path) => {
      const pinned = typeof chooserAgent.defaultProject === 'string' ? chooserAgent.defaultProject.trim() : ''
      setChooser(null)
      void createSession(chooserAgent, path, path === pinned && pinned ? 'pinned' : 'recent')
    }}
    onBrowse={() => {
      setChooser(null)
      void openProjectFolder().then((picked) => { if (picked) void createSession(chooserAgent, picked, 'browse') })
    }}
    onClose={closeChooser}
  /> : null

  if (companion) {
    return <>
      <Companion agent={companionAgent} agents={agents} runtime={companionRuntime} runtimes={runtimes} session={companionSession} usage={snapshot?.usageSummary} connected={connection === 'connected'} appError={error} activityLabel={companionStatus.label} budgetWarning={budgetWarningFor(companionSession)} permission={companionPermission} approvalMode={companionMode} onReply={answerPermission} onNewSession={(anchor) => newSession(companionAgent?.id, anchor)} onOpenMain={() => void showMainWindow(companionSession?.id)} onOpenSettings={() => void showMainSettings(companionSession?.id)} onSendPrompt={(sessionId, text) => doRpc('session.prompt', { sessionId, text }).then(() => { void refreshTrayMenu().catch(() => undefined); return refresh() })} onCancelTurn={(sessionId) => doRpc('session.cancel', { sessionId }).then(() => { void refreshTrayMenu().catch(() => undefined); return refresh() })} onSelectAgent={selectAgent} />
      {chooserView}
    </>
  }

  const selectedMood = deriveCompanionStatus({ connected: connection === 'connected', runtime: selectedRuntime, session: selectedSession, budgetWarning: budgetWarningFor(selectedSession), composing: !!composer.trim(), now }).mood
  const sessionBusy = ['working', 'starting', 'waiting_permission'].includes(selectedSession?.state ?? '')
  const turnLive = ['working', 'waiting_permission'].includes(selectedSession?.state ?? '')
  const runtimeReady = runtimeUsable(selectedRuntime)
  const canStartSession = connection === 'connected' && !busy && !!activeSelectedAgent && runtimeReady
  const lastAgentIndex = conversationItems.reduce((last, item, index) => item.kind === 'message' && !isUserMessage(item.value) ? index : last, -1)
  // The details panel describes the open conversation, so it steps aside for the blob editor and Analytics.
  const detailsVisible = inspectorOpen && !blobPage && !analyticsOpen
  const toggleInspector = () => setInspectorOpen((open) => { localStorage.setItem('bloblex.inspector.open', open ? '0' : '1'); return !open })
  const editingAgent = blobPage?.mode === 'edit' ? agents.find((agent) => agent.id === blobPage.agentId) ?? null : null
  const otherNames = activeAgents(agents).filter((agent) => agent.id !== editingAgent?.id).map((agent) => agent.name)
  const fieldErrors = draft ? validateAgentDraft(draft, otherNames) : {}
  const draftReady = Object.keys(fieldErrors).length === 0
  const draftDirty = !!(draft && baseline && isAgentDirty(draft, baseline))
  const draftRuntime = draft ? runtimes.find((runtime) => runtime.id === draft.runtimeId) ?? null : selectedRuntime
  const pageSessions = editingAgent ? agentSessions(sessions, editingAgent.id) : []
  const pageLegacy = legacySessions(sessions, (editingAgent ?? activeSelectedAgent)?.runtimeId ?? draft?.runtimeId ?? '')
  const headerOwned = activeSelectedAgent ? agentSessions(sessions, activeSelectedAgent.id) : sessions.filter((session) => !selectedRuntime || session.runtimeId === selectedRuntime.id)
  const headerLegacy = activeSelectedAgent ? legacySessions(sessions, activeSelectedAgent.runtimeId) : []

  return (
    <main className={`app-shell ${detailsVisible ? 'inspector-open' : ''}`} style={accent ? { '--agent-accent': accent } as React.CSSProperties : undefined}>
      <aside className="sidebar" aria-label="Agents">
        <div className="sidebar-top">
          <div className="brand-lockup"><img className="brand-logo" src={bloblexLogo} alt="Bloblex logo" /><strong>Bloblex</strong></div>
          <button className="icon-button" title="Create blob" aria-label="Create blob" disabled={connection !== 'connected' || busy || runtimes.length === 0} onClick={openCreate}><Plus size={17} /></button>
        </div>
        <div className="sr-only" aria-live="polite">{rosterAnnouncement}</div>
        <AgentRoster agents={agents} sessions={sessions} runtimes={runtimes} connected={connection === 'connected'} busy={busy} now={now} selectedAgentId={activeSelectedAgent?.id ?? null} selectedSessionId={selectedSession?.id ?? null} query={search} expanded={expanded} onQueryChange={setSearch} onSelect={selectAgent} onCreate={openCreate} onScan={() => void refreshRuntimes()} onNewSession={(agent) => newSession(agent.id)} onEdit={openEdit} onDuplicate={(agent) => void duplicateAgent(agent)} onArchive={setArchiveTarget} onToggleBlob={(agentId) => patchExpanded(agentId, (entry) => ({ ...entry, open: !entry.open }))} onToggleProject={(agentId, key) => patchExpanded(agentId, (entry) => ({ ...entry, projects: { ...entry.projects, [key]: entry.projects[key] !== true } }))} onToggleOther={(agentId) => patchExpanded(agentId, (entry) => ({ ...entry, other: !entry.other }))} onSelectSession={selectSession} onNewSessionInProject={(agent, path) => void createSession(agent, path, 'project')} onResumeSession={(session) => { selectSession(session); void resumeSession(session) }} onCancelSession={(session) => { selectSession(session); void cancelTurn(session) }} />
        <ProfileMenu
          connection={connection}
          usageActive={analyticsOpen}
          refreshing={refreshing}
          triggerRef={usageLinkRef}
          onUsage={() => setAnalyticsOpen(true)}
          onFindAgents={() => void refreshRuntimes()}
          onSettings={() => { setSettingsInitialPage('General'); setSettingsFocus(null); setSettingsSheet(true) }}
          onQuit={() => void quitBloblex()}
        />
      </aside>

      <section className="conversation-pane">
        {updateOffer.version && <UpdateAvailableBanner version={updateOffer.version} onView={() => { setSettingsInitialPage('General'); setSettingsFocus('updates'); setSettingsSheet(true) }} onLater={updateOffer.dismiss} />}
        {analyticsOpen ? <AnalyticsView sessions={sessions} agents={agents} connected={connection === 'connected'} onBack={closeAnalytics} /> : blobPage && draft ? <BlobPage mode={blobPage.mode} agent={editingAgent} draft={draft} runtime={draftRuntime} session={blobPage.mode === 'edit' ? selectedSession : null} runtimes={runtimes} sessions={pageSessions} legacyCount={pageLegacy.length} connected={connection === 'connected'} saving={busy} dirty={draftDirty} ready={draftReady} canStartSession={connection === 'connected' && !busy && runtimeUsable(draftRuntime)} error={formError} remoteNotice={remoteNotice} errors={fieldErrors} execution={executionFromAgent(editingAgent)} autoApprovals={snapshot?.autoApprovals ?? []} bypassNotices={snapshot?.bypassNotices ?? []} onDraftChange={(next) => { setDraft(next); setFormError(null) }} onExecutionGate={(gate) => { executionGate.current = gate }} onBack={() => closeBlobPage(editingAgent?.id ?? activeSelectedAgent?.id ?? null)} onSave={() => void saveBlob()} onCancel={() => { const source = remoteNotice && editingAgent ? draftFromAgent(editingAgent) : baseline; if (!source) return; setDraft(source); setBaseline(source); setRemoteNotice(null); setFormError(null) }} onArchive={() => { if (editingAgent) setArchiveTarget(editingAgent) }} onNewSession={() => { if (editingAgent) newSession(editingAgent.id) }} onOpenSession={(session) => { setSelectedSessionId(session.id); closeBlobPage(editingAgent?.id ?? null) }} /> : <>
        <header className="chat-header">
          <div className="chat-title">
            {activeSelectedAgent
              ? <button type="button" className="chat-title-button" aria-label={`Edit ${activeSelectedAgent.name}`} title="Blob settings" onClick={() => openEdit(activeSelectedAgent)}>{activeSelectedAgent.name}</button>
              : <strong className="chat-title-text">{agentName}</strong>}
            {(headerOwned.length > 0 || headerLegacy.length > 0) && (activeSelectedAgent || selectedRuntime) && <Select
              ariaLabel="Current conversation"
              variant="muted"
              align="left"
              className="session-switcher"
              value={selectedSession?.id ?? ''}
              placeholder="Select a conversation"
              onChange={(value) => setSelectedSessionId(value)}
              options={[
                ...headerOwned.map((session) => ({ value: session.id, label: formatUnknownSafe(session.title, session.projectPath?.split(/[\/]/).pop() ?? 'New session') })),
                ...headerLegacy.map((session, index) => ({ value: session.id, label: formatUnknownSafe(session.title, session.projectPath?.split(/[\/]/).pop() ?? 'New session'), group: index === 0 ? 'Not linked to a blob' : undefined })),
              ]}
            />}
          </div>
          <div className="header-actions">
            {selectedRuntime && <span className="model-pill" title={appliedModel ? 'Model applied on the latest turn' : 'Model reported by the session'}>{appliedModel ?? (selectedSession?.model?.trim() ? selectedSession.model : 'Default model')}</span>}
            <ApprovalPill mode={headerMode} />
            {selectedSession?.resumable && !sessionBusy && <button className="icon-button" title="Resume conversation" aria-label="Resume conversation" disabled={busy || connection !== 'connected' || !runtimeReady} onClick={() => void resumeSession()}><Play size={15} /></button>}
            <button className="icon-button" title="New session" aria-label="New session" disabled={!canStartSession} onClick={(event) => newSession(undefined, event.currentTarget)}><SquarePen size={16} /></button>
            <button className={`icon-button ${inspectorOpen ? 'active' : ''}`} title="Details" aria-label="Toggle context pane" aria-pressed={inspectorOpen} onClick={toggleInspector}><PanelRight size={16} /></button>
            <div className="more-menu-wrap" onKeyDown={(event) => { if (event.key === 'Escape') setMoreOpen(false) }}>
              <button className="icon-button" title="More options" aria-label="More options" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}><MoreHorizontal size={17} /></button>
              {moreOpen && <div className="menu-surface more-menu" role="menu"><button className="menu-item" role="menuitem" disabled={refreshing} onClick={() => { setMoreOpen(false); void refresh() }}><RefreshCw size={15} />Refresh state</button><button className="menu-item" role="menuitem" disabled={!selectedSession} onClick={() => { setMoreOpen(false); void showUsage() }}><Gauge size={15} />Usage details</button>{activeSelectedAgent && <button className="menu-item" role="menuitem" onClick={() => { setMoreOpen(false); openEdit(activeSelectedAgent) }}><Settings2 size={15} />Blob settings</button>}<span className="menu-separator" /><button role="menuitem" className="menu-item danger" onClick={() => void quitBloblex()}><X size={15} />Quit Bloblex</button></div>}
            </div>
          </div>
        </header>

        {error && <div className="inline-error" role="alert"><ShieldAlert size={16} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}><X size={15} /></button></div>}
        {archiveNotice && <div className="inline-error" role="status"><span>{archiveNotice}</span><button aria-label="Dismiss notice" onClick={() => setArchiveNotice(null)}><X size={15} /></button></div>}

        {!selectedSession ? <>{activePermission && <PermissionCard permission={activePermission} onReply={(choice) => void answerPermission(activePermission, choice)} />}<EmptyConversation connected={connection === 'connected'} hasRuntime={runtimes.length > 0} hasAgent={!!activeSelectedAgent} accent={accent} mood={selectedMood} agentName={agentName} onNewSession={(anchor) => newSession(undefined, anchor)} onCreate={openCreate} onRefresh={() => void refreshRuntimes()} /></> : <>
          <section ref={messageListRef} className="message-list" aria-label="Conversation" onScroll={(event) => { const node = event.currentTarget; stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72 }}>
            <div className="chat-column">
              {conversationItems.length === 0 ? <div className="session-first-state"><BlobCanvas color={accent} size={112} mood={selectedMood} label={agentName} /><h2>Ready when you are.</h2><p>Ask {agentName} to explore <code>{currentProjectName ?? 'the project'}</code> or make a change.</p></div> : conversationItems.map((item, index) => item.kind === 'message'
                ? <MessageItem key={item.id} message={item.value!} accent={accent} agentName={agentName} showAvatar={!isUserMessage(item.value) && (index === 0 || conversationItems[index - 1].kind !== 'message' || isUserMessage(conversationItems[index - 1].value))} mood={index === lastAgentIndex ? selectedMood : 'idle'} />
                : <ActivityItem key={item.id} item={item} />)}
              {activePermission && <PermissionCard permission={activePermission} onReply={(choice) => void answerPermission(activePermission, choice)} />}
              {selectedSession.state === 'working' && <div className="working-indicator" role="status"><span className="typing" aria-hidden="true"><i /><i /><i /></span>{agentName} is working</div>}
            </div>
          </section>
          <div className="composer-wrap">
            <div className="composer-box">
              <button className="composer-tool" aria-label="Attach files" title="File attachments are not available from this runtime yet" disabled><Plus size={18} /></button>
              <textarea ref={composerRef} value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendPrompt() } }} placeholder={`Message ${agentName}`} aria-label={`Message ${agentName}`} disabled={connection !== 'connected' || busy || selectedSession.state === 'waiting_permission' || !runtimeReady} rows={1} />
              <button className={`send-button ${turnLive ? 'cancel' : ''}`} onClick={turnLive ? () => void cancelTurn() : () => void sendPrompt()} disabled={busy || (!turnLive && (!composer.trim() || !runtimeReady))} aria-label={turnLive ? 'Cancel turn' : 'Send message'}>{busy ? <LoaderCircle size={16} className="spinning" /> : turnLive ? <Square size={12} fill="currentColor" /> : <ArrowUp size={17} />}</button>
            </div>
            <div className="composer-note">{currentProjectName ? <><FolderOpen size={11} />{currentProjectName}<span>·</span></> : null}Agent actions run on your device. You approve what matters.</div>
          </div>
        </>}
        </>}
      </section>

      <aside className="context-pane" aria-label="Conversation details" aria-hidden={!detailsVisible} inert={!detailsVisible}>
        <section className="context-head">
          {activeSelectedAgent ? <BlobCanvas color={accent} size={64} mood={selectedMood} label={activeSelectedAgent.name} /> : <span className="context-head-placeholder"><Code2 size={20} /></span>}
          <h2>{agentName}</h2>
          <p>{selectedRuntime ? [labelize(selectedRuntime.provider), selectedRuntime.version].filter(Boolean).join(' · ') : 'No coding agent selected'}</p>
        </section>
        <div className="context-tabs" role="tablist" aria-label="Conversation context">{(['Details', 'Runtime', 'Files'] as ContextTab[]).map((name, index, tabs) => <button key={name} type="button" id={`context-tab-${name.toLowerCase()}`} role="tab" aria-controls="context-panel" aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} className={tab === name ? 'active' : ''} onClick={() => setTab(name)} onKeyDown={(event) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const targetIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length; const target = tabs[targetIndex]; setTab(target); document.getElementById(`context-tab-${target.toLowerCase()}`)?.focus() }}>{name}</button>)}</div>
        <div id="context-panel" role="tabpanel" aria-labelledby={`context-tab-${tab.toLowerCase()}`} tabIndex={0} className="context-tab-panel">
          {tab === 'Details' && <DetailsPane session={selectedSession} model={appliedModel ?? selectedSession?.model ?? null} budgetWarning={budgetWarningFor(selectedSession)} budget={selectedBudget} usage={snapshot?.usageSummary ?? null} onUsage={() => void showUsage()} />}
          {tab === 'Runtime' && <RuntimePane runtime={selectedRuntime} connected={connection === 'connected'} onRefresh={() => void refreshRuntimes()} refreshing={refreshing} />}
          {tab === 'Files' && <FilesPane session={selectedSession} onOpen={(path) => void openInEditor(path, selectedSession?.projectPath).catch((reason) => setError(messageOf(reason)))} onReveal={(path) => void revealInExplorer(path, selectedSession?.projectPath).catch((reason) => setError(messageOf(reason)))} onCopy={async (path) => { try { await navigator.clipboard.writeText(await resolveProjectFile(path, selectedSession?.projectPath)) } catch (reason) { setError(messageOf(reason)) } }} onDiff={(path, content) => setDiffViewer({ path, content })} />}
        </div>
      </aside>

      {usageSheet && <UsageSheet summary={usageSummary} period={usagePeriod} loading={busy && usageSummary === null} onPeriodChange={(period) => { setUsageSummary(null); void showUsage(period) }} onClose={() => setUsageSheet(false)} />}
      {settingsSheet && <SettingsSheet snapshot={snapshot} initialPage={settingsInitialPage} focusUpdates={settingsFocus === 'updates'} onClose={() => { setSettingsSheet(false); setSettingsFocus(null) }} onRefresh={refreshRuntimes} onError={setError} onOpenAgent={(agentId) => { const target = agents.find((agent) => agent.id === agentId); setSettingsSheet(false); if (target) openEdit(target) }} />}
      {diffViewer && <DiffViewer path={diffViewer.path} content={diffViewer.content} onClose={() => setDiffViewer(null)} />}
      {chooserView}
      {archiveTarget && <ConfirmDialog title={`Archive ${archiveTarget.name}?`} body="It leaves the roster. Its conversations stay saved. Restoring a blob is not available yet." confirmLabel="Archive" cancelLabel="Cancel" onConfirm={() => void confirmArchive()} onCancel={() => setArchiveTarget(null)} />}
    </main>
  )
}

function EmptyConversation({ connected, hasRuntime, hasAgent, accent, mood, agentName, onNewSession, onCreate, onRefresh }: { connected: boolean; hasRuntime: boolean; hasAgent: boolean; accent: string; mood: BlobMood; agentName: string; onNewSession: (anchor?: HTMLElement | null) => void; onCreate: () => void; onRefresh: () => void }) {
  const canvas = hasAgent ? <BlobCanvas color={accent} size={128} mood={connected ? mood : 'offline'} label={agentName} /> : <BlobCanvas color="#e6e9ee" size={128} mood={connected ? 'idle' : 'offline'} label="Bloblex" />
  const heading = !connected ? 'Connect to your local runtime' : hasAgent ? `Start a conversation with ${agentName}` : hasRuntime ? 'No blobs yet.' : 'Find your coding agent'
  const description = !connected ? 'Bloblex keeps its daemon and agent sessions on this device. Reconnect to load the latest state.' : hasAgent ? 'Choose a project folder. Your selected CLI starts a real session there.' : hasRuntime ? 'Create a blob for one of the coding CLIs on this device.' : 'We only show agents installed on this device. Refresh to scan for Claude Code, Codex, or OpenCode.'
  const label = !connected ? 'Try again' : hasAgent ? 'Choose a project' : hasRuntime ? 'Create blob' : 'Scan for agents'
  return <div className="empty-conversation"><div className="empty-art">{canvas}</div><h1>{heading}</h1><p className="empty-description">{description}</p><button className="primary-button" onClick={(event) => { if (!connected || !hasAgent && !hasRuntime) onRefresh(); else if (hasAgent) onNewSession(event.currentTarget); else onCreate() }} disabled={!connected && !hasRuntime}><FolderOpen size={15} />{label}</button></div>
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
  return <article className={`message-row ${isUser ? 'user' : 'agent'} ${showAvatar ? 'group-start' : ''}`} aria-label={isUser ? 'You' : agentName} data-mood={isError ? 'error' : mood} data-accent={accent || undefined}>
    <div className="message-content">
      {isTool ? <div className={`activity-card ${isError ? 'error' : ''}`}><div className="activity-heading"><Terminal size={14} /><strong>{labelize(toolName ?? eventType.replace('.', ' '))}</strong><span>{isError ? 'Failed' : formatUnknownSafe(String(message.status ?? ''), 'Activity')}</span></div><p>{text || (typeof message.command === 'string' ? message.command : typeof message.summary === 'string' ? message.summary : 'Details are unavailable for this event.')}</p>{typeof message.path === 'string' && <code>{message.path}</code>}</div> : <div className={`message-bubble ${isError ? 'message-error' : ''}`}><SafeMessageText text={text || 'Message content unavailable.'} /></div>}
      {stamp && <div className="message-time">{stamp}</div>}
    </div>
  </article>
}

function storageFlag(key: string) {
  try { return localStorage.getItem(key) === '1' } catch { return false }
}

function readStoredAgentId() {
  try { return localStorage.getItem('bloblex.selectedAgentId') } catch { return null }
}

function writeStoredAgentId(id: string | null) {
  try {
    if (id) localStorage.setItem('bloblex.selectedAgentId', id)
    else localStorage.removeItem('bloblex.selectedAgentId')
  } catch { /* A blocked Storage API must not break in-memory selection. */ }
}

function readRosterExpanded(): ExpandedState {
  try { return parseExpandedState(localStorage.getItem('bloblex.roster.expanded')) }
  catch { return emptyExpandedState() }
}

function writeRosterExpanded(state: ExpandedState) {
  try { localStorage.setItem('bloblex.roster.expanded', JSON.stringify(state)) }
  catch { /* A blocked Storage API must not break the tree. */ }
}

function unwrapSession(result: Session | { session?: Session }): Session | null {
  const wrapped = (result as { session?: Session }).session
  if (wrapped && typeof wrapped.id === 'string') return wrapped
  const direct = result as Session
  return typeof direct.id === 'string' ? direct : null
}

function isUserMessage(message: Record<string, unknown> | undefined) {
  return String(message?.role ?? message?.kind ?? 'assistant').toLowerCase() === 'user'
}

/** Compact surfaces show prose without markdown markers or code fences. */
function plainText(text: string) {
  return text.replace(/```[\s\S]*?```/g, ' [code] ').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim()
}

function ActivityItem({ item }: { item: ConversationItem }) {
  const activity = item.activity ?? {}
  const file = item.activityKind === 'file'
  const failed = ['error', 'failed', 'rejected'].includes(String(activity.state ?? activity.status ?? '').toLowerCase()) || item.activityKind === 'turn'
  const title = item.activityKind === 'turn' ? turnFailureTitle(activity.failureClass) : file ? labelize(activity.operation, 'File change') : formatUnknownSafe(activity.title, formatUnknownSafe(activity.kind, 'Agent activity'))
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

function PermissionCard({ permission, onReply }: { permission: PermissionRequest; onReply: (choice: string) => void }) {
  const choices = permission.choices ?? []
  const detail = typeof permission.detail === 'string' ? permission.detail : typeof permission.description === 'string' ? permission.description : typeof permission.command === 'string' ? permission.command : null
  const tool = typeof permission.tool === 'string' ? permission.tool : null
  const deadline = typeof permission.expiresAt === 'string' ? Date.parse(permission.expiresAt) : Number.NaN
  return <section className="permission-card"><div className="permission-icon"><ShieldAlert size={17} /></div><div className="permission-copy"><strong>{formatUnknownSafe(permission.title, 'Approval requested')}</strong><p>{detail ?? `The agent requested permission${tool ? ` to use ${tool}` : ''}.`}</p>{Number.isFinite(deadline) && <small className="permission-deadline">Expires {new Date(deadline).toLocaleTimeString()}</small>}<div className="permission-actions">{choices.map((choice) => <PermissionChoiceButton key={choice} permission={permission} choice={choice} className="permission-choice" onReply={onReply}>{permissionChoiceLabel(choice)}</PermissionChoiceButton>)}</div></div></section>
}

function DetailRow({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return <div className="detail-row"><span>{label}</span><strong className={mono ? 'mono' : undefined}>{value}</strong></div>
}

function DetailsPane({ session, model, budgetWarning, budget, usage, onUsage }: { session: Session | null; model: string | null; budgetWarning: boolean; budget: Record<string, unknown> | null; usage: Record<string, unknown> | null; onUsage: () => void }) {
  return <div className="context-scroll">
    <section className="context-section">
      <h3>Conversation</h3>
      {session ? <div className="detail-list">
        <DetailRow label="Title" value={formatUnknownSafe(session.title, fileNameForPath(session.projectPath ?? '') ?? 'Untitled')} />
        <DetailRow label="Project" value={session.projectPath ?? 'Unavailable'} mono />
        <DetailRow label="Status" value={labelize(session.state, 'Unknown')} />
        <DetailRow label="Model" value={model?.trim() ? model : 'Default model'} />
      </div> : <p className="context-empty">No conversation selected.</p>}
    </section>
    <section className="context-section usage-section">
      <h3>Usage <small className="usage-scope">All blobs, all time</small></h3>
      <div className="detail-list">
        <DetailRow label="Input tokens" value={tokenValue(usage?.inputTokens)} />
        <DetailRow label="Output tokens" value={tokenValue(usage?.outputTokens)} />
        <DetailRow label="Provider cost" value={moneyMinor(usage?.providerReportedCostMinor, usage?.providerReportedCurrency)} />
        <DetailRow label="API estimate" value={moneyMinor(usage?.apiEstimateMinor, usage?.apiEstimateCurrency)} />
        {budget && <DetailRow label={`${labelize(budget.period)} budget`} value={`${budgetValue(budget.remaining, budget.metric)} of ${budgetValue(budget.hardLimit, budget.metric)} left`} />}
      </div>
      {budgetWarning && <p className="budget-inline-warning" role="status">A budget warning was reported for this session.</p>}
      <button type="button" className="secondary-button small context-action" onClick={onUsage}>Usage details</button>
      <p className="honesty-note">Provider cost and API estimates are separate. Unknown prices stay unknown.</p>
    </section>
  </div>
}

function RuntimePane({ runtime, connected, refreshing, onRefresh }: { runtime: Runtime | null; connected: boolean; refreshing: boolean; onRefresh: () => void }) {
  if (!runtime) return <div className="context-empty centered">{connected ? 'No coding agent selected.' : 'Runtime details appear when the daemon is connected.'}</div>
  const host = runtime.host
  const capabilities = Array.isArray(runtime.capabilities)
    ? runtime.capabilities.map((capability) => String(capability))
    : runtime.capabilities && typeof runtime.capabilities === 'object' ? Object.entries(runtime.capabilities).filter(([, enabled]) => enabled).map(([name]) => name) : []
  return <div className="context-scroll">
    <section className="context-section">
      <h3>Runtime <button className="icon-button quiet" title="Refresh runtime" aria-label="Refresh runtime" onClick={onRefresh} disabled={refreshing}><RefreshCw size={13} className={refreshing ? 'spinning' : ''} /></button></h3>
      <div className="detail-list">
        <DetailRow label="Daemon" value={connected ? 'Connected' : 'Disconnected'} />
        <DetailRow label="Version" value={runtime.version ?? 'Unknown'} />
        <DetailRow label="Sign-in" value={labelize(runtime.authState, 'Unknown')} />
        <DetailRow label="Protocol" value={labelize(runtime.protocolFamily, 'Unknown')} />
        <DetailRow label="Host" value={typeof host?.name === 'string' ? host.name : runtime.hostId ?? 'This computer'} />
        <DetailRow label="Executable" value={runtime.executablePath ?? 'Unknown'} mono />
      </div>
    </section>
    <section className="context-section">
      <h3>Capabilities</h3>
      {capabilities.length ? <div className="capability-list">{capabilities.map((name) => <span key={name}>{labelize(name)}</span>)}</div> : <p className="context-empty">Not reported by this runtime.</p>}
    </section>
  </div>
}

function FilesPane({ session, onOpen, onReveal, onCopy, onDiff }: { session: Session | null; onOpen: (path: string) => void; onReveal: (path: string) => void; onCopy: (path: string) => void; onDiff: (path: string, content: string) => void }) {
  const files = session?.files ?? []
  if (files.length === 0) return <div className="context-scroll"><div className="files-empty"><FileText size={20} /><strong>No files yet</strong><span>Files the agent edits in this conversation appear here.</span></div></div>
  return <div className="context-scroll"><div className="file-list">{files.map((file, index) => {
    const path = String(file.path ?? file.filePath ?? 'Unknown path')
    const diff = typeof file.diff === 'string' ? file.diff : typeof file.patch === 'string' ? file.patch : null
    const added = typeof file.addedLines === 'number' ? file.addedLines : typeof file.additions === 'number' ? file.additions : null
    const removed = typeof file.removedLines === 'number' ? file.removedLines : typeof file.deletions === 'number' ? file.deletions : null
    const unknown = path === 'Unknown path'
    return <article className="file-row" key={String(file.id ?? path) + index}>
      <FileText size={15} />
      <span className="file-main"><strong>{path.split(/[\\/]/).pop()}</strong><small>{path}</small></span>
      {added !== null && <em>+{added}</em>}
      {removed !== null && <i>−{removed}</i>}
      <span className="file-actions">
        <button title="Open in editor" aria-label={`Open ${path} in editor`} disabled={unknown} onClick={() => onOpen(path)}><Code2 size={13} /></button>
        <button title="Reveal in File Explorer" aria-label={`Reveal ${path} in File Explorer`} disabled={unknown} onClick={() => onReveal(path)}><FolderOpen size={13} /></button>
        <button title="Copy path" aria-label={`Copy ${path}`} disabled={unknown} onClick={() => onCopy(path)}><Copy size={13} /></button>
        <button title={diff ? 'View diff' : 'No diff reported'} aria-label={`View diff for ${path}`} disabled={!diff} onClick={() => diff && onDiff(path, diff)}><FileText size={13} /></button>
      </span>
    </article>
  })}</div></div>
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

function recordFrom(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }

function Companion({ agent, agents, runtime, runtimes, session, usage, connected, appError, activityLabel, budgetWarning, permission, approvalMode, onReply, onNewSession, onOpenMain, onOpenSettings, onSendPrompt, onCancelTurn, onSelectAgent }: { agent: Agent | null; agents: Agent[]; runtime: Runtime | null; runtimes: Runtime[]; session: Session | null; usage?: Record<string, unknown>; connected: boolean; appError: string | null; activityLabel: string; budgetWarning: boolean; permission?: PermissionRequest; approvalMode: ReturnType<typeof effectiveApprovalMode>; onReply: (permission: PermissionRequest, choice: string) => void; onNewSession: (anchor?: HTMLElement | null) => void; onOpenMain: () => void; onOpenSettings: () => void; onSendPrompt: (sessionId: string, text: string) => Promise<unknown>; onCancelTurn: (sessionId: string) => Promise<unknown>; onSelectAgent: (agent: Agent) => void }) {
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
  const clock = useClock(10_000)
  const derived = deriveCompanionStatus({ connected, runtime, session, permissionPending: !!permission, budgetWarning, composing: !!draft.trim(), now: clock })
  const displayMood = derived.mood
  const activity = derived.mood === 'listening' ? derived.label : activityLabel
  const fileStage = dropActive ? 'drop' : preparingFile ? 'preparing' : fileError ? 'error' : droppedFile ? (sending ? 'sending' : 'ready') : undefined
  const fsmRef = useRef<CompanionFsm | null>(null)
  const capsuleRef = useRef<HTMLDivElement>(null)
  const chatLogRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<CompanionMode>('welcome')
  if (!fsmRef.current) fsmRef.current = new CompanionFsm()
  const tall = mode === 'home' && !permission && (view === 'chat' || view === 'activity')
  const presentation = mode === 'home' && tall ? 'home-chat' : mode
  useEffect(() => {
    const fsm = fsmRef.current!
    fsm.onTransition = (_from, to) => setMode(to)
    fsm.launch()
    return () => { fsm.dispose(); void setCompanionMode('petit') }
  }, [])
  // The window already opens at the welcome size, so the greeting never waits on a resize.
  useEffect(() => { void (presentation === 'welcome' ? setCompanionMode('welcome', false) : setCompanionMode(presentation)) }, [presentation])
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
  // The native window springs open / curves shut (open spring and
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
  useLayoutEffect(() => {
    const root = capsuleRef.current
    if (root) stampCompanionDragRegions(root)
  })
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
  const color = agent ? agentColorHex(agent.color) : ''
  const name = agent?.name ?? (runtime ? labelize(runtime.provider) : 'Bloblex')
  const peers = activeAgents(agents).filter((item) => item.id !== agent?.id).slice(0, 4)
  const pills = companionPills(agents, agent?.id ?? null)
  const canStart = !!agent && connected && runtimeUsable(runtime)
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

  return <main className="companion-root" data-mode={mode} style={color ? { '--agent-accent': color } as React.CSSProperties : undefined} onMouseEnter={() => fsmRef.current?.mouseEntered()} onMouseLeave={() => fsmRef.current?.mouseLeft()}>
    <div ref={capsuleRef} className={`companion-capsule island ${mode}`} data-tauri-drag-region>
      {mode === 'petit' ? <div className="companion-compact" data-tauri-drag-region>
        <button className="compact-bot" aria-label="Open companion home" onClick={() => fsmRef.current?.click()}>{focusBlob(40)}</button>
        <div className="compact-copy" onClick={() => fsmRef.current?.click()}><span className="compact-name"><strong>{name}</strong><ApprovalPill mode={approvalMode} compact /></span><span role="status" aria-live="polite" className={`compact-status ${shimmering ? 'shimmer' : ''}`}>{statusLine}</span></div>
        {permission && <ShieldAlert className="companion-alert" size={15} aria-label="Approval required" />}
        {peers.length > 0 && <div className="mini-grid" aria-hidden="true" data-tauri-drag-region>{peers.map((item) => { const peerRuntime = runtimes.find((candidate) => candidate.id === item.runtimeId); const offline = !connected || !peerRuntime || ['offline', 'error', 'disconnected'].includes((peerRuntime.status ?? '').toLowerCase()); return <BlobCanvas key={item.id} color={agentColorHex(item.color)} size={15} mini mood={offline ? 'offline' : 'idle'} label={item.name} /> })}</div>}
        <button className="companion-collapse" aria-label="Expand companion" onClick={() => fsmRef.current?.click()}><ChevronUp size={15} /></button>
      </div> : mode === 'welcome' ? <section className="companion-welcome" aria-label="Bloblex welcome animation" data-tauri-drag-region>
        <BlobCanvas color={color} size={100} mood="idle" soundCues={soundsEnabled} label="Bloblex" greeting onGreetingComplete={() => fsmRef.current?.greetComplete()} />
      </section> : <>
        <header className="island-header" data-tauri-drag-region>
          <nav className="tabs" aria-label="Companion navigation">
            <button className={`tab ${view === 'overview' ? 'on' : ''}`} aria-label="Home" title="Home" onClick={() => openView('overview')}><Home size={13} /></button>
            <button className={`tab ${view === 'chat' ? 'on' : ''}`} aria-label="Chat" title="Chat" onClick={() => openView('chat')}><MessageCircle size={13} /></button>
            <button className={`tab ${view === 'activity' ? 'on' : ''}`} aria-label="Activity" title="Activity" onClick={() => openView('activity')}><Activity size={13} /></button>
            <button className="tab" aria-label="New session" title="New session" disabled={!canStart} onClick={(event) => { openView('chat'); onNewSession(event.currentTarget) }}><Plus size={14} /></button>
          </nav>
          <span className="island-drag" data-tauri-drag-region title="Drag companion" aria-hidden="true" />
          <ApprovalPill mode={approvalMode} compact />
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
                <div className="who"><span className="name">{name}</span><span className="tool">{session?.title?.trim() ? session.title : runtime ? labelize(runtime.provider) : (connected ? 'No active session' : 'Offline')}</span></div>
                <div className="ticker">{tickerLines.map((line, index) => <div key={index} className={`ticker-row ${index === tickerLines.length - 1 ? 'current' : ''}`}><span className={index === tickerLines.length - 1 && shimmering ? 'shimmer' : ''}>{line}</span></div>)}</div>
                <div className="glance" title={`Totals across all blobs. Input ${inputTokens === null ? 'unknown' : inputTokens.toLocaleString()} · Output ${outputTokens === null ? 'unknown' : outputTokens.toLocaleString()} · API estimate ${apiCost}`}><span>All blobs: Tokens <b>{tokenGlance}</b> · Cost <b>{actualCost}</b></span></div>
              </div>
            </div>
            <div className="island-card pills-card">
              {runtimes.length === 0 ? <p className="companion-empty">No coding agents discovered yet.</p> : pills.length === 0 ? <p className="companion-empty">No blobs yet.</p> : <div className="pills">{pills.map((item) => { const peerRuntime = runtimes.find((candidate) => candidate.id === item.runtimeId); const offline = !connected || !peerRuntime || ['offline', 'error', 'disconnected'].includes((peerRuntime.status ?? '').toLowerCase()); return <button key={item.id} className={`pill ${item.id === agent?.id ? 'on' : ''}`} style={{ '--pill': agentColorHex(item.color) } as React.CSSProperties} onClick={() => onSelectAgent(item)}><BlobCanvas color={agentColorHex(item.color)} size={22} mini mood={offline ? 'offline' : 'idle'} label={item.name} /><span className="lbl">{item.name}</span></button> })}</div>}
            </div>
          </div> : view === 'chat' ? <div className="island-card chat-card companion-chat-view">
            <span className="card-bot small">{focusBlob(44)}</span>
            <div className="chat-body">
              <div className="chat-log" ref={chatLogRef} data-companion-no-drag="">
                {!session && <p className="companion-empty companion-no-session">Open or create a session to chat here. <button type="button" disabled={!canStart} onClick={(event) => onNewSession(event.currentTarget)}>New session</button></p>}
                {recentMessages.map((message, index) => <div key={String(message.id ?? index)} className={`chat-row ${message.role === 'user' ? 'user' : ''}`}>{message.role === 'user' ? <div className="bubble">{String(message.content ?? message.text ?? '')}</div> : <div className="reply">{plainText(String(message.content ?? message.text ?? '')) || 'Message content unavailable.'}</div>}</div>)}
                {session && recentMessages.length === 0 && <p className="companion-empty">No messages in this conversation yet.</p>}
                {sessionBusy && session?.state !== 'waiting_permission' && <div className="typing" aria-label={`${name} is working`}><i /><i /><i /></div>}
              </div>
              {droppedFile && fileInfo && <div className="chip settled companion-file-ready"><Paperclip size={11} /><span><strong>{fileInfo.fileName}</strong> · {formatBytes(fileInfo.sizeBytes)} · path only</span><button aria-label="Remove local file reference" onClick={() => { fileRequest.current++; setDroppedFile(null); setFileInfo(null); setPreparingFile(false); setFileError(null) }}><X size={11} /></button></div>}
              {preparingFile && <p className="companion-file-note" role="status">Checking the selected path is a readable file… <button type="button" onClick={() => { fileRequest.current++; setPreparingFile(false); setFileInfo(null); setDroppedFile(null) }}>Cancel</button></p>}
              {(fileError ?? dropError ?? appError) && <p className="companion-drop-error" role="alert">{fileError ?? dropError ?? appError}</p>}
              <form className="chat-bar companion-chat-composer" data-companion-no-drag="" onSubmit={(event) => void sendCompanionPrompt(event)}>
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
                <div className="settings-line"><span>Drag the island to place it anywhere.</span></div>
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


function messageOf(reason: unknown) {
  if (reason instanceof Error) return reason.message
  return typeof reason === 'string' ? reason : 'The local daemon request failed.'
}
