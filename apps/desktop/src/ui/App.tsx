import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import {
  Activity, ArrowUp, ArrowUpRight, ChevronDown, ChevronUp, CircleHelp, Code2, Copy, FileText, FolderOpen,
  Gauge, Home, LoaderCircle, MessageCircle, MoreHorizontal, PanelRight, Paperclip, Play, Plus,
  RefreshCw, Search, Settings2, ShieldAlert, Square, SquarePen, Terminal, Volume2, VolumeX, X,
} from 'lucide-react'
import { BlobCanvas, type BlobMood } from '../blob/BlobCanvas'
import { disposeCompanionAudio, playCompanionCue, setCompanionSoundsEnabled, unlockCompanionAudioFromGesture } from '../blob/soundCues'
import { playDictationCue } from './dictationSound'
import { CompanionFsm, type CompanionMode } from '../blob/companionFsm'
import { buildConversationItems, groupConversationActivity, type ConversationItem, type GroupedConversationItem } from './conversation'
import { deriveCompanionStatus } from './companionStatus'
import { AnalyticsView } from './AnalyticsView'
import { tokenValue, usageTokenBuckets } from './usagePresentation'
import { isPendingPermissionLive, nextPermissionDeadline, selectPendingPermission } from './permissionSelection'
import { ApprovalCard } from './ApprovalCard'
import bloblexLogo from '../assets/bloblex-128.png'
import { sessionsForPauseRequest } from './trayActions'
import { applyEvent, formatUnknownSafe, isPermissionReplyAllowed, labelize, type Agent, type ConnectionState, type DaemonEvent, type PermissionRequest, type Runtime, type Session, type Snapshot } from '../types'
import { agentColorHex } from './agentColor'
import { AgentRoster } from './AgentRoster'
import { ProjectChooser } from './ProjectChooser'
import { effectiveApprovalMode } from '../approvalContract'
import type { ExecutionSendGate } from '../executionContract'
import { parseExecSnapshot } from '../executionContract'
import { turnFailureTitle } from './analyticsFormat'
import { createDraft, createParams, daemonCodeOf, draftFromAgent, duplicateParams, executionFromAgent, isAgentDirty, messageForDaemonCode, starterDraft, updateParams, validateAgentDraft, type AgentDraft } from './agentForm'
import { activeAgents, agentSessions, agentsForRuntime, companionPills, duplicateAgentName, emptyExpandedState, garbageCollectExpanded, legacySessions, nextAgentAfterArchive, parseExpandedState, projectFolderName, projectGroups, projectKey, recentProjects, runtimeUsable, sessionDisplayTitle, sessionForSelection, sessionNewParams, sessionSelectionTarget, type ExpandedState } from './rosterSelectors'
import { conversationMarkdown } from './conversationMarkdown'
import { parseSharedBlob, serializeBlob, type SharedBlob } from './blobShare'
import { ApprovalPill } from './approvalUi'
import { BlobPage, ConfirmDialog } from './BlobPage'
import { DictationButton } from './DictationButton'
import { UpdateAvailableBanner, useMainUpdateOffer } from './UpdateBanner'
import { SettingsSheet, type SettingsPageId } from './SettingsSheet'
import { ProfileMenu, saveProfileName } from './ProfileMenu'
import { emptyPins, moveFavoriteRelative, movePinnedItemRelative, readPins, toggleFavorite, togglePinnedProject, togglePinnedSession, writePins, type SidebarPins } from './sidebarPins'
import { Select } from './Select'
import { ProviderLogo } from './providerBrand'
import { useClock } from './useClock'
import { useDialogAccessibility } from './dialogFocus'
import { initialiseSeen, isUnread, markSeen, unreadNeedsApproval, type SeenSessions } from './sessionSeen'
import { notificationForTransition } from './notificationTransitions'
import { flashMainWindow, sendDesktopNotification } from '../desktopIntegrations'
import { stampCompanionDragRegions } from './companionDrag'
import { QuickSwitcher } from './QuickSwitcher'
import { useQuickSwitcherShortcut } from './useQuickSwitcherShortcut'
import { LaunchIntro, LaunchWarnings } from './LaunchIntro'
import { FirstRunOnboarding } from './FirstRunOnboarding'
import { LAUNCH_OVERALL_TIMEOUT_REASON, LAUNCH_TIMEOUTS, launchWarningsFor, runLaunchChecks, runtimeAuthSummary, throwIfLaunchAborted, type LaunchCheck } from './launchChecks'
import { providerBrand } from './providerBrand'
import { applyAppearance, applySurfaceAppearance, type TextSizeChoice, type ThemeChoice } from './appearance'
import { SessionExecutionControls } from './SessionExecutionControls'
import { ContextWindowIndicator } from './ContextWindowIndicator'
import { ConversationOutline, outlineItemsFromMessages } from './ConversationOutline'
import { SafeMarkdown } from './SafeMarkdown'
import { parseUnifiedDiff } from './diffParser'
import type { QuickSwitcherItem } from './quickSwitcherModel'
import { ensureDaemon, fetchSnapshot, getActiveRuntime, getActiveSession, inDesktop, inspectLocalFile, listenForActiveRuntime, listenForActiveSession, listenForDaemonConnection, listenForDaemonEvents, listenForOpenSettings, openInEditor, openProjectFolder, quitBloblex, readBlobImport, refreshTrayMenu, resolveProjectFile, revealInExplorer, rpc, selectBlobImportPath, selectLocalFile, selectMarkdownExportPath, selectBlobExportPath, setActiveRuntime, setActiveSession, setCompanionMode, setCompanionVisibility, showMainSettings, showMainWindow, startDaemonEventStream, writeBlobExport, writeMarkdownExport } from '../tauri'

type ContextTab = 'Details' | 'Runtime' | 'Files'
type AppliedModelState = { sessionId: string; model: string | null; hasSnapshot: boolean; loading: boolean }
async function openSafeLink(url: string) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    await invoke('plugin:opener|open_url', { url: parsed.href })
  } catch { /* An unavailable opener leaves the link inert. */ }
}
export function App() {
  const companion = new URLSearchParams(location.search).has('companion')
  useEffect(() => {
    document.documentElement.classList.toggle('companion-surface', companion)
    return () => document.documentElement.classList.remove('companion-surface')
  }, [companion])
  useEffect(() => () => { if (companion) disposeCompanionAudio() }, [companion])
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [analyticsOpen, setAnalyticsOpen] = useState(false)
  const [launchVisible, setLaunchVisible] = useState(() => inDesktop && !companion && import.meta.env.MODE !== 'test')
  const [launchChecks, setLaunchChecks] = useState<LaunchCheck[]>([])
  const [launchServiceDown, setLaunchServiceDown] = useState(false)
  const [launchRunId, setLaunchRunId] = useState(0)
  const launchGeneration = useRef(0)
  const launchAbort = useRef<AbortController | null>(null)
  const [priorAppUse] = useState(() => {
    try { return ['bloblex.firstRun.connected', 'bloblex.profile.name', 'bloblex.profile.skipped', 'bloblex.sessions.seen', 'bloblex.roster.expanded', 'bloblex.sidebar.pins', 'bloblex.selectedAgentId'].some((key) => localStorage.getItem(key) !== null) }
    catch { return false }
  })
  const [onboardingVisible, setOnboardingVisible] = useState(false)
  const [onboardingCompleteThisRun, setOnboardingCompleteThisRun] = useState(false)
  const [agentWarningDismissed, setAgentWarningDismissed] = useState(false)
  const [companionVisible, setCompanionVisibleState] = useState(false)
  const companionVisibilityRevision = useRef(0)
  const [pendingCompanionStartup, setPendingCompanionStartup] = useState(false)
  const reducedLaunchFade = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const [connection, setConnection] = useState<ConnectionState>(inDesktop ? 'connecting' : 'disconnected')
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [selectedRuntimeId, setSelectedRuntimeId] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [mainAttention, setMainAttention] = useState(() => !companion && document.visibilityState === 'visible' && document.hasFocus())
  const [seenSessions, setSeenSessions] = useState<SeenSessions>({})
  const seenLoaded = useRef(false)
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  const [notificationSettingLoaded, setNotificationSettingLoaded] = useState(false)
  const notificationStates = useRef<Map<string, string>>(new Map())
  const notificationStatesBooted = useRef(false)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [blobPage, setBlobPage] = useState<{ mode: 'create' | 'edit'; agentId: string | null } | null>(null)
  const [draft, setDraft] = useState<AgentDraft | null>(null)
  const [baseline, setBaseline] = useState<AgentDraft | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [remoteNotice, setRemoteNotice] = useState<string | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<Agent | null>(null)
  const [sessionDeleteTarget, setSessionDeleteTarget] = useState<Session | null>(null)
  const [rosterAnnouncement, setRosterAnnouncement] = useState('')
  const [archiveNotice, setArchiveNotice] = useState<string | null>(null)
  const [tab, setTab] = useState<ContextTab>('Details')
  const [composer, setComposer] = useState('')
  const [dictationPartial, setDictationPartial] = useState('')
  const composerTypingRef = useRef(false)
  const [appliedModelState, setAppliedModelState] = useState<AppliedModelState | null>(null)
  const appliedModelRequest = useRef(0)
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
  const [diffViewer, setDiffViewer] = useState<{ path: string; content: string } | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const [pendingBlobImport, setPendingBlobImport] = useState<SharedBlob | null>(null)
  const [usageSummary, setUsageSummary] = useState<Record<string, unknown> | null>(null)
  const [quotaRefreshing, setQuotaRefreshing] = useState(false)
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
  const [permissionClock, setPermissionClock] = useState(() => Date.now())
  const [inspectorOpen, setInspectorOpen] = useState(() => storageFlag('bloblex.inspector.open'))
  const [search, setSearch] = useState('')
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false)
  const openQuickSwitcher = useCallback(() => setQuickSwitcherOpen(true), [])
  const [expanded, setExpanded] = useState<ExpandedState>(() => companion ? emptyExpandedState() : readRosterExpanded())
  const [chooser, setChooser] = useState<{ agentId: string; x: number; y: number } | null>(null)
  const [pins, setPins] = useState<SidebarPins>(() => companion ? emptyPins() : readPins())
  const updatePins = (change: (current: SidebarPins) => SidebarPins) => setPins((current) => { const next = change(current); writePins(next); return next })
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const messageListRef = useRef<HTMLElement>(null)
  const stickToBottom = useRef(true)
  const queuedEvents = useRef<DaemonEvent[]>([])
  const hydrating = useRef(true)
  const appearanceHydrated = useRef(false)
  const refreshingRef = useRef(false)
  const refreshAgain = useRef(false)
  const snapshotRef = useRef<Snapshot | null>(null)
  const pendingSessionHydrations = useRef(new Set<string>())
  const selectedAgentIdRef = useRef<string | null>(null)
  const detailsSessionIdRef = useRef<string | null>(null)
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

  const refreshAppliedModel = useCallback((sessionId: string) => {
    const requestId = ++appliedModelRequest.current
    setAppliedModelState((current) => current?.sessionId === sessionId
      ? { ...current, loading: true }
      : { sessionId, model: null, hasSnapshot: false, loading: true })
    void rpc('exec.snapshot.latest', { sessionId }).then((result) => {
      if (requestId !== appliedModelRequest.current) return
      const parsed = parseExecSnapshot(result)
      setAppliedModelState((current) => {
        if (requestId !== appliedModelRequest.current) return current
        const previous = current?.sessionId === sessionId ? current : null
        return parsed
          ? { sessionId, model: parsed.appliedModelId, hasSnapshot: true, loading: false }
          : { sessionId, model: previous?.model ?? null, hasSnapshot: previous?.hasSnapshot ?? false, loading: false }
      })
    }).catch(() => {
      if (requestId !== appliedModelRequest.current) return
      setAppliedModelState((current) => current?.sessionId === sessionId
        ? { ...current, loading: false }
        : { sessionId, model: null, hasSnapshot: false, loading: false })
    })
  }, [])
  const refreshAppliedModelFromEvent = useCallback((event: DaemonEvent) => {
    if (event.type !== 'exec.options.changed') return
    const sessionId = typeof event.payload?.sessionId === 'string' ? event.payload.sessionId : null
    if (sessionId && sessionId === detailsSessionIdRef.current) refreshAppliedModel(sessionId)
  }, [refreshAppliedModel])

  useEffect(() => {
    const syncAttention = () => setMainAttention(!companion && document.visibilityState === 'visible' && document.hasFocus())
    window.addEventListener('focus', syncAttention)
    window.addEventListener('blur', syncAttention)
    document.addEventListener('visibilitychange', syncAttention)
    syncAttention()
    return () => {
      window.removeEventListener('focus', syncAttention)
      window.removeEventListener('blur', syncAttention)
      document.removeEventListener('visibilitychange', syncAttention)
    }
  }, [companion])

  useQuickSwitcherShortcut(!companion && !blobPage && !analyticsOpen, openQuickSwitcher)

  useEffect(() => {
    if (!inDesktop || companion) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    void listen<boolean>('bloblex-companion-visible-changed', ({ payload }) => {
      companionVisibilityRevision.current += 1
      setCompanionVisibleState(payload)
    }).then((stop) => {
      if (cancelled) { stop(); return }
      unlisten = stop
      const revisionAtRead = companionVisibilityRevision.current
      void invoke<boolean>('companion_visible').then((visible) => {
        if (!cancelled && companionVisibilityRevision.current === revisionAtRead) setCompanionVisibleState(visible)
      }).catch(() => undefined)
    })
    return () => { cancelled = true; unlisten?.() }
  }, [companion])

  useEffect(() => {
    if (companion || !inDesktop) return
    let active = true
    void rpc<Record<string, unknown>>('settings.get').then((result) => {
      if (!active) return
      const values = result.settings && typeof result.settings === 'object' ? result.settings as Record<string, unknown> : result
      setNotificationsEnabled(values['notifications.enabled'] !== false)
      setNotificationSettingLoaded(true)
    }).catch(() => { if (active) setNotificationSettingLoaded(true) })
    let unlisten: (() => void) | undefined
    void listen<boolean>('bloblex-notifications-enabled-changed', ({ payload }) => setNotificationsEnabled(payload)).then((stop) => { unlisten = stop })
    return () => { active = false; unlisten?.() }
  }, [companion])

  const runtimes = snapshot?.runtimes ?? []
  const sessions = snapshot?.sessions ?? []
  const agents = snapshot?.agents ?? []
  useEffect(() => {
    if (!snapshot || companion || !inDesktop) return
    for (const session of sessions) {
      if (session.archived || Array.isArray(session.messages) || Array.isArray(session.turns) || pendingSessionHydrations.current.has(session.id)) continue
      pendingSessionHydrations.current.add(session.id)
      void rpc<Session>('session.get', { sessionId: session.id }).then((fullSession) => {
        setSnapshot((current) => current ? mergeHydratedSession(current, session.id, fullSession) : current)
      }).catch(() => undefined).finally(() => pendingSessionHydrations.current.delete(session.id))
    }
  }, [snapshot, sessions, companion])
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
  detailsSessionIdRef.current = selectedSession?.id ?? null
  const appliedModelForDetails = selectedSession
    ? appliedModelState?.sessionId === selectedSession.id
      ? appliedModelState.model?.trim() || (appliedModelState.hasSnapshot ? 'Unknown' : appliedModelState.loading ? 'Loading…' : 'Unavailable')
      : 'Loading…'
    : null
  const sessionMessages = selectedSession?.messages ?? selectedSession?.turns?.flatMap((turn) => Array.isArray(turn.messages) ? turn.messages : []) ?? selectedSession?.events ?? []
  const conversationItems = selectedSession ? buildConversationItems(selectedSession) : []
  useEffect(() => {
    if (seenLoaded.current || !snapshot || companion) return
    let stored: SeenSessions | null = null
    try {
      const raw = localStorage.getItem('bloblex.sessions.seen')
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          stored = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        }
      }
    } catch { stored = null }
    const next = initialiseSeen(sessions, stored)
    seenLoaded.current = true
    setSeenSessions(next)
    if (sessions.length > 0 || priorAppUse) {
      try { localStorage.setItem('bloblex.sessions.seen', JSON.stringify(next)) } catch { /* Local persistence is best effort. */ }
    }
  }, [sessions, companion])

  useEffect(() => {
    if (!seenLoaded.current) return
    setSeenSessions((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => sessions.some((session) => session.id === id)))
      if (Object.keys(next).length !== Object.keys(current).length) return next
      return current
    })
  }, [sessions])

  useEffect(() => {
    if (!seenLoaded.current || !mainAttention || !selectedSession?.updatedAt) return
    setSeenSessions((current) => markSeen(current, selectedSession.id, selectedSession.updatedAt!))
  }, [mainAttention, selectedSession?.id, selectedSession?.updatedAt])

  useEffect(() => {
    if (!seenLoaded.current) return
    if (!sessions.length && !priorAppUse) return
    try { localStorage.setItem('bloblex.sessions.seen', JSON.stringify(seenSessions)) } catch { /* Local persistence is best effort. */ }
  }, [seenSessions, sessions.length, priorAppUse])

  useEffect(() => {
    if (!snapshot || companion) return
    if (!notificationStatesBooted.current) {
      notificationStates.current = new Map(sessions.map((session) => [session.id, session.state ?? 'idle']))
      notificationStatesBooted.current = true
      return
    }
    if (!notificationSettingLoaded) return
    for (const session of sessions) {
      const previous = notificationStates.current.get(session.id)
      const next = session.state ?? 'idle'
      notificationStates.current.set(session.id, next)
      if (!previous || previous === next) continue
      const notification = notificationForTransition(previous, next)
      if (!notification || mainAttention) continue
      const agent = agents.find((item) => item.id === session.agentId)
      const name = agent?.name ?? labelize(session.provider, 'Blob')
      const title = formatUnknownSafe(session.title, 'Conversation')
      if (notificationsEnabled) void sendDesktopNotification(name, notification.body(title)).catch(() => undefined)
      if (notification.state === 'approval') void flashMainWindow().catch(() => undefined)
    }
  }, [snapshot, sessions, agents, companion, notificationSettingLoaded, notificationsEnabled, mainAttention])
  const unreadSessionIds = new Set(sessions.filter((session) => isUnread(session, seenSessions) && !(mainAttention && session.id === selectedSession?.id)).map((session) => session.id))
  const approvalSessionIds = new Set([
    ...sessions.filter((session) => unreadNeedsApproval(session, seenSessions)).map((session) => session.id),
    ...(snapshot?.permissions ?? []).filter((permission) => typeof permission.sessionId === 'string' && isPendingPermissionLive(permission, permissionClock)).map((permission) => permission.sessionId!),
  ].filter((id) => !(mainAttention && id === selectedSession?.id)))
  const groupedConversationItems = groupConversationActivity(conversationItems)
  const activePermission = selectPendingPermission(snapshot?.permissions ?? [], selectedSession?.id, activeSessionId, permissionClock)
  const agentName = activeSelectedAgent?.name ?? (selectedRuntime ? labelize(selectedRuntime.provider) : 'No runtime selected')
  const outlineItems = outlineItemsFromMessages(
    groupedConversationItems.filter((item): item is ConversationItem & { kind: 'message' } => item.kind === 'message'),
    agentName,
  )
  const accent = activeSelectedAgent ? agentColorHex(activeSelectedAgent.color) : ''
  const companionPermission = activePermission ?? undefined
  const companionSessionRecord = sessions.find((session) => session.id === companionPermission?.sessionId)
    ?? selectedSession
  const companionSession = companionSessionRecord
  const companionAgent = agents.find((agent) => agent.id === companionSession?.agentId && !agent.archived) ?? activeSelectedAgent
  const companionRuntime = runtimes.find((runtime) => runtime.id === companionAgent?.runtimeId) ?? runtimes.find((runtime) => runtime.id === companionSession?.runtimeId) ?? selectedRuntime
  const companionStatus = deriveCompanionStatus({ connected: connection === 'connected', runtime: companionRuntime, session: companionSession, permissionPending: !!companionPermission, now })
  const previousCueMood = useRef<string | null>(null)
  const previousPermissionCue = useRef<string | null>(null)
  const currentProjectName = selectedSession?.projectPath?.split(/[\\/]/).filter(Boolean).pop()
  const headerAgent = selectedSession
    ? (selectedSession.agentId ? agents.find((agent) => agent.id === selectedSession.agentId) ?? null : null)
    : activeSelectedAgent
  const headerMode = effectiveApprovalMode(headerAgent)
  const companionMode = effectiveApprovalMode(companionAgent)

  useEffect(() => {
    const sessionId = selectedSession?.id
    if (!sessionId) {
      appliedModelRequest.current += 1
      setAppliedModelState(null)
      return
    }
    refreshAppliedModel(sessionId)
  }, [selectedSession?.id, refreshAppliedModel])

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

  const hydrateSessionChange = useCallback((event: DaemonEvent) => {
    if (event.type !== 'session.changed') return
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
    const session = (payload.session && typeof payload.session === 'object' ? payload.session : payload) as Session
    if (typeof session.id !== 'string' || session.archived === true) return
    const current = snapshotRef.current
    if (current?.deletedSessionIds?.includes(session.id) || current?.sessions?.some((item) => item.id === session.id && (Array.isArray(item.messages) || Array.isArray(item.turns)))) return
    if (pendingSessionHydrations.current.has(session.id)) return
    pendingSessionHydrations.current.add(session.id)
    void rpc<Session>('session.get', { sessionId: session.id }).then((fullSession) => {
      setSnapshot((snapshot) => snapshot ? mergeHydratedSession(snapshot, session.id, fullSession) : snapshot)
    }).catch(() => undefined).finally(() => pendingSessionHydrations.current.delete(session.id))
  }, [])

  const refresh = useCallback(async () => {
    if (!inDesktop) return
    if (refreshingRef.current) { refreshAgain.current = true; return }
    refreshingRef.current = true
    hydrating.current = true
    setRefreshing(true)
    try {
      await ensureDaemon()
      const deletedSessionIds = snapshotRef.current?.deletedSessionIds ?? []
      let next = preserveDeletedSessions(await fetchSnapshot(), deletedSessionIds)
      const replay = await rpc<{ events?: DaemonEvent[]; replayAvailable?: boolean }>('events.replay', { afterSequence: next.sequence ?? 0 })
      if (replay.replayAvailable === false) next = preserveDeletedSessions(await fetchSnapshot(), deletedSessionIds)
      await startDaemonEventStream()
      const queued = [...(replay.replayAvailable === false ? [] : replay.events ?? []), ...queuedEvents.current]
        .filter((event) => (event.sequence ?? 0) > (next.sequence ?? 0))
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
      queuedEvents.current = []
      hydrating.current = false
      setSnapshot(queued.reduce((state, event) => applyEvent(state, event), next))
      queued.forEach(hydrateSessionChange)
      queued.forEach(refreshAppliedModelFromEvent)
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
  }, [hydrateAgentChanges, hydrateSessionChange, refreshAppliedModelFromEvent])

  useEffect(() => {
    if (!inDesktop || companion || !launchVisible) return
    launchAbort.current?.abort()
    const generation = ++launchGeneration.current
    const controller = new AbortController()
    launchAbort.current = controller
    const { signal } = controller
    const timer = window.setTimeout(() => controller.abort(LAUNCH_OVERALL_TIMEOUT_REASON), LAUNCH_TIMEOUTS.overall)
    const publish = (next: LaunchCheck[]) => {
      if ((signal.aborted && signal.reason !== LAUNCH_OVERALL_TIMEOUT_REASON) || generation !== launchGeneration.current) return
      setLaunchChecks(next)
    }
    let checks: LaunchCheck[] = []
    const runSteps = async (steps: Parameters<typeof runLaunchChecks>[0]) => {
      checks = await runLaunchChecks(steps, publish, signal, checks)
      return checks
    }
    const run = async () => {
      setLaunchServiceDown(false)
      setLaunchChecks([])
      await runSteps([{ id: 'service', label: 'Connecting to the Bloblex service', timeoutMs: LAUNCH_TIMEOUTS.service, run: async (stageSignal) => {
        await ensureDaemon()
        throwIfLaunchAborted(stageSignal)
        const next = await fetchSnapshot()
        throwIfLaunchAborted(stageSignal)
        setSnapshot(next)
        setConnection('connected')
        return 'Connected and loaded the latest state'
      } }])
      if (checks.find((check) => check.id === 'service')?.state === 'failed') { setLaunchServiceDown(true); return }
      if (signal.aborted || generation !== launchGeneration.current) return
      let found: Runtime[] = []
      await runSteps([{ id: 'discovery', label: 'Finding coding agents', timeoutMs: LAUNCH_TIMEOUTS.discovery, run: async (stageSignal) => {
        const discovered = await rpc<Runtime[] | { runtimes?: Runtime[] }>('runtime.refresh')
        throwIfLaunchAborted(stageSignal)
        const next = await fetchSnapshot()
        throwIfLaunchAborted(stageSignal)
        setSnapshot(next)
        found = Array.isArray(discovered) ? discovered : Array.isArray(discovered.runtimes) ? discovered.runtimes : next.runtimes ?? []
        return found.length ? found.length + (found.length === 1 ? ' coding agent found' : ' coding agents found') : 'No coding agents found'
      } }])
      if (signal.aborted || generation !== launchGeneration.current) return
      const discoveryFailed = checks.find((check) => check.id === 'discovery')?.state === 'failed'
      const authSteps = discoveryFailed ? [] : found.map((runtime) => ({
        id: 'auth:' + runtime.id, label: 'Checking ' + providerBrand(runtime.provider).name + ' sign-in', timeoutMs: LAUNCH_TIMEOUTS.agent,
        run: async (stageSignal: AbortSignal) => {
          throwIfLaunchAborted(stageSignal)
          const summary = runtimeAuthSummary(runtime)
          return summary.state === 'authenticated' ? summary.label : summary.state === 'unauthenticated'
            ? 'Warning: ' + providerBrand(runtime.provider).name + ': sign-in required' + (runtime.provider === 'opencode' ? ` (${summary.label})` : '')
            : 'Warning: ' + providerBrand(runtime.provider).name + ': sign-in could not be confirmed' + (runtime.provider === 'opencode' && summary.label !== 'Sign-in status unknown' ? ` (${summary.label})` : '')
        },
      }))
      if (authSteps.length) await runSteps(authSteps)
      if (signal.aborted || generation !== launchGeneration.current) return
      const modelSteps = discoveryFailed ? [] : found.map((runtime) => ({ id: 'models:' + runtime.id, label: 'Loading ' + providerBrand(runtime.provider).name + ' models', timeoutMs: LAUNCH_TIMEOUTS.models, run: async (stageSignal: AbortSignal) => {
        const result = await rpc<Record<string, unknown>>('runtime.models', { runtimeId: runtime.id })
        throwIfLaunchAborted(stageSignal)
        const models = Array.isArray(result.models) ? result.models : Array.isArray(result.items) ? result.items : []
        if (!models.length) return 'Warning: ' + providerBrand(runtime.provider).name + ': models could not be loaded'
        return 'Loaded ' + models.length + ' models'
      } }))
      if (modelSteps.length) await runSteps(modelSteps)
      if (signal.aborted || generation !== launchGeneration.current) return
      await runSteps([{ id: 'usage', label: 'Loading usage and limits', timeoutMs: LAUNCH_TIMEOUTS.usage, run: async (stageSignal) => {
        const now = new Date()
        const from = new Date(now.getFullYear(), now.getMonth(), 1)
        const summary = await rpc<Record<string, unknown>>('usage.summary', { from: from.toISOString(), to: now.toISOString() })
        throwIfLaunchAborted(stageSignal)
        setUsageSummary(summary)
        return 'Usage and limits are ready'
      } }])
    }
    void run().catch((reason) => {
      if (signal.aborted || generation !== launchGeneration.current) return
      publish([...checks, { id: 'unexpected', label: 'Finishing startup checks', state: 'failed', detail: messageOf(reason) }])
    }).finally(() => window.clearTimeout(timer))
    return () => {
      controller.abort()
      window.clearTimeout(timer)
      if (launchAbort.current === controller) launchAbort.current = null
    }
  }, [companion, launchVisible, launchRunId])

  useEffect(() => {
    if (companion || launchVisible || onboardingVisible || onboardingCompleteThisRun || connection !== 'connected') return
    const completeKey = 'bloblex.firstRun.complete'
    const hasBlobs = (snapshot?.agents ?? []).length > 0
    const hasSessions = (snapshot?.sessions ?? []).length > 0
    try {
      if (hasBlobs || hasSessions || priorAppUse) {
        localStorage.setItem(completeKey, '1')
        localStorage.setItem('bloblex.firstRun.connected', '1')
      }
      else if (localStorage.getItem(completeKey) !== '1') setOnboardingVisible(true)
    } catch { if (!hasBlobs && !hasSessions && !priorAppUse) setOnboardingVisible(true) }
  }, [companion, connection, launchVisible, onboardingVisible, onboardingCompleteThisRun, priorAppUse, snapshot?.agents, snapshot?.sessions])

  useEffect(() => {
    if (companion || launchVisible || onboardingVisible || !pendingCompanionStartup) return
    const hasBlobs = (snapshot?.agents ?? []).length > 0
    let firstRunComplete = false
    try { firstRunComplete = localStorage.getItem('bloblex.firstRun.complete') === '1' } catch { /* A blocked store defers companion startup until this run completes onboarding. */ }
    if (!hasBlobs && !firstRunComplete && !onboardingCompleteThisRun) return
    void setCompanionVisibility(true).catch((reason) => setError(messageOf(reason))).finally(() => setPendingCompanionStartup(false))
  }, [companion, launchVisible, onboardingVisible, onboardingCompleteThisRun, pendingCompanionStartup, snapshot?.agents])

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
      if (event.type === 'quota.updated') setQuotaRefreshing(false)
      if (event.type === 'replay.gap') {
        queuedEvents.current = []
        hydrating.current = true
        setConnection('disconnected')
        if (refreshingRef.current) refreshAgain.current = true
        else void refresh()
      } else if (hydrating.current) queuedEvents.current.push(event)
      else {
        setSnapshot((current) => current ? applyEvent(current, event) : current)
        refreshAppliedModelFromEvent(event)
        hydrateSessionChange(event)
        hydrateAgentChanges([event])
      }
    }).then((stop) => { if (cancelled) stop(); else unlistenEvents = stop })
    void listenForDaemonConnection((connected) => {
      if (connected && hydrating.current) return
      setConnection(connected ? 'connected' : 'disconnected')
      if (connected) setError(null)
    }).then((stop) => { if (cancelled) stop(); else unlistenConnection = stop })
    return () => { cancelled = true; unlistenEvents?.(); unlistenConnection?.() }
  }, [hydrateAgentChanges, refreshAppliedModelFromEvent])

  useEffect(() => {
    if (!inDesktop || companion || connection !== 'connected') return
    let current = true
    void rpc<{ quotas?: Record<string, unknown>[] }>('quota.list').then((result) => {
      if (current) setSnapshot((snapshot) => snapshot ? { ...snapshot, quotas: result.quotas ?? [] } : snapshot)
    }).catch(() => undefined)
    return () => { current = false }
  }, [companion, connection])

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
    if (!inDesktop || connection !== 'connected' || appearanceHydrated.current) return
    appearanceHydrated.current = true
    void rpc<Record<string, unknown>>('settings.get').then((result) => {
      const root = document.documentElement
      const settings = (result.settings && typeof result.settings === 'object' ? result.settings : result) as Record<string, unknown>
      const theme: ThemeChoice = settings['appearance.theme'] === 'dark' || settings['appearance.theme'] === 'light' ? settings['appearance.theme'] : 'system'
      const size: TextSizeChoice = ['small', 'default', 'large', 'larger'].includes(String(settings['appearance.textSize'])) ? settings['appearance.textSize'] as TextSizeChoice : 'default'
      applySurfaceAppearance(root, theme, size, companion)
      try { localStorage.setItem('bloblex.appearance', JSON.stringify({ theme, textSize: size })) } catch { /* Daemon settings remain saved. */ }
    }).catch(() => { appearanceHydrated.current = false })
  }, [connection])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const change = () => {
      const root = document.documentElement
      if (!companion && root.dataset.themeChoice === 'system') applyAppearance(root, 'system', (root.dataset.textSize as TextSizeChoice) || 'default')
    }
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])

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
        const deletedSessionIds = snapshotRef.current?.deletedSessionIds ?? []
        let initial = preserveDeletedSessions(await fetchSnapshot(), deletedSessionIds)
        const replay = await rpc<{ events?: DaemonEvent[]; replayAvailable?: boolean }>('events.replay', { afterSequence: initial.sequence ?? 0 })
        if (replay.replayAvailable === false) initial = preserveDeletedSessions(await fetchSnapshot(), deletedSessionIds)
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
        missedWhileSubscribing.forEach(hydrateSessionChange)
        missedWhileSubscribing.forEach(refreshAppliedModelFromEvent)
        hydrateAgentChanges(missedWhileSubscribing)
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
    if (!snapshot || !selectedSessionId || sessions.some((session) => session.id === selectedSessionId)) return
    setSelectedSessionId(selectedSession?.id ?? null)
  }, [snapshot, sessions, selectedSessionId, selectedSession?.id])

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
    setCreateMenuOpen(false)
    const next = createDraft(runtimes, activeSelectedAgent?.runtimeId ?? selectedRuntime?.id ?? null)
    setDraft(next)
    setBaseline(next)
    setFormError(null)
    setRemoteNotice(null)
    setBlobPage({ mode: 'create', agentId: null })
  }

  const restoreMoreFocus = () => window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[aria-label="More options"]')?.focus())
  const restoreCreateFocus = () => window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[aria-label="Create blob"]')?.focus())

  const exportConversation = async (copy: boolean) => {
    if (!selectedSession) return
    const markdown = conversationMarkdown(selectedSession, agentName)
    try {
      if (copy) await navigator.clipboard.writeText(markdown)
      else {
        const selectionToken = await selectMarkdownExportPath()
        if (!selectionToken) return
        await writeMarkdownExport(selectionToken, markdown)
      }
      setError(null)
    } catch (reason) { setError(messageOf(reason)) }
    finally { restoreMoreFocus() }
  }

  const exportBlob = async (agent: Agent) => {
    const runtime = runtimes.find((item) => item.id === agent.runtimeId)
    if (!runtime) { setError('The coding agent for this blob is not available.'); return }
    try {
      const selectionToken = await selectBlobExportPath(agent.name)
      if (!selectionToken) return
      await writeBlobExport(selectionToken, serializeBlob(agent, runtime.provider))
      setError(null)
    } catch (reason) { setError(messageOf(reason)) }
  }

  const importBlob = async () => {
    setCreateMenuOpen(false)
    try {
      const selectionToken = await selectBlobImportPath()
      if (!selectionToken) { restoreCreateFocus(); return }
      setPendingBlobImport(parseSharedBlob(await readBlobImport(selectionToken)))
      setError(null)
    } catch (reason) { setError(messageOf(reason)); restoreCreateFocus() }
  }

  const createImportedBlob = (blob: SharedBlob, runtimeId: string) => {
    const next = createDraft(runtimes, runtimeId)
    next.name = blob.name
    next.description = blob.description
    next.color = blob.colour
    next.outfit = blob.outfit
    next.instructions = blob.instructions
    next.model = blob.model
    next.thinking = blob.thinking
    next.serviceTier = blob.speed
    next.approvalMode = blob.defaultApprovalMode ?? null
    setDraft(next)
    setBaseline(next)
    setBlobPage({ mode: 'create', agentId: null })
    setPendingBlobImport(null)
    setFormError(null)
  }

  const closeBlobPage = (focusId: string | null) => {
    setBlobPage(null)
    setFormError(null)
    window.setTimeout(() => {
      const row = focusId ? document.querySelector<HTMLButtonElement>(`[data-agent-id="${CSS.escape(focusId)}"]`) : null
      ;(row ?? document.querySelector<HTMLButtonElement>('[aria-label="Create blob"]'))?.focus()
    }, 0)
  }

  const closeAnalytics = () => {
    setAnalyticsOpen(false)
    window.setTimeout(() => usageLinkRef.current?.focus(), 0)
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

  const answerPermission = async (permission: PermissionRequest, choice: string): Promise<boolean> => {
    const now = Date.now()
    if (!isPendingPermissionLive(permission, now) || !isPermissionReplyAllowed(permission, choice)) {
      setPermissionClock(now)
      await refresh()
      setError('This approval expired or is no longer pending. No reply was sent. Check the refreshed request state before continuing.')
      return false
    }
    try { await doRpc('permission.reply', { permissionId: permission.id, choice }); await refresh(); return true } catch (reason) {
      await refresh()
      setError(messageOf(reason))
      return false
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

  const refreshQuota = () => {
    setQuotaRefreshing(true)
    void rpc('quota.refresh').catch((reason) => {
      setQuotaRefreshing(false)
      setError(messageOf(reason))
    })
    window.setTimeout(() => setQuotaRefreshing(false), 15_000)
  }

  const selectAgent = (agent: Agent) => {
    const latest = agentSessions(sessions, agent.id)[0] ?? null
    setSelectedAgentId(agent.id)
    setSelectedRuntimeId(agent.runtimeId)
    setSelectedSessionId(latest?.id ?? null)
    void setActiveRuntime(agent.runtimeId)
    void setActiveSession(latest?.id ?? null)
    setBlobPage((page) => page && page.agentId !== agent.id ? null : page)
  }
  const selectSession = (session: Session) => {
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
      <Companion agent={companionAgent} agents={agents} runtime={companionRuntime} runtimes={runtimes} session={companionSession} usage={snapshot?.usageSummary} connected={connection === 'connected'} appError={error} activityLabel={companionStatus.label} permission={companionPermission} approvalMode={companionMode} onReply={answerPermission} onNewSession={(anchor) => newSession(companionAgent?.id, anchor)} onOpenMain={() => void showMainWindow(companionSession?.id)} onOpenSettings={() => void showMainSettings(companionSession?.id)} onSendPrompt={(sessionId, text) => doRpc('session.prompt', { sessionId, text }).then(() => { void refreshTrayMenu().catch(() => undefined); return refresh() })} onCancelTurn={(sessionId) => doRpc('session.cancel', { sessionId }).then(() => { void refreshTrayMenu().catch(() => undefined); return refresh() })} onSelectAgent={selectAgent} />
      {chooserView}
    </>
  }

  const selectedMood = deriveCompanionStatus({ connected: connection === 'connected', runtime: selectedRuntime, session: selectedSession, composing: !!composer.trim(), now }).mood
  const sessionBusy = ['working', 'starting', 'waiting_permission'].includes(selectedSession?.state ?? '')
  const turnLive = ['working', 'waiting_permission'].includes(selectedSession?.state ?? '')
  const runtimeReady = runtimeUsable(selectedRuntime)
  const approvalFocusOnMount = !composerTypingRef.current || connection !== 'connected' || busy || selectedSession?.state === 'waiting_permission' || !runtimeReady
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
  const visibleSessions = sessions.filter((session) => session.archived !== true)
  const quickSwitcherItems: QuickSwitcherItem[] = [
    ...activeAgents(agents).map((agent) => ({ id: agent.id, kind: 'blob' as const, title: agent.name, subtitle: agent.description, searchText: `${agent.name} ${agent.description}` })),
    ...visibleSessions.map((session) => {
      const owner = agents.find((agent) => agent.id === session.agentId)
      const title = sessionDisplayTitle(session)
      const subtitle = owner?.name ?? labelize(session.provider, 'Blob')
      return { id: session.id, kind: 'conversation' as const, title, subtitle, searchText: `${title} ${subtitle} ${session.projectPath ?? ''}`, recentAt: session.updatedAt ?? session.createdAt ?? null }
    }),
    ...activeAgents(agents).flatMap((agent) => projectGroups(visibleSessions, agent.id).filter((project) => project.key !== null).map((project) => ({ id: `${agent.id}:${project.key}`, kind: 'project' as const, title: project.label, subtitle: agent.name, searchText: `${project.label} ${agent.name} ${project.path}` }))),
    ...(activeSelectedAgent ? [{ id: 'new-session', kind: 'action' as const, title: 'New session', subtitle: `For ${activeSelectedAgent.name}`, searchText: `New session ${activeSelectedAgent.name}` }] : []),
    { id: 'new-blob', kind: 'action', title: 'New blob', subtitle: '', searchText: 'New blob' },
    { id: 'usage', kind: 'action', title: 'Usage', subtitle: '', searchText: 'Usage limits' },
    { id: 'settings', kind: 'action', title: 'Settings', subtitle: '', searchText: 'Settings' },
    { id: 'find-agents', kind: 'action', title: 'Find coding agents', subtitle: '', searchText: 'Find coding agents runtime' },
    { id: 'toggle-details', kind: 'action', title: 'Toggle details panel', subtitle: '', searchText: 'Toggle details panel inspector' },
  ]
  const chooseQuickSwitcherItem = (item: QuickSwitcherItem) => {
    if (item.kind === 'blob') {
      const agent = agents.find((candidate) => candidate.id === item.id && !candidate.archived)
      if (agent) selectAgent(agent)
    } else if (item.kind === 'conversation') {
      const session = sessions.find((candidate) => candidate.id === item.id && !candidate.archived)
      if (session) selectSession(session)
    } else if (item.kind === 'project') {
      const [agentId, ...keyParts] = item.id.split(':')
      const key = keyParts.join(':')
      const agent = agents.find((candidate) => candidate.id === agentId && !candidate.archived)
      if (agent) {
        const project = projectGroups(visibleSessions, agent.id).find((candidate) => candidate.key === key)
        if (project?.sessions[0]) selectSession(project.sessions[0])
        else selectAgent(agent)
        patchExpanded(agent.id, (entry) => ({ ...entry, open: true, projects: { ...entry.projects, [key]: true } }))
      }
    } else {
      if (item.id === 'new-session' && activeSelectedAgent) newSession(activeSelectedAgent.id)
      else if (item.id === 'new-blob') openCreate()
      else if (item.id === 'usage') void showUsage()
      else if (item.id === 'settings') { setSettingsInitialPage('General'); setSettingsFocus(null); setSettingsSheet(true) }
      else if (item.id === 'find-agents') void refreshRuntimes()
      else if (item.id === 'toggle-details') toggleInspector()
    }
  }
  const noBlobs = activeAgents(agents).length === 0
  const showCreateBlobPrompt = connection === 'connected' && noBlobs && sessions.length > 0 && !analyticsOpen && !blobPage
  const launchWarnings = launchWarningsFor(launchChecks, runtimes)
  const retryLaunch = () => {
    launchAbort.current?.abort()
    setLaunchRunId((id) => id + 1)
  }
  const finishLaunch = () => {
    launchAbort.current?.abort()
    setLaunchVisible(false)
    void rpc<Record<string, unknown>>('settings.get').then(async (result) => {
      const settings = result.settings && typeof result.settings === 'object' ? result.settings as Record<string, unknown> : result
      if (settings['companion.openAtStartup'] === true) setPendingCompanionStartup(true)
    }).catch(() => undefined)
  }
  const finishOnboarding = () => {
    try {
      localStorage.setItem('bloblex.firstRun.complete', '1')
      localStorage.setItem('bloblex.firstRun.connected', '1')
    } catch { /* The flow remains complete for this run. */ }
    setOnboardingCompleteThisRun(true)
    setOnboardingVisible(false)
  }
  const createOnboardedBlob = async (runtime: Runtime, name: string, color: string) => {
    const draft = { ...starterDraft(runtime), name, color, approvalMode: 'ask' as const }
    try {
      const result = await doRpc<{ agent?: Agent }>('agent.create', createParams(draft), (reason) => messageForDaemonCode(daemonCodeOf(reason), 'agent.create'))
      if (!result.agent?.id) return null
      mergeAgent(result.agent)
      setSelectedAgentId(result.agent.id)
      setSelectedRuntimeId(result.agent.runtimeId)
      setSelectedSessionId(null)
      return result.agent
    } catch (reason) { setError(messageForDaemonCode(daemonCodeOf(reason), 'agent.create')); return null }
  }
  if (launchVisible && !companion) return <LaunchIntro checks={launchChecks} runtimes={runtimes} agent={activeSelectedAgent} serviceDown={launchServiceDown} onRetry={retryLaunch} onContinueOffline={() => { setConnection('disconnected'); finishLaunch() }} onComplete={finishLaunch} />
  if (onboardingVisible && !companion) return <FirstRunOnboarding runtimes={runtimes} scanning={refreshing} error={error} onScan={() => void refreshRuntimes()} onCreate={createOnboardedBlob} onFinish={finishOnboarding} onSaveName={saveProfileName} />
  return (
    <main className={`app-shell ${detailsVisible ? 'inspector-open' : ''} ${reducedLaunchFade ? 'reduced-launch-fade' : ''}`} style={{ ...(accent ? { '--agent-accent': accent } : {}), ...(reducedLaunchFade ? { '--launch-fade-duration': '180ms' } : {}) } as React.CSSProperties}>
      <aside className="sidebar" aria-label="Agents">
        <div className="sidebar-top">
          <div className="brand-lockup"><img className="brand-logo" src={bloblexLogo} alt="Bloblex logo" /><strong>Bloblex</strong></div>
          <div className="sidebar-create-actions">
            <button type="button" className="icon-button" title="Quick switcher" aria-label="Open quick switcher" onClick={() => setQuickSwitcherOpen(true)}><Search size={16} /></button>
            <button className="icon-button" title="Create blob" aria-label="Create blob" disabled={connection !== 'connected' || busy || runtimes.length === 0} onClick={openCreate}><Plus size={17} /></button>
            <div className="more-menu-wrap" onKeyDown={(event) => { if (event.key === 'Escape') { setCreateMenuOpen(false); restoreCreateFocus() } }}>
              <button type="button" className="icon-button small" title="Import a blob setup" aria-label="Blob actions" aria-haspopup="menu" aria-expanded={createMenuOpen} disabled={connection !== 'connected' || busy} onClick={() => setCreateMenuOpen((open) => !open)}><ChevronDown size={14} /></button>
              {createMenuOpen && <div className="menu-surface more-menu" role="menu"><button className="menu-item" role="menuitem" onClick={() => void importBlob()}>Import blob…</button></div>}
            </div>
          </div>
        </div>
        <div className="sr-only" aria-live="polite">{rosterAnnouncement}</div>
        <AgentRoster agents={agents} sessions={sessions} runtimes={runtimes} connected={connection === 'connected'} busy={busy} now={now} pins={pins} showSetupEmptyState={false} unreadSessionIds={unreadSessionIds} approvalSessionIds={approvalSessionIds} onToggleFavorite={(agentId) => updatePins((current) => toggleFavorite(current, agentId))} onMoveFavorite={(agentId, targetId, placement, visibleIds) => updatePins((current) => moveFavoriteRelative(current, agentId, targetId, placement, visibleIds))} onMovePinned={(itemId, targetId, placement, visibleIds) => updatePins((current) => movePinnedItemRelative(current, itemId, targetId, placement, visibleIds))} onTogglePinProject={(project) => updatePins((current) => togglePinnedProject(current, project))} onTogglePinSession={(sessionId) => updatePins((current) => togglePinnedSession(current, sessionId))} onRevealProject={(agentId, key) => patchExpanded(agentId, (entry) => ({ ...entry, open: true, projects: { ...entry.projects, [key]: true } }))} selectedAgentId={activeSelectedAgent?.id ?? null} selectedSessionId={selectedSession?.id ?? null} query={search} expanded={expanded} onQueryChange={setSearch} onSelect={selectAgent} onCreate={openCreate} onScan={() => void refreshRuntimes()} onNewSession={(agent) => newSession(agent.id)} onEdit={openEdit} onDuplicate={(agent) => void duplicateAgent(agent)} onArchive={setArchiveTarget} onExportBlob={(agent) => void exportBlob(agent)} onToggleBlob={(agentId) => patchExpanded(agentId, (entry) => ({ ...entry, open: !entry.open }))} onToggleProject={(agentId, key) => patchExpanded(agentId, (entry) => ({ ...entry, projects: { ...entry.projects, [key]: entry.projects[key] !== true } }))} onToggleOther={(agentId) => patchExpanded(agentId, (entry) => ({ ...entry, other: !entry.other }))} onSelectSession={selectSession} onRenameSession={(session, title) => { void rpc('session.rename', { sessionId: session.id, title }).catch((reason) => setError(messageOf(reason))) }} onArchiveSession={(session) => { void rpc('session.archive', { sessionId: session.id, archived: true }).catch((reason) => setError(messageOf(reason))) }} onDeleteSession={setSessionDeleteTarget} onNewSessionInProject={(agent, path) => void createSession(agent, path, 'project')} onResumeSession={(session) => { selectSession(session); void resumeSession(session) }} onCancelSession={(session) => { selectSession(session); void cancelTurn(session) }} />
        <button type="button" role="switch" aria-label="Companion, keep your blob on screen while you work" aria-checked={companionVisible} className="companion-sidebar-card" onClick={() => { void setCompanionVisibility(!companionVisible).catch((reason) => setError(messageOf(reason))) }}><BlobCanvas color="#b7a7f4" size={30} mini mood="idle" label="Companion" /><span><strong>Companion</strong><small>Keep your blob on screen while you work</small></span><i className={`toggle ${companionVisible ? 'on' : ''}`} aria-hidden="true"><b /></i></button>
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
        {launchWarnings.length > 0 && !agentWarningDismissed && <LaunchWarnings warnings={launchWarnings} onSettings={() => { setSettingsInitialPage('Agents'); setSettingsSheet(true) }} onDismiss={() => setAgentWarningDismissed(true)} />}
        {analyticsOpen ? <AnalyticsView sessions={sessions} agents={agents} connected={connection === 'connected'} onBack={closeAnalytics} /> : blobPage && draft ? <BlobPage mode={blobPage.mode} agent={editingAgent} draft={draft} runtime={draftRuntime} session={blobPage.mode === 'edit' ? selectedSession : null} runtimes={runtimes} sessions={pageSessions} legacyCount={pageLegacy.length} connected={connection === 'connected'} saving={busy} dirty={draftDirty} ready={draftReady} canStartSession={connection === 'connected' && !busy && runtimeUsable(draftRuntime)} error={formError} remoteNotice={remoteNotice} errors={fieldErrors} execution={executionFromAgent(editingAgent)} autoApprovals={snapshot?.autoApprovals ?? []} bypassNotices={snapshot?.bypassNotices ?? []} onDraftChange={(next) => { setDraft(next); setFormError(null) }} onExecutionGate={(gate) => { executionGate.current = gate }} onBack={() => closeBlobPage(editingAgent?.id ?? activeSelectedAgent?.id ?? null)} onSave={() => void saveBlob()} onCancel={() => { const source = remoteNotice && editingAgent ? draftFromAgent(editingAgent) : baseline; if (!source) return; setDraft(source); setBaseline(source); setRemoteNotice(null); setFormError(null) }} onArchive={() => { if (editingAgent) setArchiveTarget(editingAgent) }} onNewSession={() => { if (editingAgent) newSession(editingAgent.id) }} onOpenSession={(session) => { setSelectedSessionId(session.id); closeBlobPage(editingAgent?.id ?? null) }} /> : <>
        {showCreateBlobPrompt && <div className="first-run-prompt" role="status"><span>No blobs yet. Create one to organize these conversations.</span><button type="button" className="secondary-button small" onClick={openCreate}>Create blob</button></div>}
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
            <ApprovalPill mode={headerMode} />
            {selectedSession?.resumable && !sessionBusy && <button className="icon-button" title="Resume conversation" aria-label="Resume conversation" disabled={busy || connection !== 'connected' || !runtimeReady} onClick={() => void resumeSession()}><Play size={15} /></button>}
            <button className="icon-button" title="New session" aria-label="New session" disabled={!canStartSession} onClick={(event) => newSession(undefined, event.currentTarget)}><SquarePen size={16} /></button>
            <button className={`icon-button ${inspectorOpen ? 'active' : ''}`} title="Details" aria-label="Toggle context pane" aria-pressed={inspectorOpen} onClick={toggleInspector}><PanelRight size={16} /></button>
            <div className="more-menu-wrap" onKeyDown={(event) => { if (event.key === 'Escape') { setMoreOpen(false); restoreMoreFocus() } }}>
              <button className="icon-button" title="More options" aria-label="More options" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}><MoreHorizontal size={17} /></button>
              {moreOpen && <div className="menu-surface more-menu" role="menu"><button className="menu-item" role="menuitem" disabled={refreshing} onClick={() => { setMoreOpen(false); void refresh() }}><RefreshCw size={15} />Refresh state</button><button className="menu-item" role="menuitem" disabled={!selectedSession} onClick={() => { setMoreOpen(false); void showUsage() }}><Gauge size={15} />Usage details</button><button className="menu-item" role="menuitem" disabled={!selectedSession} onClick={() => { setMoreOpen(false); void exportConversation(true) }}>Copy as Markdown</button><button className="menu-item" role="menuitem" disabled={!selectedSession} onClick={() => { setMoreOpen(false); void exportConversation(false) }}>Export as Markdown…</button>{activeSelectedAgent && <button className="menu-item" role="menuitem" onClick={() => { setMoreOpen(false); openEdit(activeSelectedAgent) }}><Settings2 size={15} />Blob settings</button>}<span className="menu-separator" /><button role="menuitem" className="menu-item danger" onClick={() => void quitBloblex()}><X size={15} />Quit Bloblex</button></div>}
            </div>
          </div>
        </header>

        {error && <div className="inline-error" role="alert"><ShieldAlert size={16} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}><X size={15} /></button></div>}
        {archiveNotice && <div className="inline-error" role="status"><span>{archiveNotice}</span><button aria-label="Dismiss notice" onClick={() => setArchiveNotice(null)}><X size={15} /></button></div>}

        {!selectedSession ? <>{activePermission && <ApprovalCard permission={activePermission} onReply={(choice) => answerPermission(activePermission, choice)} /> }<EmptyConversation connected={connection === 'connected'} hasRuntime={runtimes.length > 0} hasAgent={!!activeSelectedAgent} accent={accent} mood={selectedMood} agentName={agentName} outfit={activeSelectedAgent?.outfit ?? 'auto'} createdAt={activeSelectedAgent?.createdAt ?? null} onNewSession={(anchor) => newSession(undefined, anchor)} onCreate={openCreate} onRefresh={() => void refreshRuntimes()} /></> : <>
          <section ref={messageListRef} className="message-list" aria-label="Conversation" onScroll={(event) => { const node = event.currentTarget; stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72 }}>
            <div className="conversation-layout">
              <ConversationOutline key={selectedSession.id} sessionId={selectedSession.id} items={outlineItems} />
              <div className="chat-column">
              {groupedConversationItems.length === 0 ? <div className="session-first-state"><BlobCanvas color={accent || '#e6e9ee'} size={112} mood={selectedMood} outfit={activeSelectedAgent?.outfit ?? 'auto'} createdAt={activeSelectedAgent?.createdAt ?? null} label={activeSelectedAgent?.name ?? agentName} /><h2>Ready when you are.</h2><p>Ask {agentName} to explore <code>{currentProjectName ?? 'the project'}</code> or make a change.</p></div> : groupedConversationItems.map((item, index) => item.kind === 'activity-group'
                ? <ActivityGroupRow key={item.id} group={item} onDiff={(path, content) => setDiffViewer({ path, content })} />
                : item.kind === 'message'
                  ? <MessageItem key={item.id} id={`conversation-message-${encodeURIComponent(item.id)}`} message={item.value!} accent={accent} agentName={agentName} showAvatar={!isUserMessage(item.value) && (index === 0 || isPreviousItemNonMessageOrUser(groupedConversationItems, index))} mood={index === lastAgentIndex ? selectedMood : 'idle'} />
                  : <ActivityItem key={item.id} item={item} onDiff={(path, content) => setDiffViewer({ path, content })} />)}
              {activePermission && <ApprovalCard permission={activePermission} focusOnMount={approvalFocusOnMount} onReply={(choice) => answerPermission(activePermission, choice)} />}
              {selectedSession.state === 'working' && <div className="working-indicator" role="status"><span className="typing" aria-hidden="true"><i /><i /><i /></span>{agentName} is working</div>}
              </div>
            </div>
          </section>
          <div className="composer-wrap">
            {dictationPartial && <div className="dictation-partial" role="status"><span className="dictation-partial-label">Listening</span>{dictationPartial}</div>}
            <div className="composer-box">
              <textarea ref={composerRef} value={composer} onFocus={() => { composerTypingRef.current = true }} onBlur={() => { composerTypingRef.current = false }} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendPrompt() } }} placeholder={`Message ${agentName}`} aria-label={`Message ${agentName}`} disabled={connection !== 'connected' || busy || selectedSession.state === 'waiting_permission' || !runtimeReady} rows={1} />
              <div className="composer-control-strip">
                <ContextWindowIndicator used={selectedSession.contextUsed} size={selectedSession.contextSize} />
                {selectedSession && activeSelectedAgent && <SessionExecutionControls session={selectedSession} agent={activeSelectedAgent} onSessionUpdated={(updated) => setSnapshot((current) => current ? mergeHydratedSession(current, updated.id, updated) : current)} onError={(reason) => setError(messageOf(reason))} />}
                <DictationButton owner="desktop" onFinal={(text) => setComposer((current) => (current ? `${current} ${text}` : text))} onPartial={setDictationPartial} disabled={connection !== 'connected' || busy || selectedSession.state === 'waiting_permission' || !runtimeReady} />
                <button className={`send-button ${turnLive ? 'cancel' : ''}`} onClick={turnLive ? () => void cancelTurn() : () => void sendPrompt()} disabled={busy || (!turnLive && (!composer.trim() || !runtimeReady))} aria-label={turnLive ? 'Cancel turn' : 'Send message'}>{busy ? <LoaderCircle size={16} className="spinning" /> : turnLive ? <Square size={12} fill="currentColor" /> : <ArrowUp size={17} />}</button>
              </div>
            </div>
            <div className="composer-note">{currentProjectName ? <><FolderOpen size={11} />{currentProjectName}<span>·</span></> : null}Agent actions run on your device. You approve what matters.</div>
          </div>
        </>}
        </>}
      </section>

      <aside className="context-pane" aria-label="Conversation details" aria-hidden={!detailsVisible} inert={!detailsVisible}>
        <section className="context-head">
          {activeSelectedAgent ? <BlobCanvas color={accent} size={64} mood={selectedMood} outfit={activeSelectedAgent.outfit} createdAt={activeSelectedAgent.createdAt} label={activeSelectedAgent.name} /> : <span className="context-head-placeholder"><Code2 size={20} /></span>}
          <h2>{agentName}</h2>
          <p>{selectedRuntime ? [labelize(selectedRuntime.provider), selectedRuntime.version].filter(Boolean).join(' · ') : 'No coding agent selected'}</p>
        </section>
        <div className="context-tabs" role="tablist" aria-label="Conversation context">{(['Details', 'Runtime', 'Files'] as ContextTab[]).map((name, index, tabs) => <button key={name} type="button" id={`context-tab-${name.toLowerCase()}`} role="tab" aria-controls="context-panel" aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} className={tab === name ? 'active' : ''} onClick={() => setTab(name)} onKeyDown={(event) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const targetIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length; const target = tabs[targetIndex]; setTab(target); document.getElementById(`context-tab-${target.toLowerCase()}`)?.focus() }}>{name}</button>)}</div>
        <div id="context-panel" role="tabpanel" aria-labelledby={`context-tab-${tab.toLowerCase()}`} tabIndex={0} className="context-tab-panel">
          {tab === 'Details' && <DetailsPane session={selectedSession} model={appliedModelForDetails} usage={snapshot?.usageSummary ?? null} onUsage={() => void showUsage()} />}
          {tab === 'Runtime' && <RuntimePane runtime={selectedRuntime} connected={connection === 'connected'} onRefresh={() => void refreshRuntimes()} refreshing={refreshing} />}
          {tab === 'Files' && <FilesPane session={selectedSession} onOpen={(path) => void openInEditor(path, selectedSession?.projectPath).catch((reason) => setError(messageOf(reason)))} onReveal={(path) => void revealInExplorer(path, selectedSession?.projectPath).catch((reason) => setError(messageOf(reason)))} onCopy={async (path) => { try { await navigator.clipboard.writeText(await resolveProjectFile(path, selectedSession?.projectPath)) } catch (reason) { setError(messageOf(reason)) } }} onDiff={(path, content) => setDiffViewer({ path, content })} />}
        </div>
      </aside>

      {!companion && <QuotaMeter quotas={snapshot?.quotas ?? []} onOpen={() => void showUsage()} />}
      {usageSheet && <UsageSheet summary={usageSummary} period={usagePeriod} quotas={snapshot?.quotas ?? []} loading={busy && usageSummary === null} quotaRefreshing={quotaRefreshing} onRefreshQuota={refreshQuota} onPeriodChange={(period) => { setUsageSummary(null); void showUsage(period) }} onClose={() => setUsageSheet(false)} />}
      {quickSwitcherOpen && <QuickSwitcher items={quickSwitcherItems} onChoose={chooseQuickSwitcherItem} onClose={() => setQuickSwitcherOpen(false)} />}
      {settingsSheet && <SettingsSheet snapshot={snapshot} initialPage={settingsInitialPage} focusUpdates={settingsFocus === 'updates'} onClose={() => { setSettingsSheet(false); setSettingsFocus(null) }} onRefresh={refreshRuntimes} onError={setError} onRunSetup={() => { setSettingsSheet(false); setOnboardingVisible(true) }} onOpenAgent={(agentId) => { const target = agents.find((agent) => agent.id === agentId); setSettingsSheet(false); if (target) openEdit(target) }} />}
      {diffViewer && <DiffViewer path={diffViewer.path} content={diffViewer.content} onClose={() => setDiffViewer(null)} />}
      {chooserView}
      {archiveTarget && <ConfirmDialog title={`Archive ${archiveTarget.name}?`} body="It leaves the roster. Its conversations stay saved. Restoring a blob is not available yet." confirmLabel="Archive" cancelLabel="Cancel" onConfirm={() => void confirmArchive()} onCancel={() => setArchiveTarget(null)} />}
      {sessionDeleteTarget && <ConfirmDialog title="Delete this conversation?" body="This removes it and its messages from Bloblex. The coding agent's own history is not touched." confirmLabel="Delete" cancelLabel="Cancel" holdToConfirm successTitle="Conversation deleted" successBody="This conversation and its messages were removed from Bloblex." onConfirm={async () => { await rpc('session.delete', { sessionId: sessionDeleteTarget.id }) }} onComplete={() => { setSessionDeleteTarget(null); focusSidebarBlob() }} onCancel={() => { const id = sessionDeleteTarget.id; setSessionDeleteTarget(null); focusSidebarSession(id) }} />}
      {pendingBlobImport && <ImportBlobDialog blob={pendingBlobImport} runtimes={runtimes} onCancel={() => { setPendingBlobImport(null); restoreCreateFocus() }} onCreate={(runtimeId) => createImportedBlob(pendingBlobImport, runtimeId)} />}
    </main>
  )
}

function ImportBlobDialog({ blob, runtimes, onCancel, onCreate }: { blob: SharedBlob; runtimes: Runtime[]; onCancel: () => void; onCreate: (runtimeId: string) => void }) {
  const { ref, close } = useDialogAccessibility(onCancel)
  const suggested = runtimes.find((runtime) => runtime.provider === blob.providerId)?.id ?? runtimes[0]?.id ?? ''
  const [runtimeId, setRuntimeId] = useState(suggested)
  return <div className="sheet-backdrop blob-dialog-backdrop"><section ref={ref} className="blob-dialog" role="dialog" aria-modal="true" aria-labelledby="import-blob-title" tabIndex={-1}>
    <h2 id="import-blob-title">Import {blob.name}</h2>
    <p>This opens a new blob draft. Nothing is created until you choose Create blob.</p>
    {runtimes.length === 0 ? <p role="alert">No coding agents are available. Scan again before importing.</p> : <label className="settings-field"><span>Attach to coding agent</span><Select ariaLabel="Attach imported blob to coding agent" variant="field" align="left" value={runtimeId} onChange={setRuntimeId} options={runtimes.map((runtime) => ({ value: runtime.id, label: `${providerBrand(runtime.provider).name}${runtime.provider === blob.providerId ? ' · matching provider' : ''}`, provider: runtime.provider }))} /></label>}
    <div className="blob-dialog-actions"><button type="button" className="secondary-button" data-dialog-initial-focus onClick={close}>Cancel</button><button type="button" className="primary-button" disabled={!runtimeId} onClick={() => onCreate(runtimeId)}>Continue</button></div>
  </section></div>
}

function EmptyConversation({ connected, hasRuntime, hasAgent, accent, mood, agentName, outfit, createdAt, onNewSession, onCreate, onRefresh }: { connected: boolean; hasRuntime: boolean; hasAgent: boolean; accent: string; mood: BlobMood; agentName: string; outfit: Agent['outfit']; createdAt: Agent['createdAt'] | null; onNewSession: (anchor?: HTMLElement | null) => void; onCreate: () => void; onRefresh: () => void }) {
  const canvas = hasAgent ? <BlobCanvas color={accent} size={128} mood={connected ? mood : 'offline'} outfit={outfit} createdAt={createdAt} label={agentName} /> : <BlobCanvas color="#e6e9ee" size={128} mood={connected ? 'idle' : 'offline'} outfit="auto" createdAt={null} label="Bloblex" />
  const heading = !connected ? 'Connect to your local runtime' : hasAgent ? `Start a conversation with ${agentName}` : hasRuntime ? 'No blobs yet.' : 'Find your coding agent'
  const description = !connected ? 'Bloblex keeps its daemon and agent sessions on this device. Reconnect to load the latest state.' : hasAgent ? 'Choose a project folder. Your selected CLI starts a real session there.' : hasRuntime ? 'Create a blob for one of the coding CLIs on this device.' : 'We only show agents installed on this device. Refresh to scan for Claude Code, Codex, or OpenCode.'
  const label = !connected ? 'Try again' : hasAgent ? 'Choose a project' : hasRuntime ? 'Create blob' : 'Scan for agents'
  return <div className="empty-conversation"><div className="empty-art">{canvas}</div><h1>{heading}</h1><p className="empty-description">{description}</p><button className="primary-button" onClick={(event) => { if (!connected || !hasAgent && !hasRuntime) onRefresh(); else if (hasAgent) onNewSession(event.currentTarget); else onCreate() }} disabled={!connected && !hasRuntime}><FolderOpen size={15} />{label}</button></div>
}

function MessageItem({ id, message, accent, agentName, showAvatar, mood }: { id: string; message: Record<string, unknown>; accent: string; agentName: string; showAvatar: boolean; mood: BlobMood }) {
  const isUser = isUserMessage(message)
  const role = String(message.role ?? message.kind ?? 'assistant').toLowerCase()
  const text = typeof message.text === 'string' ? message.text : typeof message.content === 'string' ? message.content : typeof message.delta === 'string' ? message.delta : ''
  const toolName = typeof message.toolName === 'string' ? message.toolName : typeof message.tool === 'string' ? message.tool : undefined
  const eventType = typeof message.eventType === 'string' ? message.eventType : ''
  const isTool = Boolean(toolName) || eventType.startsWith('tool.') || eventType.startsWith('command.')
  const isError = message.status === 'error' || role === 'error' || eventType === 'turn.error'
  const time = typeof message.createdAt === 'string' ? new Date(message.createdAt) : null
  const stamp = time && !Number.isNaN(time.valueOf()) ? <time>{time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time> : null
  return <article id={id} tabIndex={-1} className={`message-row ${isUser ? 'user' : 'agent'} ${showAvatar ? 'group-start' : ''}`} aria-label={isUser ? 'You' : agentName} data-mood={isError ? 'error' : mood} data-accent={accent || undefined}>
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

export function ActivityGroupRow({ group, onDiff }: { group: Extract<GroupedConversationItem, { kind: 'activity-group' }>; onDiff?: (path: string, content: string) => void }) {
  const startsExpanded = group.failed > 0 || group.runningTitle !== null
  const [expanded, setExpanded] = useState(startsExpanded)
  useEffect(() => { if (startsExpanded) setExpanded(true) }, [startsExpanded])
  const commandLabel = `${group.commands} ${group.commands === 1 ? 'command' : 'commands'}`
  const fileLabel = `${group.files} ${group.files === 1 ? 'file' : 'files'}`
  const summary = group.runningTitle
    ? `Running ${group.runningTitle}…`
    : [group.commands ? `Ran ${commandLabel}` : '', group.files ? `edited ${fileLabel}` : ''].filter(Boolean).join(' · ')
  return <section className={`activity-group ${group.failed ? 'error' : ''}`}>
    <button type="button" className="ghost-button small activity-group-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      {group.failed > 0 && <ShieldAlert size={14} aria-hidden="true" />}
      {group.runningTitle ? <span className="typing" aria-hidden="true"><i /><i /><i /></span> : null}
      <span>{summary || `${group.items.length} activities`}{group.failed > 0 ? ` · ${group.failed} failed` : ''}</span>
      {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
    </button>
    {expanded && <div className="activity-group-items">{group.items.map((item) => <ActivityItem key={item.id} item={item} onDiff={onDiff} />)}</div>}
  </section>
}

function isPreviousItemNonMessageOrUser(items: GroupedConversationItem[], index: number) {
  const previous = items[index - 1]
  return previous?.kind !== 'message' || isUserMessage(previous.value)
}

function focusSidebarSession(sessionId: string) {
  window.setTimeout(() => {
    const row = [...document.querySelectorAll<HTMLElement>('[data-session-id]')].find((item) => item.dataset.sessionId === sessionId)
    ;(row ?? document.querySelector<HTMLElement>('.bot-row[aria-current="true"]'))?.focus()
  }, 0)
}

function focusSidebarBlob() {
  window.setTimeout(() => document.querySelector<HTMLElement>('.bot-row[aria-current="true"]')?.focus(), 0)
}

function preserveDeletedSessions(snapshot: Snapshot, deletedIds: string[]): Snapshot {
  const deletedSessionIds = [...new Set([...(snapshot.deletedSessionIds ?? []), ...deletedIds])]
  if (!deletedSessionIds.length) return snapshot
  const deleted = new Set(deletedSessionIds)
  return { ...snapshot, deletedSessionIds, sessions: (snapshot.sessions ?? []).filter((session) => !deleted.has(session.id)) }
}

function mergeHydratedSession(snapshot: Snapshot, id: string, fullSession: Session): Snapshot {
  if (snapshot.deletedSessionIds?.includes(id)) return snapshot
  const sessions = snapshot.sessions ?? []
  if (fullSession.archived) return { ...snapshot, sessions: sessions.filter((session) => session.id !== id) }
  const existing = sessions.find((session) => session.id === id)
  if (!existing) return snapshot
  const merged = {
    ...fullSession,
    ...existing,
    messages: fullSession.messages ?? existing.messages,
    turns: fullSession.turns ?? existing.turns,
    tools: fullSession.tools ?? existing.tools,
    files: fullSession.files ?? existing.files,
    modelLock: fullSession.modelLock === undefined ? existing.modelLock : fullSession.modelLock,
    contextUsed: fullSession.contextUsed === undefined ? existing.contextUsed : fullSession.contextUsed,
    contextSize: fullSession.contextSize === undefined ? existing.contextSize : fullSession.contextSize,
  }
  return { ...snapshot, sessions: [...sessions.filter((session) => session.id !== id), merged] }
}

function ActivityItem({ item, onDiff }: { item: ConversationItem; onDiff?: (path: string, content: string) => void }) {
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
    {typeof activity.diff === 'string' && <button type="button" className="ghost-button small activity-diff-button" onClick={() => onDiff?.(String(activity.path ?? activity.filePath ?? activity.title ?? 'Reported change'), activity.diff as string)}>View reported diff</button>}
    {typeof activity.output === 'string' && activity.output !== detail && <details className="activity-detail"><summary>Output</summary><pre>{activity.output}</pre></details>}
  </article>
}

function SafeMessageText({ text }: { text: string }) {
  return <SafeMarkdown text={text} onOpenLink={(url) => void openSafeLink(url)} />
}

function DetailRow({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return <div className="detail-row"><span>{label}</span><strong className={mono ? 'mono' : undefined}>{value}</strong></div>
}

function DetailsPane({ session, model, usage, onUsage }: { session: Session | null; model: string | null; usage: Record<string, unknown> | null; onUsage: () => void }) {
  return <div className="context-scroll">
    <section className="context-section">
      <h3>Conversation</h3>
      {session ? <div className="detail-list">
        <DetailRow label="Title" value={formatUnknownSafe(session.title, fileNameForPath(session.projectPath ?? '') ?? 'Untitled')} />
        <DetailRow label="Project" value={session.projectPath ?? 'Unavailable'} mono />
        <DetailRow label="Status" value={labelize(session.state, 'Unknown')} />
        <DetailRow label="Model" value={model?.trim() ?? 'Unknown'} />
      </div> : <p className="context-empty">No conversation selected.</p>}
    </section>
    <section className="context-section usage-section">
      <h3>Usage <small className="usage-scope">All blobs, all time</small></h3>
      <div className="detail-list">
        <DetailRow label="Input tokens" value={tokenValue(usage?.inputTokens)} />
        <DetailRow label="Output tokens" value={tokenValue(usage?.outputTokens)} />
      </div>
      <button type="button" className="secondary-button small context-action" onClick={onUsage}>Usage details</button>
      <p className="honesty-note">Token usage is recorded when providers report it. Account quota is shown separately.</p>
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
  const turns = session?.turns ?? []
  const turnInfo = new Map(turns.map((turn, index) => {
    const at = [turn.completedAt, turn.updatedAt, turn.startedAt, turn.createdAt].find((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    return [String(turn.id ?? turn.turnId ?? ''), { index, at: typeof at === 'string' ? Date.parse(at) : 0 }] as const
  }))
  const groups = new Map<string, { id: string; label: string; index: number; at: number; sequence: number; files: Array<Record<string, unknown>> }>()
  for (const file of files) {
    const id = typeof file.turnId === 'string' ? file.turnId : ''
    const info = id ? turnInfo.get(id) : undefined
    const order = info?.index ?? -1
    const sequence = typeof file.sequence === 'number' ? file.sequence : 0
    const key = id || '__ungrouped__'
    const title = id ? `Turn ${order >= 0 ? order + 1 : 'with changes'}` : 'Other changes'
    const changedAt = typeof file.changedAt === 'string' ? Date.parse(file.changedAt) : 0
    const group = groups.get(key) ?? { id: key, label: title, index: order, at: info?.at || (Number.isFinite(changedAt) ? changedAt : 0), sequence, files: [] }
    group.sequence = Math.max(group.sequence, sequence)
    group.files.push(file)
    groups.set(key, group)
  }
  const orderedGroups = [...groups.values()].sort((a, b) => b.at - a.at || b.index - a.index || b.sequence - a.sequence)
  const renderFile = (file: Record<string, unknown>, index: number) => {
    const path = String(file.path ?? file.filePath ?? 'Unknown path')
    const diff = typeof file.diff === 'string' ? file.diff : typeof file.patch === 'string' ? file.patch : null
    const parsed = diff ? parseUnifiedDiff(diff) : null
    const added = typeof file.addedLines === 'number' ? file.addedLines : typeof file.additions === 'number' ? file.additions : parsed?.additions ?? null
    const removed = typeof file.removedLines === 'number' ? file.removedLines : typeof file.deletions === 'number' ? file.deletions : parsed?.deletions ?? null
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
  }
  const hasTurnInformation = files.some((file) => typeof file.turnId === 'string' && file.turnId)
  return <div className="context-scroll"><div className="file-list">{hasTurnInformation ? orderedGroups.map((group) => <section className="file-turn-group" key={group.id}><h3>{group.label}</h3>{group.files.map(renderFile)}</section>) : files.map(renderFile)}</div></div>
}

function DiffViewer({ path, content, onClose }: { path: string; content: string; onClose: () => void }) {
  const { ref: dialogRef, close } = useDialogAccessibility(onClose)
  const parsed = parseUnifiedDiff(content)
  return <div className="sheet-backdrop diff-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><section ref={dialogRef} className="diff-sheet" role="dialog" aria-modal="true" aria-labelledby="diff-title"><header><div><p className="eyebrow">FILE CHANGE</p><h2 id="diff-title">{fileNameForPath(path)}</h2><small>{path}</small></div><span className="diff-counts"><em>+{parsed.additions}</em><i>−{parsed.deletions}</i></span><button className="icon-button" data-dialog-initial-focus aria-label="Close diff" onClick={close}><X size={17} /></button></header>
    <div className="diff-content" role="region" aria-label={`Diff for ${path}`} tabIndex={0}>{parsed.empty ? <p className="diff-empty">No diff content was reported.</p> : parsed.binary ? <p className="diff-empty">Binary file change. Text lines are unavailable.</p> : <pre>{parsed.lines.map((line, index) => <span className={`diff-line ${line.kind}`} key={`${index}-${line.text}`}><span className="diff-number">{line.oldNumber ?? ''}</span><span className="diff-number">{line.newNumber ?? ''}</span><code>{line.text}</code></span>)}</pre>}</div>
  </section></div>
}

function QuotaMeter({ quotas, onOpen }: { quotas: Record<string, unknown>[]; onOpen: () => void }) {
  const available = quotas.filter(isQuotaProvider)
  return <button type="button" className="quota-meter-row" aria-label="Open provider quota details" onClick={onOpen}>
    <span className="quota-meter-label"><Gauge size={14} />Account quota</span>
    {available.length ? available.map((item) => <QuotaSummary key={String(item.provider)} item={item} compact />) : <span className="quota-meter-empty">No supported account quota source available</span>}
    <span className="quota-meter-open">Usage details <ArrowUpRight size={13} /></span>
  </button>
}

function QuotaDetails({ quotas, refreshing, onRefresh }: { quotas: Record<string, unknown>[]; refreshing: boolean; onRefresh: () => void }) {
  const available = quotas.filter(isQuotaProvider)
  return <section className="usage-block quota-details" aria-label="Provider quota">
    <div className="usage-block-heading"><h3>Provider quota</h3><span>Separate from token usage</span><button type="button" className="secondary-button small" onClick={onRefresh} disabled={refreshing}>{refreshing ? 'Checking…' : 'Refresh quota'}</button></div>
    {available.length ? available.map((item) => <QuotaSummary key={String(item.provider)} item={item} />) : <p className="usage-empty-line">No supported provider account quota source is available.</p>}
  </section>
}

function isQuotaProvider(item: Record<string, unknown>) {
  return ['codex', 'claude', 'opencode'].includes(String(item.provider))
}

function QuotaSummary({ item, compact = false }: { item: Record<string, unknown>; compact?: boolean }) {
  const snapshot = recordFrom(item.snapshot)
  const limits = Array.isArray(snapshot.limits) ? snapshot.limits.filter((limit): limit is Record<string, unknown> => !!limit && typeof limit === 'object') : []
  const fetched = typeof item.fetchedAt === 'string' ? new Date(item.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null
  const label = item.provider === 'opencode' ? 'OpenCode Go' : item.provider === 'claude' ? 'Claude Code' : labelize(item.provider, 'Provider')
  const lastError = typeof item.lastError === 'string' ? item.lastError : null
  const errorCopy: Record<string, string> = {
    no_credentials: item.provider === 'opencode' ? 'OpenCode Go sign-in not found' : 'Claude Code sign-in not found',
    unauthorized: 'Sign-in rejected; check the CLI sign-in',
    no_subscription: 'No OpenCode Go subscription',
    protocol: 'Quota response unreadable',
    timeout: 'Check timed out; last successful reading retained',
    unavailable: 'Temporarily unavailable; last successful reading retained',
  }
  const staleErrorCopy: Record<string, string> = {
    no_credentials: 'No matching CLI sign-in; showing last successful reading',
    unauthorized: 'CLI sign-in was rejected; showing last successful reading',
    no_subscription: 'No Go subscription on latest check; showing last successful reading',
    protocol: 'Latest quota response was unreadable; showing last successful reading',
    timeout: 'Check timed out; last successful reading retained',
    unavailable: 'Refresh failed; last successful reading retained',
  }
  if (compact) {
    const primaryLimit = limits.find((limit) => typeof recordFrom(limit.primary).usedPercent === 'number')
    const primary = primaryLimit ? recordFrom(primaryLimit.primary) : null
    const usedPercent = primary && typeof primary.usedPercent === 'number' ? primary.usedPercent : null
    const displayedPercent = usedPercent === null ? null : Math.max(0, Math.min(100, usedPercent))
    const duration = primary && typeof primary.windowDurationMins === 'number' ? primary.windowDurationMins : null
    const windowLabel = duration === 300 ? '5h' : duration === 10080 ? '7d' : String(primaryLimit?.label ?? 'quota')
    const compactStatus = lastError ? errorCopy[lastError] ?? 'Quota unavailable' : 'Quota unavailable'
    const accessibleSummary = displayedPercent === null ? `${label}: ${compactStatus}` : `${label}, ${windowLabel} window, ${displayedPercent}% used`
    return <span className="quota-provider compact" data-provider={String(item.provider ?? 'unknown')} role="group" aria-label={accessibleSummary} title={accessibleSummary}>
      <ProviderLogo provider={String(item.provider ?? '')} size={16} />
      <strong>{label}</strong>
      {displayedPercent === null ? <span className="quota-compact-status">{compactStatus}</span> : <span className="quota-compact-window"><span>{windowLabel}</span><i className="quota-compact-bar" aria-hidden="true"><b style={{ width: `${displayedPercent}%` }} /></i><b>{displayedPercent}%</b></span>}
    </span>
  }
  return <span className={`quota-provider ${compact ? 'compact' : ''}`} data-provider={String(item.provider ?? 'unknown')}>
    <ProviderLogo provider={String(item.provider ?? '')} size={16} />
    <strong>{label}</strong>
    {limits.length ? limits.map((limit, index) => <span className="quota-limit" key={`${String(limit.label)}-${index}`}>
      <span>{String(limit.label ?? 'Quota')}</span>
      {(['primary', 'secondary'] as const).map((window) => {
        const value = recordFrom(limit[window])
        if (typeof value.usedPercent !== 'number') return null
        const duration = typeof value.windowDurationMins === 'number' ? value.windowDurationMins : null
        const durationLabel = duration === null ? (window === 'primary' ? 'Primary' : 'Secondary') : duration % 1440 === 0 ? `${duration / 1440}d` : duration % 60 === 0 ? `${duration / 60}h` : `${duration}m`
        const reset = quotaResetLabel(value.resetsAt)
        return <span className="quota-window" key={window} title={`${durationLabel} window`}><span>{durationLabel}</span><i><b style={{ width: `${Math.max(0, Math.min(100, value.usedPercent))}%` }} /></i><b>{value.usedPercent}%</b>{reset && <small>{reset}</small>}</span>
      })}
    </span>) : <span className="quota-unknown">{lastError ? errorCopy[lastError] ?? 'Quota unavailable' : 'Quota unavailable'}</span>}
    {limits.length > 0 && lastError && <small className="quota-stale">{staleErrorCopy[lastError] ?? 'Latest refresh failed; showing last successful reading'}</small>}
    {fetched && !compact && <small>Updated {fetched}</small>}
  </span>
}

function UsageSheet({ summary, period, quotas, loading, quotaRefreshing, onRefreshQuota, onPeriodChange, onClose }: { summary: Record<string, unknown> | null; period: 'today' | 'month'; quotas: Record<string, unknown>[]; loading: boolean; quotaRefreshing: boolean; onRefreshQuota: () => void; onPeriodChange: (period: 'today' | 'month') => void; onClose: () => void }) {
  const { ref: dialogRef, close } = useDialogAccessibility(onClose)
  return <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><section ref={dialogRef} className="usage-sheet" role="dialog" aria-modal="true" aria-labelledby="usage-title">
    <header><div><p className="eyebrow">{summary ? `${shortDate(summary.from)} – ${shortDate(summary.to)}` : 'USAGE'}</p><h2 id="usage-title">Usage summary</h2><small className="usage-scope">All runtimes on this device · requested period</small></div><button className="icon-button" data-dialog-initial-focus aria-label="Close usage summary" onClick={close}><X size={17} /></button></header>
    <div className="usage-period-switch" aria-label="Usage date range"><button className={period === 'today' ? 'active' : ''} aria-pressed={period === 'today'} onClick={() => onPeriodChange('today')}>Today</button><button className={period === 'month' ? 'active' : ''} aria-pressed={period === 'month'} onClick={() => onPeriodChange('month')}>This month</button></div>
    {loading ? <div className="sheet-loading"><LoaderCircle className="spinning" /><span>Loading the daemon summary…</span></div> : summary ? <div className="usage-sheet-body">
      <section className="usage-block"><div className="usage-block-heading"><h3>Token usage</h3><span>Mutually exclusive buckets</span></div><div className="usage-token-grid">{usageTokenBuckets(summary).map((bucket) => <div className="usage-token" key={bucket.key}><span>{bucket.label}</span><strong>{bucket.value}</strong></div>)}</div></section>
      <QuotaDetails quotas={quotas} refreshing={quotaRefreshing} onRefresh={onRefreshQuota} />
    </div> : <div className="sheet-empty"><CircleHelp size={20} /><strong>Usage summary unavailable</strong><p>The daemon did not return token usage for this period.</p></div>}
    <footer>Token counts describe recorded activity. Provider quota is a separate account limit.</footer>
  </section></div>
}

function shortDate(value: unknown) {
  if (typeof value !== 'string') return 'unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function quotaResetLabel(value: unknown) {
  if (typeof value !== 'string') return null
  const resetAt = new Date(value)
  if (Number.isNaN(resetAt.getTime())) return null
  const remaining = Math.max(0, Math.floor((resetAt.getTime() - Date.now()) / 1000))
  const relative = remaining === 0 ? 'now' : remaining >= 86_400
    ? `${Math.floor(remaining / 86_400)}d ${Math.floor((remaining % 86_400) / 3600)}h`
    : remaining >= 3600 ? `${Math.floor(remaining / 3600)}h ${Math.floor((remaining % 3600) / 60)}m`
      : `${Math.max(1, Math.ceil(remaining / 60))}m`
  const localTime = resetAt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return `Resets ${localTime} · in ${relative}`
}

function recordFrom(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }

function Companion({ agent, agents, runtime, runtimes, session, usage, connected, appError, activityLabel, permission, approvalMode, onReply, onNewSession, onOpenMain, onOpenSettings, onSendPrompt, onCancelTurn, onSelectAgent }: { agent: Agent | null; agents: Agent[]; runtime: Runtime | null; runtimes: Runtime[]; session: Session | null; usage?: Record<string, unknown>; connected: boolean; appError: string | null; activityLabel: string; permission?: PermissionRequest; approvalMode: ReturnType<typeof effectiveApprovalMode>; onReply: (permission: PermissionRequest, choice: string) => boolean | void | Promise<boolean | void>; onNewSession: (anchor?: HTMLElement | null) => void; onOpenMain: () => void; onOpenSettings: () => void; onSendPrompt: (sessionId: string, text: string) => Promise<unknown>; onCancelTurn: (sessionId: string) => Promise<unknown>; onSelectAgent: (agent: Agent) => void }) {
  const [view, setView] = useState<'overview' | 'chat' | 'activity' | 'settings'>('overview')
  const [draft, setDraft] = useState('')
  const [dictationPartial, setDictationPartial] = useState('')
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
  const [dictationSurface, setDictationSurface] = useState<'bubble' | 'companion' | 'none'>('none')
  const [dictationPhase, setDictationPhase] = useState<'idle' | 'listening' | 'processing' | 'error'>('idle')
  const [dictationError, setDictationError] = useState('')
  const [dictationLevel, setDictationLevel] = useState(0)
  const [dictationFrame, setDictationFrame] = useState(0)
  const fileRequest = useRef(0)
  const viewBeforeConfused = useRef<typeof view>('overview')
  const viewBeforeDrop = useRef<typeof view>('overview')
  const viewRef = useRef(view)
  const droppedFileRef = useRef(droppedFile)
  const permissionRef = useRef(permission)
  const sessionRef = useRef(session)
  const dictationSurfaceRef = useRef<'bubble' | 'companion' | 'none'>('none')
  viewRef.current = view
  droppedFileRef.current = droppedFile
  permissionRef.current = permission
  sessionRef.current = session
  dictationSurfaceRef.current = dictationSurface
  const latestTool = session?.tools?.at(-1)
  const clock = useClock(10_000)
  const derived = deriveCompanionStatus({ connected, runtime, session, permissionPending: !!permission, composing: !!draft.trim(), now: clock })
  const displayMood = derived.mood
  const activity = derived.mood === 'listening' ? derived.label : activityLabel
  const fileStage = dropActive ? 'drop' : preparingFile ? 'preparing' : fileError ? 'error' : droppedFile ? (sending ? 'sending' : 'ready') : undefined
  const fsmRef = useRef<CompanionFsm | null>(null)
  const capsuleRef = useRef<HTMLDivElement>(null)
  const chatLogRef = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<CompanionMode>('petit')
  const [popIn, setPopIn] = useState(false)
  if (!fsmRef.current) fsmRef.current = new CompanionFsm()
  const tall = mode === 'home' && !permission && (view === 'chat' || view === 'activity')
  const presentation = mode === 'home' && tall ? 'home-chat' : mode
  useEffect(() => {
    const fsm = fsmRef.current!
    fsm.onTransition = (_from, to) => setMode(to)
    fsm.forcePetit(true)
    return () => { fsm.dispose(); void setCompanionMode('petit') }
  }, [])
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    let timer = 0
    void listen<boolean>('bloblex-companion-visible-changed', ({ payload }) => {
      if (!payload) return
      setPopIn(true)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setPopIn(false), 240)
    }).then((stop) => { if (cancelled) stop(); else unlisten = stop })
    return () => { cancelled = true; unlisten?.(); window.clearTimeout(timer) }
  }, [])
  useEffect(() => { void setCompanionMode(presentation) }, [presentation])
  useEffect(() => { fileRequest.current++; setDraft(''); setDroppedFile(null); setFileInfo(null); setPreparingFile(false); setFileError(null); setDropError(null) }, [runtime?.id, session?.id])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
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
  useEffect(() => {
    let disposed = false
    const unsubs: Array<() => void> = []
    const add = (unlisten: () => void) => { if (disposed) unlisten(); else unsubs.push(unlisten) }
    void (async () => {
      add(await listen<{ surface: string }>('bloblex-dictation-surface', (event) => {
        const isCompanion = event.payload.surface === 'companion'
        setDictationSurface(isCompanion ? 'companion' : 'none')
        if (isCompanion) { setDictationPhase('listening'); setDictationError(''); playDictationCue('record-start') }
      }))
      add(await listen<{ type: string; text?: string }>('bloblex-dictation', (event) => {
        if (dictationSurfaceRef.current !== 'companion') return
        const { type, text } = event.payload
        if (type === 'processing') { setDictationPhase('processing'); playDictationCue('processing-start') }
        else if (type === 'stopped') { setDictationPhase('idle'); setDictationSurface('none'); playDictationCue('processing-finish') }
        else if (type === 'error') {
          setDictationPhase('error'); setDictationError(text || 'Dictation failed.'); playDictationCue('error')
          window.setTimeout(() => { setDictationPhase('idle'); setDictationSurface('none') }, 1600)
        }
      }))
      add(await listen<{ level: number }>('bloblex-dictation-level', (event) => setDictationLevel(event.payload.level)))
    })().catch(() => undefined)
    return () => { disposed = true; unsubs.forEach((unlisten) => unlisten()) }
  }, [])

  useEffect(() => {
    if (dictationSurface !== 'companion') return
    const interval = window.setInterval(() => setDictationFrame((current) => current + 1), 66)
    return () => window.clearInterval(interval)
  }, [dictationSurface])

  const inputTokens = typeof usage?.inputTokens === 'number' ? usage.inputTokens : null
  const outputTokens = typeof usage?.outputTokens === 'number' ? usage.outputTokens : null
  const tokenGlance = inputTokens !== null && outputTokens !== null ? formatCount(inputTokens + outputTokens) : inputTokens !== null ? `${formatCount(inputTokens)} in · out ?` : outputTokens !== null ? `in ? · ${formatCount(outputTokens)} out` : 'Unknown'
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
  const wash = displayMood === 'success' ? 'green' : displayMood === 'error' || displayMood === 'rate_limited' ? 'red' : null
  const lastReply = [...(session?.messages ?? [])].reverse().find((message) => message.role !== 'user')
  const tickerLines = [...new Set([
    lastReply ? plainText(String(lastReply.content ?? lastReply.text ?? '')) : null,
    latestTool && typeof latestTool.command === 'string' ? latestTool.command : null,
    activity,
  ].filter((line): line is string => !!line))].slice(-2)
  const focusBlob = (size: number) => <BlobCanvas color={color} size={size} mood={displayMood} fileStage={fileStage} outfit={agent?.outfit ?? 'auto'} createdAt={agent?.createdAt ?? null} soundCues={soundsEnabled} label={name} onDizzy={beginConfused} onDizzyRecovery={recoverFromConfused} />
  const responsiveDictation = Math.min(1, Math.pow(Math.max(0, dictationLevel), 0.58) * 2.1)
  const dictationBars = Array.from({ length: 14 }, (_, index) => {
    const amplitude = Math.max(0.12, responsiveDictation) * (0.8 + Math.abs(Math.sin(dictationFrame * 0.4 + index * 0.5)))
    return { key: index, height: Math.max(5, 5 + amplitude * 26), opacity: 0.4 + amplitude * 0.55 }
  })

  return <main className={`companion-root ${popIn ? 'pop-in' : ''}`} data-mode={mode} style={color ? { '--agent-accent': color } as React.CSSProperties : undefined} onMouseEnter={() => fsmRef.current?.mouseEntered()} onMouseLeave={() => fsmRef.current?.mouseLeft()}>
    {dictationSurface === 'companion' && dictationPhase !== 'idle' && <div className="companion-listening" role="status" aria-live="polite">
      {dictationPhase === 'processing' ? <>
        <span className="companion-listening-label">Processing</span>
        <span className="companion-listening-spinner" aria-hidden="true" />
      </> : dictationPhase === 'error' ? <span className="companion-listening-label error">{dictationError}</span> : <>
        <span className="companion-listening-label">Listening</span>
        <div className="companion-listening-wave">{dictationBars.map((bar) => <span key={bar.key} style={{ height: `${bar.height}px`, opacity: bar.opacity }} />)}</div>
      </>}
    </div>}
    <div ref={capsuleRef} className={`companion-capsule island ${mode}`} data-tauri-drag-region>
      {mode === 'petit' ? <div className="companion-compact" data-tauri-drag-region>
        <button className="compact-bot" aria-label="Open companion home" onClick={() => fsmRef.current?.click()}>{focusBlob(40)}</button>
        <div className="compact-copy" onClick={() => fsmRef.current?.click()}><span className="compact-name"><strong>{name}</strong><ApprovalPill mode={approvalMode} compact /></span><span role="status" aria-live="polite" className={`compact-status ${shimmering ? 'shimmer' : ''}`}>{statusLine}</span></div>
        {permission && <ShieldAlert className="companion-alert" size={15} aria-label="Approval required" />}
        {peers.length > 0 && <div className="mini-grid" aria-hidden="true" data-tauri-drag-region>{peers.map((item) => { const peerRuntime = runtimes.find((candidate) => candidate.id === item.runtimeId); const offline = !connected || !peerRuntime || ['offline', 'error', 'disconnected'].includes((peerRuntime.status ?? '').toLowerCase()); return <BlobCanvas key={item.id} color={agentColorHex(item.color)} size={15} mini mood={offline ? 'offline' : 'idle'} outfit={item.outfit} createdAt={item.createdAt} label={item.name} /> })}</div>}
        <button className="companion-collapse" aria-label="Expand companion" onClick={() => fsmRef.current?.click()}><ChevronUp size={15} /></button>
      </div> : <>
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
              <ApprovalCard permission={permission} variant="companion" onReply={(choice) => onReply(permission, choice)} />
              {session && <button className="btn ghost" onClick={cancelCompanionTurn} disabled={sending}>Cancel turn</button>}
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
                <div className="glance" title={`Reported tokens across all blobs. Input ${inputTokens === null ? 'unknown' : inputTokens.toLocaleString()} · Output ${outputTokens === null ? 'unknown' : outputTokens.toLocaleString()}`}><span>All blobs: Tokens <b>{tokenGlance}</b></span></div>
              </div>
            </div>
            <div className="island-card pills-card">
              {runtimes.length === 0 ? <p className="companion-empty">No coding agents discovered yet.</p> : pills.length === 0 ? <p className="companion-empty">No blobs yet.</p> : <div className="pills">{pills.map((item) => { const peerRuntime = runtimes.find((candidate) => candidate.id === item.runtimeId); const offline = !connected || !peerRuntime || ['offline', 'error', 'disconnected'].includes((peerRuntime.status ?? '').toLowerCase()); return <button key={item.id} className={`pill ${item.id === agent?.id ? 'on' : ''}`} style={{ '--pill': agentColorHex(item.color) } as React.CSSProperties} onClick={() => onSelectAgent(item)}><BlobCanvas color={agentColorHex(item.color)} size={22} mini mood={offline ? 'offline' : 'idle'} outfit={item.outfit} createdAt={item.createdAt} label={item.name} /><span className="lbl">{item.name}</span></button> })}</div>}
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
              {dictationPartial && <div className="dictation-partial companion" role="status"><span className="dictation-partial-label">Listening</span>{dictationPartial}</div>}
              <form className="chat-bar companion-chat-composer" data-companion-no-drag="" onSubmit={(event) => void sendCompanionPrompt(event)}>
                <button type="button" className="companion-attach" aria-label="Choose a local file" title="Choose a local file" onClick={() => void chooseCompanionFile()} disabled={!connected || !session || preparingFile}><Paperclip size={13} /></button>
                <textarea className="chat-input" aria-label="Message agent" placeholder={connected ? `Ask ${name}…` : 'Daemon disconnected'} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} disabled={!connected || !session || sending || session.state === 'waiting_permission'} rows={1} />
                <DictationButton owner="companion" onFinal={(text) => setDraft((current) => (current ? `${current} ${text}` : text))} onPartial={setDictationPartial} disabled={!connected || !session || sending || session.state === 'waiting_permission'} />
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

function messageOf(reason: unknown) {
  if (reason instanceof Error) return reason.message
  return typeof reason === 'string' ? reason : 'The local daemon request failed.'
}
