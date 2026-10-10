import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import {
  Activity, ArrowUp, ArrowUpRight, ChevronDown, ChevronUp, CircleHelp, ClipboardList, Code2, Copy, FileText, FolderOpen,
  Gauge, Home, LoaderCircle, MessageCircle, MoreHorizontal, PanelRight, Paperclip, Play, Plus,
  RefreshCw, Search, Settings2, ShieldAlert, Square, SquarePen, Terminal, Volume2, VolumeX, X,
} from 'lucide-react'
import { agentLook, SHAPE_LABELS, type BlobLook } from '../blob/look'
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
import { applyEvent, formatUnknownSafe, isPermissionReplyAllowed, labelize, type Agent, type ConnectionState, type DaemonEvent, type PermissionRequest, type Project, type Runtime, type Session, type Snapshot } from '../types'
import { agentColorHex } from './agentColor'
import { TeamSidebar } from './TeamSidebar'
import { DelegationChip, MentionPicker, PlanCard, QuestionCard, ReplyChip, SideConversationHeader, mentionMatches } from './TeamMessages'
import { CompanionChatItem, CompanionTeamActivity, CompanionTeamCard, teamLine } from './CompanionTeam'
import { isSideSession, mainSessionFor, mentionQuery, sideSessionsFor, splitMentions } from './teamSelectors'
import { effectiveApprovalMode } from '../approvalContract'
import type { ExecutionSendGate } from '../executionContract'
import { parseExecSnapshot } from '../executionContract'
import { turnFailureTitle } from './analyticsFormat'
import { createDraft, createParams, daemonCodeOf, draftFromAgent, teamParams, duplicateParams, executionFromAgent, isAgentDirty, messageForDaemonCode, starterDraft, updateParams, validateAgentDraft, type AgentDraft } from './agentForm'
import { activeAgents, agentSessions, agentsForRuntime, duplicateAgentName, legacySessions, nextAgentAfterArchive, projectGroups, runtimeUsable, sessionDisplayTitle, sessionSelectionTarget } from './rosterSelectors'
import { conversationMarkdown } from './conversationMarkdown'
import { parseSharedBlob, serializeBlob, type SharedBlob } from './blobShare'
import { ApprovalPill } from './approvalUi'
import { BlobPage, ConfirmDialog } from './BlobPage'
import { DictationButton } from './DictationButton'
import { UpdateAvailableBanner, useMainUpdateOffer } from './UpdateBanner'
import { SettingsSheet, type SettingsPageId } from './SettingsSheet'
import { ProfileMenu, readProfileName, saveProfileName, syncProfileName } from './ProfileMenu'
import { emptyPins, readPins, toggleFavorite, writePins, type SidebarPins } from './sidebarPins'
import { Select } from './Select'
import { ProviderLogo } from './providerBrand'
import { useClock } from './useClock'
import { useDialogAccessibility, useDialogEntered } from './dialogFocus'
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
import { QuotaBar } from './QuotaBar'
import { quotaRows, quotaTone, resetIn, updatedAgo } from './quotaModel'
import { AttachButton, AttachmentTray, MAX_COMPOSER_ATTACHMENTS, MessageAttachments, PermissionModeControl, prepareImageBytes, sessionApprovalMode, type ComposerAttachment } from './ComposerControls'
import { ConversationOutline, outlineItemsFromMessages } from './ConversationOutline'
import { SafeMarkdown } from './SafeMarkdown'
import { parseUnifiedDiff } from './diffParser'
import type { QuickSwitcherItem } from './quickSwitcherModel'
import { ensureDaemon, fetchSnapshot, getActiveRuntime, getActiveSession, inDesktop, inspectLocalFile, listenForActiveRuntime, listenForActiveSession, listenForDaemonConnection, listenForDaemonEvents, listenForOpenSettings, openInEditor, openProjectFolder, previewMode, quitBloblex, readBlobImport, refreshTrayMenu, resolveProjectFile, revealInExplorer, rpc, selectBlobImportPath, selectLocalFile, selectMarkdownExportPath, selectBlobExportPath, setActiveRuntime, setActiveSession, setCompanionMode, setCompanionVisibility, showMainSettings, showMainWindow, stagePromptAttachment, startDaemonEventStream, writeBlobExport, writeMarkdownExport } from '../tauri'

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
  /** Experimental, off by default: the plan-usage bar along the bottom. */
  const [usageBarEnabled, setUsageBarEnabled] = useState(false)
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
  /** A side conversation between two blobs, opened from a chip; overrides the main conversation. */
  const [sideSessionId, setSideSessionId] = useState<string | null>(null)
  const [textPrompt, setTextPrompt] = useState<{ title: string; label: string; value: string; confirmLabel: string; onSubmit: (value: string) => void | Promise<void> } | null>(null)
  const [projectDelete, setProjectDelete] = useState<Project | null>(null)
  const [freshTarget, setFreshTarget] = useState<Agent | null>(null)
  const [mention, setMention] = useState<{ start: number; query: string; index: number } | null>(null)
  const ensuringConversation = useRef(new Set<string>())
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
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const attachmentsRef = useRef<ComposerAttachment[]>([])
  attachmentsRef.current = attachments
  const [composerDropActive, setComposerDropActive] = useState(false)
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
    if (companion || connection !== 'connected') return
    let active = true
    void rpc<Record<string, unknown>>('settings.get').then((result) => {
      const values = result.settings && typeof result.settings === 'object' ? result.settings as Record<string, unknown> : result
      if (active) setUsageBarEnabled(values['experimental.usageBar'] === true)
    }).catch(() => undefined)
    return () => { active = false }
  }, [companion, connection])

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
  const projects = snapshot?.projects ?? []
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
  const sideSession = sideSessionId ? sessions.find((session) => session.id === sideSessionId && isSideSession(session)) ?? null : null
  const selectedSession = sideSession ?? (activeSelectedAgent
    ? sessions.find((session) => session.id === selectedSessionId && session.agentId === activeSelectedAgent.id && !isSideSession(session) && !session.archived) ?? mainSessionFor(sessions, activeSelectedAgent.id)
    : sessions.find((session) => session.id === selectedSessionId && (!selectedRuntime || session.runtimeId === selectedRuntime.id))
      ?? sessions.find((session) => session.id === activeSessionId && (!selectedRuntime || session.runtimeId === selectedRuntime.id))
      ?? sessions.filter((session) => session.runtimeId === selectedRuntime?.id && !isSideSession(session)).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0]
      ?? null)
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
  // A side conversation only shows its own requests, never the leader's.
  const activePermission = sideSessionId
    ? selectPendingPermission((snapshot?.permissions ?? []).filter((permission) => permission.sessionId === sideSessionId), sideSessionId, sideSessionId, permissionClock)
    // Questions wait in their own conversation (the sidebar shows "Waiting for you");
    // only approvals pull focus across blobs.
    : selectPendingPermission((snapshot?.permissions ?? []).filter((permission) => permission.kind !== 'question' || permission.sessionId === selectedSession?.id), selectedSession?.id, activeSessionId, permissionClock)
  const sideAgent = sideSession ? agents.find((agent) => agent.id === sideSession.agentId) ?? null : null
  const sidePeer = sideSession ? agents.find((agent) => agent.id === sideSession.link?.peerAgentId) ?? null : null
  const agentName = sideSession ? sideAgent?.name ?? 'Teammate' : activeSelectedAgent?.name ?? (selectedRuntime ? labelize(selectedRuntime.provider) : 'No runtime selected')
  const outlineItems = outlineItemsFromMessages(
    groupedConversationItems.filter((item): item is ConversationItem & { kind: 'message' } => item.kind === 'message'),
    agentName,
  )
  const accent = sideAgent ? agentColorHex(sideAgent.color) : activeSelectedAgent ? agentColorHex(activeSelectedAgent.color) : ''
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
  const headerMode = selectedSession ? sessionApprovalMode(selectedSession, headerAgent).mode : effectiveApprovalMode(headerAgent)
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
    const mood = companionStatus.mood
    const busy = (value: string | null) => value === 'working' || value === 'thinking' || value === 'tool_activity' || value === 'file_activity'
    if (previous && previous !== mood) {
      if (mood === 'success') playCompanionCue('finish')
      else if (mood === 'error' || mood === 'rate_limited') playCompanionCue('error')
      else if (busy(mood) && !busy(previous)) playCompanionCue('work')
      else if (mood === 'sleeping') playCompanionCue('sleep')
    }
    previousCueMood.current = companionStatus.mood
  }, [companion, companionStatus.mood])

  useEffect(() => {
    if (!companion) return
    if (companionPermission?.id && companionPermission.id !== previousPermissionCue.current) playCompanionCue(companionPermission.kind === 'question' ? 'question' : 'approval')
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
    if (companion || connection !== 'connected') return
    const name = readProfileName()
    if (name) syncProfileName(name)
  }, [companion, connection])

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

  const openCreate = (projectId: string | null = activeSelectedAgent?.projectId ?? null) => {
    setCreateMenuOpen(false)
    const next = { ...createDraft(runtimes, activeSelectedAgent?.runtimeId ?? selectedRuntime?.id ?? null), projectId: typeof projectId === 'string' ? projectId : null }
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

  // Browser preview only: /?preview-import opens the import dialog with a sample blob file.
  const previewImportStarted = useRef(false)
  useEffect(() => {
    if (!previewMode || companion || previewImportStarted.current || !snapshot || !new URLSearchParams(location.search).has('preview-import')) return
    previewImportStarted.current = true
    void importBlob()
  })
  // Browser preview only: /?preview-settings opens Settings on the General page.
  useEffect(() => {
    if (!previewMode || companion || !new URLSearchParams(location.search).has('preview-settings')) return
    setSettingsInitialPage('General')
    setSettingsSheet(true)
  }, [companion])

  const createImportedBlob = (blob: SharedBlob, runtimeId: string) => {
    const next = createDraft(runtimes, runtimeId)
    next.name = blob.name
    next.description = blob.description
    next.color = blob.colour
    next.look = blob.look
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
        let agent = result.agent
        if (!agent?.id) return
        const team = teamParams(draft, { ...draft, role: '', projectId: null, leader: false })
        if (Object.keys(team).length) {
          const updated = await doRpc<{ agent?: Agent }>('agent.team.update', { agentId: agent.id, ...team })
          if (updated.agent?.id) agent = updated.agent
          if (team.leader === true) setSnapshot((current) => current ? { ...current, agents: (current.agents ?? []).map((item) => item.id !== agent!.id && item.leader ? { ...item, leader: false } : item) } : current)
        }
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
      const team = teamParams(draft, baseline)
      if (Object.keys(params).length === 1 && Object.keys(team).length === 0) return
      let agent: Agent | undefined = editing
      if (Object.keys(params).length > 1) {
        const result = await doRpc<{ agent?: Agent }>('agent.update', params, (reason) => messageForDaemonCode(daemonCodeOf(reason), 'agent.update', { archived: editing.archived, sentName: Object.prototype.hasOwnProperty.call(params, 'name') }))
        agent = result.agent
      }
      if (agent?.id && Object.keys(team).length) {
        const updated = await doRpc<{ agent?: Agent }>('agent.team.update', { agentId: editing.id, ...team })
        if (updated.agent?.id) agent = updated.agent
        if (team.leader === true) setSnapshot((current) => current ? { ...current, agents: (current.agents ?? []).map((item) => item.id !== editing.id && item.leader ? { ...item, leader: false } : item) } : current)
      }
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

  /** One conversation per blob: "new" opens it, or asks before starting fresh. */
  const newSession = (agentId?: string, _anchor?: HTMLElement | null) => {
    const agent = agents.find((item) => item.id === (agentId ?? activeSelectedAgent?.id) && !item.archived)
    const runtime = agent ? runtimes.find((item) => item.id === agent.runtimeId) : null
    if (!agent || connection !== 'connected' || busy || !runtimeUsable(runtime)) return
    const main = mainSessionFor(sessions, agent.id)
    if (!main) { selectAgent(agent); return }
    if ((main.messages ?? []).length === 0) { selectAgent(agent); return }
    setFreshTarget(agent)
  }

  const setPlanMode = async (enabled: boolean) => {
    if (!selectedSession) return
    try {
      const result = await doRpc<{ session?: Session }>('session.model.update', { sessionId: selectedSession.id, planMode: enabled })
      if (result.session?.id) setSnapshot((current) => current ? mergeHydratedSession(current, result.session!.id, result.session!) : current)
    } catch { /* inline */ }
  }
  const approvePlan = async () => {
    if (!selectedSession) return
    await setPlanMode(false)
    try { await doRpc('session.prompt', { sessionId: selectedSession.id, text: 'Approved. Go ahead and implement the plan.' }); await refresh() } catch { /* inline */ }
  }
  const answerQuestion = async (permission: PermissionRequest, answers: Record<string, string[]> | null) => {
    try {
      await doRpc('permission.reply', { permissionId: permission.id, choice: answers ? 'answer' : 'dismiss', ...(answers ? { answers } : {}) })
      await refresh()
    } catch (reason) { await refresh(); setError(messageOf(reason)) }
  }
  const pickMention = (agent: Agent) => {
    if (!mention) return
    const caret = composerRef.current?.selectionStart ?? composer.length
    const next = `${composer.slice(0, mention.start)}@${agent.name} ${composer.slice(caret)}`
    setComposer(next)
    setMention(null)
    requestAnimationFrame(() => { const node = composerRef.current; if (!node) return; const position = mention.start + agent.name.length + 2; node.focus(); node.setSelectionRange(position, position) })
  }
  const renderText = (text: string) => <SafeMessageText text={text} />
  /** Team messages render as chips and cards instead of chat bubbles. */
  const teamItem = (message: Record<string, unknown>, key: string) => {
    const meta = (message.meta && typeof message.meta === 'object' ? message.meta : null) as { kind?: string; direction?: string; peerAgentId?: string; peerName?: string; fromAgentId?: string; fromName?: string; sideSessionId?: string } | null
    const role = String(message.role ?? '')
    const text = typeof message.content === 'string' ? message.content : ''
    if (role === 'notice' && meta?.kind === 'delegation') {
      return <DelegationChip key={key} peer={agents.find((agent) => agent.id === meta.peerAgentId)} name={meta.peerName ?? 'Teammate'} failed={meta.direction === 'failed'} detail={meta.direction === 'failed' ? text : undefined} onOpen={meta.sideSessionId ? () => openSideConversation(meta.sideSessionId) : undefined} />
    }
    if (role === 'user' && meta?.kind === 'blob_reply') {
      return <ReplyChip key={key} from={agents.find((agent) => agent.id === meta.fromAgentId)} name={meta.fromName ?? 'Teammate'} onOpen={meta.sideSessionId ? () => openSideConversation(meta.sideSessionId) : undefined} />
    }
    if (role === 'user' && meta?.kind === 'blob_message') {
      const from = agents.find((agent) => agent.id === meta.fromAgentId)
      return <article key={key} id={`conversation-message-${encodeURIComponent(key)}`} className="message-row agent group-start side-peer" aria-label={meta.fromName ?? 'Teammate'}>
        <div className="message-content"><span className="message-author">{from && <BlobCanvas decorative color={agentColorHex(from.color)} size={20} mood="idle" look={agentLook(from)} label={from.name} />}{meta.fromName ?? 'Teammate'}</span><div className="message-bubble">{renderText(text)}</div></div>
      </article>
    }
    if (sideSession && role === 'assistant' && text.trim()) {
      return <article key={key} id={`conversation-message-${encodeURIComponent(key)}`} className="message-row agent group-start side-peer side-target" aria-label={sideAgent?.name ?? 'Teammate'}>
        <div className="message-content"><span className="message-author target">{sideAgent && <BlobCanvas decorative color={agentColorHex(sideAgent.color)} size={20} mood="idle" look={agentLook(sideAgent)} label={sideAgent.name} />}{sideAgent?.name ?? 'Teammate'}</span><div className="message-bubble">{renderText(text)}</div></div>
      </article>
    }
    if (role === 'plan') {
      return <PlanCard key={key} text={text} renderText={renderText} canApprove={!sideSession && planOn && !sessionBusy && message.id === latestPlanId} onApprove={() => void approvePlan()} onRevise={() => composerRef.current?.focus()} />
    }
    if (role === 'notice') {
      return <div key={key} className="team-chip-row"><span className="team-notice">{text}</span></div>
    }
    return null
  }

  const sendPrompt = async () => {
    const text = composer.trim()
    const ready = attachments.filter((item) => item.status === 'ready' && item.path)
    if ((!text && ready.length === 0) || attachments.some((item) => item.status === 'staging') || !selectedSession || busy || selectedSession.state === 'waiting_permission' || !runtimeUsable(selectedRuntime)) return
    try {
      await doRpc('session.prompt', { sessionId: selectedSession.id, text, ...(ready.length ? { attachments: ready.map((item) => ({ path: item.path, name: item.name })) } : {}) })
      setComposer('')
      clearAttachments()
      await refresh()
    } catch { /* The actionable error is shown inline. */ }
  }

  const clearAttachments = () => {
    for (const item of attachmentsRef.current) URL.revokeObjectURL(item.previewUrl)
    setAttachments([])
  }
  const removeAttachment = (id: string) => setAttachments((current) => current.filter((item) => {
    if (item.id === id) URL.revokeObjectURL(item.previewUrl)
    return item.id !== id
  }))
  const addAttachments = (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith('image/')).slice(0, Math.max(0, MAX_COMPOSER_ATTACHMENTS - attachmentsRef.current.length))
    if (files.length && !images.length) { setError('Only images can be attached.'); return }
    for (const file of images) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const name = file.name && file.name !== 'image.png' ? file.name : `Pasted image ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.png`
      setAttachments((current) => [...current, { id, name, previewUrl: URL.createObjectURL(file), path: null, status: 'staging' }])
      void prepareImageBytes(file).then(stagePromptAttachment).then((path) => {
        setAttachments((current) => current.map((item) => item.id === id ? { ...item, path, status: 'ready' } : item))
      }).catch((reason) => {
        setAttachments((current) => current.map((item) => item.id === id ? { ...item, status: 'error', error: messageOf(reason) } : item))
      })
    }
  }
  useEffect(() => { clearAttachments() }, [selectedSession?.id])

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
    const main = mainSessionFor(sessions, agent.id)
    setSideSessionId(null)
    setAnalyticsOpen(false)
    setSelectedAgentId(agent.id)
    setSelectedRuntimeId(agent.runtimeId)
    setSelectedSessionId(main?.id ?? null)
    void setActiveRuntime(agent.runtimeId)
    void setActiveSession(main?.id ?? null)
    setBlobPage((page) => page && page.agentId !== agent.id ? null : page)
    if (!main) void ensureConversation(agent)
  }
  const upsertSession = (session: Session) => setSnapshot((current) => {
    if (!current) return current
    const exists = (current.sessions ?? []).some((item) => item.id === session.id)
    return exists ? mergeHydratedSession(current, session.id, session) : { ...current, sessions: [session, ...(current.sessions ?? [])] }
  })
  /** Opens a blob's single conversation, creating it in the blob's workspace the first time. */
  const ensureConversation = async (agent: Agent) => {
    if (ensuringConversation.current.has(agent.id) || connection !== 'connected') return null
    const runtime = runtimes.find((item) => item.id === agent.runtimeId)
    if (!runtimeUsable(runtime)) return null
    ensuringConversation.current.add(agent.id)
    try {
      const result = await doRpc<{ session?: Session }>('agent.conversation', { agentId: agent.id }, (reason) => messageForDaemonCode(daemonCodeOf(reason), 'session.new'))
      if (!result.session?.id) return null
      upsertSession(result.session)
      setSelectedAgentId((current) => {
        if (current === agent.id) { setSelectedSessionId(result.session!.id); void setActiveSession(result.session!.id) }
        return current
      })
      return result.session
    } catch { return null } finally { ensuringConversation.current.delete(agent.id) }
  }
  /** Archives the blob's conversation and starts a fresh one in the same place. */
  const startFresh = async (agent: Agent) => {
    const main = mainSessionFor(sessions, agent.id)
    try {
      if (main) await doRpc('session.archive', { sessionId: main.id, archived: true })
      setSideSessionId(null)
      setSnapshot((current) => current ? { ...current, sessions: (current.sessions ?? []).map((item) => item.id === main?.id ? { ...item, archived: true } : item) } : current)
      const session = await ensureConversation(agent)
      if (session) setRosterAnnouncement(`Started a fresh conversation with ${agent.name}.`)
    } catch { /* inline */ }
  }
  const openSideConversation = (sessionId: string | undefined | null) => {
    if (!sessionId) return
    const session = sessions.find((item) => item.id === sessionId)
    if (!session) { void refresh().then(() => setSideSessionId(sessionId)); return }
    setSideSessionId(sessionId)
  }
  const teamUpdate = async (agent: Agent, params: Record<string, unknown>) => {
    try {
      const result = await doRpc<{ agent?: Agent }>('agent.team.update', { agentId: agent.id, ...params }, (reason) => messageForDaemonCode(daemonCodeOf(reason), 'agent.update'))
      if (result.agent?.id) {
        if (params.leader === true) setSnapshot((current) => current ? { ...current, agents: (current.agents ?? []).map((item) => item.id !== result.agent!.id && item.leader ? { ...item, leader: false } : item) } : current)
        mergeAgent(result.agent)
      }
      if ('projectId' in params) await refresh()
    } catch { /* inline */ }
  }
  const projectAction = async (method: string, params: Record<string, unknown>) => {
    try {
      const result = await doRpc<{ project?: Project }>(method, params)
      if (result.project?.id) {
        const project = result.project
        setSnapshot((current) => current ? { ...current, projects: [...(current.projects ?? []).filter((item) => item.id !== project.id), project] } : current)
      }
      if (method === 'project.delete') await refresh()
      return result.project ?? null
    } catch { return null }
  }
  const createProject = async () => {
    const path = await openProjectFolder()
    if (!path) return
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? 'Project'
    const project = await projectAction('project.create', { name, path })
    if (project) setRosterAnnouncement(`Created project ${project.name}.`)
    return project
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

  if (companion) {
    return <>
      <Companion agent={companionAgent} agents={agents} projects={snapshot?.projects ?? []} sessions={sessions} onAnswerQuestion={answerQuestion} onOpenSession={(sessionId) => void showMainWindow(sessionId)} runtime={companionRuntime} runtimes={runtimes} session={companionSession} usage={snapshot?.usageSummary} connected={connection === 'connected'} appError={error} activityLabel={companionStatus.label} permission={companionPermission} approvalMode={companionMode} onReply={answerPermission} onNewSession={(anchor) => newSession(companionAgent?.id, anchor)} onOpenMain={() => void showMainWindow(companionSession?.id)} onOpenSettings={() => void showMainSettings(companionSession?.id)} onSendPrompt={(sessionId, text) => doRpc('session.prompt', { sessionId, text }).then(() => { void refreshTrayMenu().catch(() => undefined); return refresh() })} onCancelTurn={(sessionId) => doRpc('session.cancel', { sessionId }).then(() => { void refreshTrayMenu().catch(() => undefined); return refresh() })} onSelectAgent={selectAgent} />
    </>
  }

  const selectedMood = deriveCompanionStatus({ connected: connection === 'connected', runtime: selectedRuntime, session: selectedSession, composing: !!composer.trim(), now }).mood
  const sessionBusy = ['working', 'starting', 'waiting_permission'].includes(selectedSession?.state ?? '')
  const turnLive = ['working', 'waiting_permission'].includes(selectedSession?.state ?? '')
  const imagesSupported = ['claude', 'codex'].includes(String(selectedRuntime?.provider ?? '').toLowerCase())
  const sessionQuota = (snapshot?.quotas ?? []).find((item) => String(item.provider) === String(selectedRuntime?.provider ?? '').toLowerCase()) ?? null
  const runtimeReady = runtimeUsable(selectedRuntime)
  const approvalFocusOnMount = !composerTypingRef.current || connection !== 'connected' || busy || selectedSession?.state === 'waiting_permission' || !runtimeReady
  const canStartSession = connection === 'connected' && !busy && !!activeSelectedAgent && runtimeReady && !sideSession
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
  const sideOptions = activeSelectedAgent ? sideSessionsFor(sessions, activeSelectedAgent.id).map((session) => ({ value: session.id, label: formatUnknownSafe(session.title, 'Side conversation') })) : []
  const planOn = selectedSession?.modelLock?.planMode === true
  const latestPlanId = [...(selectedSession?.messages ?? [])].reverse().find((message) => message.role === 'plan')?.id ?? null
  const lastTurnWasPlan = planOn && !sessionBusy && (selectedSession?.messages ?? []).some((message) => message.role === 'assistant' || message.role === 'plan')
  const mentionCandidates = mention ? mentionMatches(agents.filter((agent) => agent.id !== activeSelectedAgent?.id && !agent.hidden), mention.query) : []
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
            <button className="icon-button" title="Create blob" aria-label="Create blob" disabled={connection !== 'connected' || busy || runtimes.length === 0} onClick={() => openCreate()}><Plus size={17} /></button>
            <div className="more-menu-wrap" onKeyDown={(event) => { if (event.key === 'Escape') { setCreateMenuOpen(false); restoreCreateFocus() } }}>
              <button type="button" className="icon-button small" title="Import a blob setup" aria-label="Blob actions" aria-haspopup="menu" aria-expanded={createMenuOpen} disabled={connection !== 'connected' || busy} onClick={() => setCreateMenuOpen((open) => !open)}><ChevronDown size={14} /></button>
              {createMenuOpen && <div className="menu-surface more-menu" role="menu"><button className="menu-item" role="menuitem" onClick={() => { setCreateMenuOpen(false); void createProject() }}>New project…</button><button className="menu-item" role="menuitem" onClick={() => void importBlob()}>Import blob…</button></div>}
            </div>
          </div>
        </div>
        <div className="sr-only" aria-live="polite">{rosterAnnouncement}</div>
        <TeamSidebar agents={agents} projects={projects} sessions={sessions} runtimes={runtimes} connected={connection === 'connected'} now={now} pinnedIds={pins.favorites ?? []} unreadSessionIds={unreadSessionIds} approvalSessionIds={approvalSessionIds} selectedAgentId={activeSelectedAgent?.id ?? null} query={search} onQueryChange={setSearch} actions={{
          onSelect: selectAgent,
          onCreate: (projectId) => openCreate(projectId),
          onCreateProject: () => void createProject(),
          onEdit: openEdit,
          onArchive: setArchiveTarget,
          onDuplicate: (agent) => void duplicateAgent(agent),
          onExportBlob: (agent) => void exportBlob(agent),
          onRename: (agent) => setTextPrompt({ title: `Rename ${agent.name}`, label: 'Blob name', value: agent.name, confirmLabel: 'Rename', onSubmit: async (name) => { const result = await doRpc<{ agent?: Agent }>('agent.update', { agentId: agent.id, name }, (reason) => messageForDaemonCode(daemonCodeOf(reason), 'agent.update', { sentName: true })); if (result.agent?.id) mergeAgent(result.agent) } }),
          onTogglePin: (agentId) => updatePins((current) => toggleFavorite(current, agentId)),
          onMove: (agent, projectId) => void teamUpdate(agent, { projectId }),
          onToggleLeader: (agent) => void teamUpdate(agent, { leader: !agent.leader }),
          onSetHidden: (agent, hidden) => void teamUpdate(agent, { hidden }),
          onToggleUnread: (_agent, session, unread) => { if (session) setSeenSessions((current) => markSeen(current, session.id, unread ? new Date(0).toISOString() : new Date().toISOString())) },
          onCopyConversationId: (_agent, session) => { if (session) void navigator.clipboard.writeText(session.id).catch(() => undefined) },
          onDeleteConversation: (_agent, session) => setSessionDeleteTarget(session),
          onRenameProject: (project) => setTextPrompt({ title: 'Rename project', label: 'Project name', value: project.name, confirmLabel: 'Rename', onSubmit: async (name) => { await projectAction('project.update', { projectId: project.id, name }) } }),
          onChangeProjectFolder: (project) => void openProjectFolder().then((path) => { if (path) void projectAction('project.update', { projectId: project.id, path }) }),
          onDeleteProject: setProjectDelete,
          onToggleProjectCollapsed: (project) => void projectAction('project.update', { projectId: project.id, collapsed: !project.collapsed }),
        }} />
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
        {analyticsOpen ? <AnalyticsView sessions={sessions} agents={agents} connected={connection === 'connected'} onBack={closeAnalytics} /> : blobPage && draft ? <BlobPage mode={blobPage.mode} agent={editingAgent} draft={draft} runtime={draftRuntime} session={blobPage.mode === 'edit' ? selectedSession : null} runtimes={runtimes} projects={projects} sessions={pageSessions} legacyCount={pageLegacy.length} connected={connection === 'connected'} saving={busy} dirty={draftDirty} ready={draftReady} canStartSession={connection === 'connected' && !busy && runtimeUsable(draftRuntime)} error={formError} remoteNotice={remoteNotice} errors={fieldErrors} execution={executionFromAgent(editingAgent)} autoApprovals={snapshot?.autoApprovals ?? []} bypassNotices={snapshot?.bypassNotices ?? []} onDraftChange={(next) => { setDraft(next); setFormError(null) }} onExecutionGate={(gate) => { executionGate.current = gate }} onBack={() => closeBlobPage(editingAgent?.id ?? activeSelectedAgent?.id ?? null)} onSave={() => void saveBlob()} onCancel={() => { const source = remoteNotice && editingAgent ? draftFromAgent(editingAgent) : baseline; if (!source) return; setDraft(source); setBaseline(source); setRemoteNotice(null); setFormError(null) }} onArchive={() => { if (editingAgent) setArchiveTarget(editingAgent) }} onNewSession={() => { if (editingAgent) newSession(editingAgent.id) }} onOpenSession={(session) => { setSelectedSessionId(session.id); closeBlobPage(editingAgent?.id ?? null) }} /> : <>
        {showCreateBlobPrompt && <div className="first-run-prompt" role="status"><span>No blobs yet. Create one to organize these conversations.</span><button type="button" className="secondary-button small" onClick={() => openCreate()}>Create blob</button></div>}
        <header className="chat-header">
          <div className="chat-title">
            {sideSession
              ? <SideConversationHeader peer={sidePeer} peerName={sideSession.link?.peerName ?? sidePeer?.name ?? 'Teammate'} target={sideAgent} targetName={sideAgent?.name ?? 'Teammate'} />
              : activeSelectedAgent
                ? <><button type="button" className="chat-title-button" aria-label={`Edit ${activeSelectedAgent.name}`} title="Blob settings" onClick={() => openEdit(activeSelectedAgent)}>{activeSelectedAgent.name}</button>{activeSelectedAgent.role?.trim() && <span className="role-chip">{activeSelectedAgent.role.trim()}</span>}</>
                : <strong className="chat-title-text">{agentName}</strong>}
            {!sideSession && activeSelectedAgent && sideOptions.length > 0 && <Select
              ariaLabel="Side conversations"
              variant="muted"
              align="left"
              className="session-switcher"
              value=""
              placeholder={`${sideOptions.length} side conversation${sideOptions.length === 1 ? '' : 's'}`}
              onChange={(value) => openSideConversation(value)}
              options={sideOptions}
            />}
          </div>
          <div className="header-actions">
            <ApprovalPill mode={headerMode} />
            {selectedSession?.resumable && !sessionBusy && <button className="icon-button" title="Resume conversation" aria-label="Resume conversation" disabled={busy || connection !== 'connected' || !runtimeReady} onClick={() => void resumeSession()}><Play size={15} /></button>}
            {!sideSession && <button className="icon-button" title="Start a fresh conversation" aria-label="New conversation" disabled={!canStartSession} onClick={(event) => newSession(undefined, event.currentTarget)}><SquarePen size={16} /></button>}
            <button className={`icon-button ${inspectorOpen ? 'active' : ''}`} title="Details" aria-label="Toggle context pane" aria-pressed={inspectorOpen} onClick={toggleInspector}><PanelRight size={16} /></button>
            <div className="more-menu-wrap" onKeyDown={(event) => { if (event.key === 'Escape') { setMoreOpen(false); restoreMoreFocus() } }}>
              <button className="icon-button" title="More options" aria-label="More options" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}><MoreHorizontal size={17} /></button>
              {moreOpen && <div className="menu-surface more-menu" role="menu"><button className="menu-item" role="menuitem" disabled={refreshing} onClick={() => { setMoreOpen(false); void refresh() }}><RefreshCw size={15} />Refresh state</button><button className="menu-item" role="menuitem" disabled={!selectedSession} onClick={() => { setMoreOpen(false); void showUsage() }}><Gauge size={15} />Usage details</button><button className="menu-item" role="menuitem" disabled={!selectedSession} onClick={() => { setMoreOpen(false); void exportConversation(true) }}>Copy as Markdown</button><button className="menu-item" role="menuitem" disabled={!selectedSession} onClick={() => { setMoreOpen(false); void exportConversation(false) }}>Export as Markdown…</button>{activeSelectedAgent && <button className="menu-item" role="menuitem" onClick={() => { setMoreOpen(false); openEdit(activeSelectedAgent) }}><Settings2 size={15} />Blob settings</button>}<span className="menu-separator" /><button role="menuitem" className="menu-item danger" onClick={() => void quitBloblex()}><X size={15} />Quit Bloblex</button></div>}
            </div>
          </div>
        </header>

        {error && <div className="inline-error" role="alert"><ShieldAlert size={16} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}><X size={15} /></button></div>}
        {archiveNotice && <div className="inline-error" role="status"><span>{archiveNotice}</span><button aria-label="Dismiss notice" onClick={() => setArchiveNotice(null)}><X size={15} /></button></div>}

        {!selectedSession ? <>{activePermission && <ApprovalCard permission={activePermission} onReply={(choice) => answerPermission(activePermission, choice)} /> }<EmptyConversation connected={connection === 'connected'} hasRuntime={runtimes.length > 0} hasAgent={!!activeSelectedAgent} accent={accent} mood={selectedMood} agentName={agentName} look={activeSelectedAgent ? agentLook(activeSelectedAgent) : null} onNewSession={(anchor) => newSession(undefined, anchor)} onCreate={() => openCreate()} onRefresh={() => void refreshRuntimes()} /></> : <>
          <section ref={messageListRef} className="message-list" aria-label="Conversation" onScroll={(event) => { const node = event.currentTarget; stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72 }}>
            <div className="conversation-layout">
              <ConversationOutline key={selectedSession.id} sessionId={selectedSession.id} items={outlineItems} />
              <div className="chat-column">
              {groupedConversationItems.length === 0 ? <div className="session-first-state"><BlobCanvas color={accent || '#e6e9ee'} size={112} mood={selectedMood} look={activeSelectedAgent ? agentLook(activeSelectedAgent) : null} label={activeSelectedAgent?.name ?? agentName} /><h2>Ready when you are.</h2><p>Ask {agentName} to explore <code>{currentProjectName ?? 'the project'}</code> or make a change.</p></div> : groupedConversationItems.map((item, index) => item.kind === 'activity-group'
                ? <ActivityGroupRow key={item.id} group={item} onDiff={(path, content) => setDiffViewer({ path, content })} />
                : item.kind === 'message' && teamItem(item.value!, item.id)
                  ? teamItem(item.value!, item.id)
                : item.kind === 'message'
                  ? <MessageItem key={item.id} id={`conversation-message-${encodeURIComponent(item.id)}`} message={item.value!} accent={accent} agentName={agentName} showAvatar={!isUserMessage(item.value) && (index === 0 || isPreviousItemNonMessageOrUser(groupedConversationItems, index))} mood={index === lastAgentIndex ? selectedMood : 'idle'}  agents={agents}/>
                  : <ActivityItem key={item.id} item={item} onDiff={(path, content) => setDiffViewer({ path, content })} />)}
              {activePermission && (activePermission.kind === 'question'
                ? <QuestionCard request={activePermission} onAnswer={(answers) => answerQuestion(activePermission, answers)} onDismiss={() => void answerQuestion(activePermission, null)} />
                : <ApprovalCard permission={activePermission} focusOnMount={approvalFocusOnMount} onReply={(choice) => answerPermission(activePermission, choice)} />)}
              {!sideSession && lastTurnWasPlan && !latestPlanId && <div className="plan-ready-bar" role="status"><span>Plan mode is on. Approve the plan to let {agentName} start building.</span><button type="button" className="primary-button small" onClick={() => void approvePlan()}>Approve &amp; build</button></div>}
              {selectedSession.state === 'working' && <div className="working-indicator" role="status"><span className="typing" aria-hidden="true"><i /><i /><i /></span>{agentName} is working</div>}
              </div>
            </div>
          </section>
          {sideSession ? <div className="side-close"><button type="button" className="secondary-button" onClick={() => setSideSessionId(null)}>Close chat</button></div> : <div className="composer-wrap">
            {dictationPartial && <div className="dictation-partial" role="status"><span className="dictation-partial-label">Listening</span>{dictationPartial}</div>}
            <div className={`composer-box ${composerDropActive ? 'drop-active' : ''}`} onDragOver={(event) => { if (!imagesSupported || !Array.from(event.dataTransfer.items).some((item) => item.kind === 'file')) return; event.preventDefault(); setComposerDropActive(true) }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setComposerDropActive(false) }} onDrop={(event) => { setComposerDropActive(false); if (!imagesSupported) return; const files = Array.from(event.dataTransfer.files); if (!files.length) return; event.preventDefault(); addAttachments(files) }}>
              <AttachmentTray attachments={attachments} onRemove={removeAttachment} />
              {mention && <MentionPicker agents={agents.filter((agent) => agent.id !== activeSelectedAgent?.id && !agent.hidden)} query={mention.query} activeIndex={mention.index} onPick={pickMention} onHover={(index) => setMention((current) => current ? { ...current, index } : current)} />}
              <textarea ref={composerRef} value={composer} onFocus={() => { composerTypingRef.current = true }} onBlur={() => { composerTypingRef.current = false }} onChange={(event) => { setComposer(event.target.value); const found = mentionQuery(event.target.value, event.target.selectionStart ?? event.target.value.length); setMention(found ? { ...found, index: 0 } : null) }} onPaste={(event) => { if (!imagesSupported) return; const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/')); if (!files.length) return; event.preventDefault(); addAttachments(files) }} onKeyDown={(event) => {
                if (mention && mentionCandidates.length) {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMention({ ...mention, index: (mention.index + (event.key === 'ArrowDown' ? 1 : mentionCandidates.length - 1)) % mentionCandidates.length }); return }
                  if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pickMention(mentionCandidates[Math.min(mention.index, mentionCandidates.length - 1)]); return }
                  if (event.key === 'Escape') { event.preventDefault(); setMention(null); return }
                }
                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendPrompt() }
              }} placeholder={`Message ${agentName}`} aria-label={`Message ${agentName}`} disabled={connection !== 'connected' || busy || selectedSession.state === 'waiting_permission' || !runtimeReady} rows={1} />
              <div className="composer-control-strip">
                <div className="composer-controls-start">
                  <AttachButton supported={imagesSupported} disabled={connection !== 'connected' || busy || !runtimeReady} count={attachments.length} onFiles={addAttachments} />
                  <button type="button" className={`composer-pill plan-pill ${planOn ? 'on' : ''}`} aria-pressed={planOn} aria-label="Plan mode" title={planOn ? 'Plan mode: the agent proposes a plan before changing anything' : 'Turn on plan mode'} disabled={connection !== 'connected' || sessionBusy} onClick={() => void setPlanMode(!planOn)}><ClipboardList size={14} aria-hidden="true" /><span>Plan</span></button>
                  <PermissionModeControl session={selectedSession} agent={activeSelectedAgent} disabled={connection !== 'connected' || sessionBusy} onSessionUpdated={(updated) => setSnapshot((current) => current ? mergeHydratedSession(current, updated.id, updated) : current)} onError={(reason) => setError(messageOf(reason))} />
                </div>
                <div className="composer-controls-end">
                  {selectedSession && activeSelectedAgent && <SessionExecutionControls session={selectedSession} agent={activeSelectedAgent} onSessionUpdated={(updated) => setSnapshot((current) => current ? mergeHydratedSession(current, updated.id, updated) : current)} onError={(reason) => setError(messageOf(reason))} />}
                  <ContextWindowIndicator used={selectedSession.contextUsed} size={selectedSession.contextSize} quota={sessionQuota} onOpenUsage={() => void showUsage()} />
                  <DictationButton owner="desktop" onFinal={(text) => setComposer((current) => (current ? `${current} ${text}` : text))} onPartial={setDictationPartial} disabled={connection !== 'connected' || busy || selectedSession.state === 'waiting_permission' || !runtimeReady} />
                  <button className={`send-button ${turnLive ? 'cancel' : ''}`} onClick={turnLive ? () => void cancelTurn() : () => void sendPrompt()} disabled={busy || (!turnLive && ((!composer.trim() && !attachments.some((item) => item.status === 'ready')) || attachments.some((item) => item.status === 'staging') || !runtimeReady))} aria-label={turnLive ? 'Cancel turn' : 'Send message'}>{busy ? <LoaderCircle size={16} className="spinning" /> : turnLive ? <Square size={12} fill="currentColor" /> : <ArrowUp size={17} />}</button>
                </div>
              </div>
            </div>
            <div className="composer-note">{currentProjectName ? <><FolderOpen size={11} />{currentProjectName}<span>·</span></> : null}Agent actions run on your device. You approve what matters.</div>
          </div>}
        </>}
        </>}
      </section>

      <aside className="context-pane" aria-label="Conversation details" aria-hidden={!detailsVisible} inert={!detailsVisible}>
        <section className="context-head">
          {activeSelectedAgent ? <BlobCanvas color={accent} size={64} mood={selectedMood} look={agentLook(activeSelectedAgent)} label={activeSelectedAgent.name} /> : <span className="context-head-placeholder"><Code2 size={20} /></span>}
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

      {!companion && usageBarEnabled && <QuotaBar quotas={snapshot?.quotas ?? []} refreshing={quotaRefreshing} onRefresh={refreshQuota} onOpenDetails={() => void showUsage()} />}
      {usageSheet && <UsageSheet summary={usageSummary} period={usagePeriod} quotas={snapshot?.quotas ?? []} loading={busy && usageSummary === null} quotaRefreshing={quotaRefreshing} onRefreshQuota={refreshQuota} onPeriodChange={(period) => { setUsageSummary(null); void showUsage(period) }} onOpenHistory={() => { setUsageSheet(false); setAnalyticsOpen(true) }} onClose={() => setUsageSheet(false)} />}
      {quickSwitcherOpen && <QuickSwitcher items={quickSwitcherItems} onChoose={chooseQuickSwitcherItem} onClose={() => setQuickSwitcherOpen(false)} />}
      {settingsSheet && <SettingsSheet snapshot={snapshot} usageBarEnabled={usageBarEnabled} onUsageBarChange={setUsageBarEnabled} initialPage={settingsInitialPage} focusUpdates={settingsFocus === 'updates'} onClose={() => { setSettingsSheet(false); setSettingsFocus(null) }} onRefresh={refreshRuntimes} onError={setError} onRunSetup={() => { setSettingsSheet(false); setOnboardingVisible(true) }} onOpenAgent={(agentId) => { const target = agents.find((agent) => agent.id === agentId); setSettingsSheet(false); if (target) openEdit(target) }} />}
      {diffViewer && <DiffViewer path={diffViewer.path} content={diffViewer.content} onClose={() => setDiffViewer(null)} />}
      {archiveTarget && <ConfirmDialog title={`Archive ${archiveTarget.name}?`} body="It leaves the sidebar and companion. Its conversations stay saved. Restoring a blob is not available yet." confirmLabel="Archive blob" cancelLabel="Keep it" tone="warning" icon={<BlobCanvas decorative color={agentColorHex(archiveTarget.color)} size={34} mood="sleeping" look={agentLook(archiveTarget)} label={`${archiveTarget.name} preview`} />} onConfirm={() => void confirmArchive()} onCancel={() => setArchiveTarget(null)} />}
      {sessionDeleteTarget && <ConfirmDialog title="Delete this conversation?" body="This removes it and its messages from Bloblex. The coding agent's own history is not touched." confirmLabel="Delete" cancelLabel="Cancel" holdToConfirm successTitle="Conversation deleted" successBody="This conversation and its messages were removed from Bloblex." onConfirm={async () => { await rpc('session.delete', { sessionId: sessionDeleteTarget.id }) }} onComplete={() => { setSessionDeleteTarget(null); focusSidebarBlob() }} onCancel={() => { const id = sessionDeleteTarget.id; setSessionDeleteTarget(null); focusSidebarSession(id) }} />}
      {textPrompt && <TextPromptDialog {...textPrompt} onCancel={() => setTextPrompt(null)} onSubmit={async (value) => { try { await textPrompt.onSubmit(value); setTextPrompt(null) } catch (reason) { setError(messageOf(reason)) } }} />}
      {projectDelete && <ConfirmDialog title={`Delete ${projectDelete.name}?`} body="The project is removed from Bloblex. Its blobs move to Unassigned and the folder on disk is not touched." confirmLabel="Delete project" cancelLabel="Keep it" tone="danger" onConfirm={() => { const project = projectDelete; setProjectDelete(null); void projectAction('project.delete', { projectId: project.id }) }} onCancel={() => setProjectDelete(null)} />}
      {freshTarget && <ConfirmDialog title={`Start fresh with ${freshTarget.name}?`} body="The current conversation is archived and a new one begins in the same place. Use this when the context is full or you want a clean slate." confirmLabel="Start fresh" cancelLabel="Keep chatting" onConfirm={() => { const agent = freshTarget; setFreshTarget(null); void startFresh(agent) }} onCancel={() => setFreshTarget(null)} />}
      {pendingBlobImport && <ImportBlobDialog blob={pendingBlobImport} runtimes={runtimes} onCancel={() => { setPendingBlobImport(null); restoreCreateFocus() }} onCreate={(runtimeId) => createImportedBlob(pendingBlobImport, runtimeId)} />}
    </main>
  )
}

function ImportBlobDialog({ blob, runtimes, onCancel, onCreate }: { blob: SharedBlob; runtimes: Runtime[]; onCancel: () => void; onCreate: (runtimeId: string) => void }) {
  const { ref, close } = useDialogAccessibility(onCancel)
  const suggested = runtimes.find((runtime) => runtime.provider === blob.providerId)?.id ?? runtimes[0]?.id ?? ''
  const [runtimeId, setRuntimeId] = useState(suggested)
  const instructionLength = blob.instructions.trim().length
  const facts = [
    { label: 'Shape', value: SHAPE_LABELS[blob.look.shape] },
    { label: 'Model', value: blob.model ?? 'Agent default' },
    blob.thinking ? { label: 'Effort', value: labelize(blob.thinking) } : null,
    blob.speed ? { label: 'Speed', value: labelize(blob.speed) } : null,
    { label: 'Approvals', value: blob.defaultApprovalMode === 'auto' ? 'Auto-approve' : 'Ask first' },
    { label: 'Instructions', value: instructionLength ? `${instructionLength.toLocaleString()} characters` : 'None' },
  ].filter((fact): fact is { label: string; value: string } => !!fact)
  const pick = (index: number) => { const next = runtimes[(index + runtimes.length) % runtimes.length]; if (next) { setRuntimeId(next.id); document.getElementById(`import-runtime-${next.id}`)?.focus() } }
  const entered = useDialogEntered()
  return <div className={`sheet-backdrop blob-dialog-backdrop${entered ? ' is-entered' : ''}`}><section ref={ref} className="blob-dialog import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-blob-title" tabIndex={-1} style={{ ['--import-accent' as string]: blob.colour }}>
    <header className="import-hero">
      <span className="import-hero-stage"><BlobCanvas color={blob.colour} size={92} mood="idle" look={blob.look} label={`${blob.name} preview`} /></span>
      <span className="import-hero-copy">
        <span className="import-kicker">Blob file</span>
        <h2 id="import-blob-title">Import {blob.name}</h2>
        <p>{blob.description.trim() || 'No description in this file.'}</p>
      </span>
    </header>
    <dl className="import-facts">{facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
    {runtimes.length === 0
      ? <p className="import-empty" role="alert">No coding agents are available. Scan again before importing.</p>
      : <div className="import-runtimes" role="radiogroup" aria-label="Attach imported blob to coding agent">
        <span className="import-section-label">Runs on</span>
        {runtimes.map((runtime, index) => {
          const selected = runtime.id === runtimeId
          const matching = runtime.provider === blob.providerId
          return <button key={runtime.id} id={`import-runtime-${runtime.id}`} type="button" role="radio" aria-checked={selected} tabIndex={selected ? 0 : -1} className={`import-runtime${selected ? ' selected' : ''}`} onClick={() => setRuntimeId(runtime.id)} onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); pick(index + 1) }
            if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); pick(index - 1) }
          }}>
            <ProviderLogo provider={runtime.provider} size={18} />
            <span className="import-runtime-copy"><strong>{providerBrand(runtime.provider).name}</strong><small>{[runtime.version, labelize(runtime.status, '')].filter(Boolean).join(' · ') || 'Installed on this device'}</small></span>
            {matching && <span className="import-match">Matches the file</span>}
            <span className="import-radio" aria-hidden="true" />
          </button>
        })}
      </div>}
    <p className="import-note">Continue opens a draft you can edit. Nothing is created until you choose Create blob.</p>
    <div className="blob-dialog-actions"><button type="button" className="secondary-button" data-dialog-initial-focus onClick={close}>Cancel</button><button type="button" className="primary-button" disabled={!runtimeId} onClick={() => onCreate(runtimeId)}>Continue</button></div>
  </section></div>
}

function EmptyConversation({ connected, hasRuntime, hasAgent, accent, mood, agentName, look, onNewSession, onCreate, onRefresh }: { connected: boolean; hasRuntime: boolean; hasAgent: boolean; accent: string; mood: BlobMood; agentName: string; look: BlobLook | null; onNewSession: (anchor?: HTMLElement | null) => void; onCreate: () => void; onRefresh: () => void }) {
  const canvas = hasAgent ? <BlobCanvas color={accent} size={128} mood={connected ? mood : 'offline'} look={look} label={agentName} /> : <BlobCanvas color="#e6e9ee" size={128} mood={connected ? 'idle' : 'offline'} label="Bloblex" />
  const heading = !connected ? 'Connect to your local runtime' : hasAgent ? `Start a conversation with ${agentName}` : hasRuntime ? 'No blobs yet.' : 'Find your coding agent'
  const description = !connected ? 'Bloblex keeps its daemon and agent sessions on this device. Reconnect to load the latest state.' : hasAgent ? 'Choose a project folder. Your selected CLI starts a real session there.' : hasRuntime ? 'Create a blob for one of the coding CLIs on this device.' : 'We only show agents installed on this device. Refresh to scan for Claude Code, Codex, or OpenCode.'
  const label = !connected ? 'Try again' : hasAgent ? 'Choose a project' : hasRuntime ? 'Create blob' : 'Scan for agents'
  return <div className="empty-conversation"><div className="empty-art">{canvas}</div><h1>{heading}</h1><p className="empty-description">{description}</p><button className="primary-button" onClick={(event) => { if (!connected || !hasAgent && !hasRuntime) onRefresh(); else if (hasAgent) onNewSession(event.currentTarget); else onCreate() }} disabled={!connected && !hasRuntime}><FolderOpen size={15} />{label}</button></div>
}

/** Your own message, with @mentions of team blobs shown as their avatar and name in their colour. */
function UserMessageText({ text, agents }: { text: string; agents: readonly Agent[] }) {
  const segments = splitMentions(text, agents)
  if (!segments.some((segment) => segment.agent)) return <SafeMessageText text={text} />
  return <p className="message-mentions">{segments.map((segment, index) => segment.agent
    ? <span key={index} className="mention" style={{ ['--mention' as string]: agentColorHex(segment.agent.color) }} title={`@${segment.agent.name}`}>
        <BlobCanvas decorative color={agentColorHex(segment.agent.color)} size={18} mood="idle" look={agentLook(segment.agent)} label={segment.agent.name} />{segment.agent.name}
      </span>
    : <span key={index}>{segment.text}</span>)}</p>
}

function MessageItem({ id, message, accent, agentName, showAvatar, mood, agents = [] }: { id: string; message: Record<string, unknown>; accent: string; agentName: string; showAvatar: boolean; mood: BlobMood; agents?: readonly Agent[] }) {
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
      {isUser && <MessageAttachments attachments={message.attachments} />}
      {isTool ? <div className={`activity-card ${isError ? 'error' : ''}`}><div className="activity-heading"><Terminal size={14} /><strong>{labelize(toolName ?? eventType.replace('.', ' '))}</strong><span>{isError ? 'Failed' : formatUnknownSafe(String(message.status ?? ''), 'Activity')}</span></div><p>{text || (typeof message.command === 'string' ? message.command : typeof message.summary === 'string' ? message.summary : 'Details are unavailable for this event.')}</p>{typeof message.path === 'string' && <code>{message.path}</code>}</div> : text || !(isUser && Array.isArray(message.attachments) && message.attachments.length) ? <div className={`message-bubble ${isError ? 'message-error' : ''}`}>{isUser && text ? <UserMessageText text={text} agents={agents} /> : <SafeMessageText text={text || 'Message content unavailable.'} />}</div> : null}
      {stamp && <div className="message-time">{stamp}</div>}
    </div>
  </article>
}

function TextPromptDialog({ title, label, value, confirmLabel, onSubmit, onCancel }: { title: string; label: string; value: string; confirmLabel: string; onSubmit: (value: string) => void | Promise<void>; onCancel: () => void }) {
  const { ref, close } = useDialogAccessibility(onCancel)
  const [text, setText] = useState(value)
  const [saving, setSaving] = useState(false)
  const trimmed = text.trim()
  return <div className="sheet-backdrop blob-dialog-backdrop is-entered">
    <section ref={ref as React.RefObject<HTMLElement>} className="blob-dialog" role="dialog" aria-modal="true" aria-labelledby="text-prompt-title">
      <h2 id="text-prompt-title">{title}</h2>
      <form className="text-prompt-form" onSubmit={async (event) => { event.preventDefault(); if (!trimmed || saving) return; setSaving(true); try { await onSubmit(trimmed) } finally { setSaving(false) } }}>
        <label className="blob-field">{label}<input data-dialog-initial-focus value={text} maxLength={80} onChange={(event) => setText(event.target.value)} onFocus={(event) => event.currentTarget.select()} /></label>
        <div className="blob-dialog-actions">
          <button type="button" className="secondary-button" onClick={close}>Cancel</button>
          <button type="submit" className="primary-button" disabled={!trimmed || trimmed === value.trim() || saving}>{saving ? 'Saving…' : confirmLabel}</button>
        </div>
      </form>
    </section>
  </div>
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

function QuotaDetails({ quotas, refreshing, onRefresh }: { quotas: Record<string, unknown>[]; refreshing: boolean; onRefresh: () => void }) {
  const rows = quotaRows(quotas)
  return <section className="usage-block quota-details" aria-label="Plan usage limits">
    <div className="usage-block-heading"><h3>Plan usage limits</h3><span>Reported by each CLI account</span><button type="button" className="secondary-button small" onClick={onRefresh} disabled={refreshing}>{refreshing ? 'Checking…' : 'Refresh quota'}</button></div>
    {rows.length ? <div className="quota-cards">{rows.map((row) => {
      const updated = updatedAgo(row.fetchedAt)
      return <article key={row.provider} className="quota-card" data-provider={row.provider}>
        <header><ProviderLogo provider={row.provider} size={18} /><strong>{row.name}</strong>{updated && <small>{updated}</small>}</header>
        {row.windows.length ? row.windows.map((window) => {
          const reset = resetIn(window.resetsAt)
          return <div key={window.key} className="quota-card-window">
            <div className="quota-card-line"><span>{window.label}</span><b>{window.usedPercent}%</b></div>
            <i className={`quota-meter tone-${quotaTone(window.usedPercent)}`} aria-hidden="true"><b style={{ width: `${window.usedPercent}%` }} /></i>
            {reset && <small>Resets in {reset}</small>}
          </div>
        }) : <p className="quota-card-empty">{row.status ?? 'Unavailable'}</p>}
        {row.stale && <p className="quota-card-empty">{row.status}: last successful reading retained.</p>}
      </article>
    })}</div> : <p className="usage-empty-line">No supported provider account quota source is available.</p>}
  </section>
}

function UsageSheet({ summary, period, quotas, loading, quotaRefreshing, onRefreshQuota, onPeriodChange, onOpenHistory, onClose }: { summary: Record<string, unknown> | null; period: 'today' | 'month'; quotas: Record<string, unknown>[]; loading: boolean; quotaRefreshing: boolean; onRefreshQuota: () => void; onPeriodChange: (period: 'today' | 'month') => void; onOpenHistory: () => void; onClose: () => void }) {
  const { ref: dialogRef, close } = useDialogAccessibility(onClose)
  return <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><section ref={dialogRef} className="usage-sheet" role="dialog" aria-modal="true" aria-labelledby="usage-title">
    <header><div><p className="eyebrow">USAGE</p><h2 id="usage-title">Usage summary</h2><small className="usage-scope">All runtimes on this device</small></div><button className="icon-button" data-dialog-initial-focus aria-label="Close usage summary" onClick={close}><X size={17} /></button></header>
    <div className="usage-sheet-body">
      <QuotaDetails quotas={quotas} refreshing={quotaRefreshing} onRefresh={onRefreshQuota} />
      <section className="usage-block">
        <div className="usage-block-heading"><h3>Token usage</h3><span>{summary && typeof summary.from === 'string' && typeof summary.to === 'string' ? `${shortDate(summary.from)} – ${shortDate(summary.to)}` : 'Recorded activity'}</span></div>
        <div className="usage-period-switch" aria-label="Usage date range"><button className={period === 'today' ? 'active' : ''} aria-pressed={period === 'today'} onClick={() => onPeriodChange('today')}>Today</button><button className={period === 'month' ? 'active' : ''} aria-pressed={period === 'month'} onClick={() => onPeriodChange('month')}>This month</button></div>
        {loading ? <div className="sheet-loading"><LoaderCircle className="spinning" /><span>Loading the daemon summary…</span></div> : summary ? <div className="usage-token-grid">{usageTokenBuckets(summary).map((bucket) => <div className="usage-token" key={bucket.key}><span>{bucket.label}</span><strong>{bucket.value}</strong></div>)}</div> : <div className="sheet-empty"><CircleHelp size={20} /><strong>Usage summary unavailable</strong><p>The daemon did not return token usage for this period.</p></div>}
      </section>
    </div>
    <footer><span>Token counts describe recorded activity. Plan limits are a separate account quota.</span><button type="button" className="secondary-button small" onClick={onOpenHistory}>Usage history</button></footer>
  </section></div>
}

function shortDate(value: unknown) {
  if (typeof value !== 'string') return 'unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function recordFrom(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }

function Companion({ agent, agents, projects = [], sessions = [], runtime, runtimes, session, usage, connected, appError, activityLabel, permission, approvalMode, onReply, onAnswerQuestion, onNewSession, onOpenMain, onOpenSession, onOpenSettings, onSendPrompt, onCancelTurn, onSelectAgent }: { agent: Agent | null; agents: Agent[]; projects?: Project[]; sessions?: Session[]; runtime: Runtime | null; runtimes: Runtime[]; session: Session | null; usage?: Record<string, unknown>; connected: boolean; appError: string | null; activityLabel: string; permission?: PermissionRequest; approvalMode: ReturnType<typeof effectiveApprovalMode>; onReply: (permission: PermissionRequest, choice: string) => boolean | void | Promise<boolean | void>; onAnswerQuestion?: (permission: PermissionRequest, answers: Record<string, string[]> | null) => Promise<unknown> | void; onNewSession: (anchor?: HTMLElement | null) => void; onOpenMain: () => void; onOpenSession?: (sessionId: string) => void; onOpenSettings: () => void; onSendPrompt: (sessionId: string, text: string) => Promise<unknown>; onCancelTurn: (sessionId: string) => Promise<unknown>; onSelectAgent: (agent: Agent) => void }) {
  // The browser preview can open a view directly: /?companion&mode=home&view=chat.
  const previewParams = previewMode ? new URLSearchParams(location.search) : null
  const [view, setView] = useState<'overview' | 'chat' | 'activity' | 'settings'>(() => {
    const requested = previewParams?.get('view')
    return requested === 'chat' || requested === 'activity' || requested === 'settings' ? requested : 'overview'
  })
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
  // Chat, activity and inline questions use the taller island; approvals keep the overview size.
  const tall = mode === 'home' && (permission ? permission.kind === 'question' : (view === 'chat' || view === 'activity'))
  const presentation = mode === 'home' && tall ? 'home-chat' : mode
  useEffect(() => {
    const fsm = fsmRef.current!
    fsm.onTransition = (_from, to) => setMode(to)
    fsm.forcePetit(true)
    // After the mount effects that settle the island, so the preview's open view stays open.
    const previewHome = previewParams?.get('mode') === 'home' ? window.setTimeout(() => fsm.forceHome(true), 60) : 0
    return () => { window.clearTimeout(previewHome); fsm.dispose(); void setCompanionMode('petit') }
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
  // Sounds for the island's own moments: it peeks in, opens, closes, and pops on a new reply.
  const previousMode = useRef(mode)
  useEffect(() => {
    if (previousMode.current === 'petit' && mode === 'home') playCompanionCue('open')
    else if (previousMode.current === 'home' && mode === 'petit') playCompanionCue('close')
    previousMode.current = mode
  }, [mode])
  useEffect(() => { if (popIn) playCompanionCue('peek') }, [popIn])
  const lastMessage = session?.messages?.at(-1)
  const lastMessageKey = lastMessage ? `${session?.id}:${String(lastMessage.id ?? session?.messages?.length)}` : ''
  const previousMessageKey = useRef(lastMessageKey)
  useEffect(() => {
    const previous = previousMessageKey.current
    previousMessageKey.current = lastMessageKey
    if (!previous || !lastMessageKey || previous === lastMessageKey) return
    if (!previous.startsWith(`${session?.id}:`)) return
    if (lastMessage?.role !== 'user' && lastMessage?.role !== 'thinking') playCompanionCue('pop')
  }, [lastMessageKey, lastMessage?.role, session?.id])
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
  const openView = (next: typeof view) => { if (next !== view) playCompanionCue('blip'); setView(next); if (mode !== 'home') fsmRef.current?.forceHome() }
  const selectTeamBlob = (item: Agent) => { if (item.id !== agent?.id) playCompanionCue('blip'); onSelectAgent(item) }
  const replyToPermission = (request: PermissionRequest, choice: string) => { if (/allow|approve|accept|yes/i.test(choice)) playCompanionCue('approve'); return onReply(request, choice) }
  const focusTeam = teamLine(agent, agents, sessions)
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
      playCompanionCue('gulp')
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
    playCompanionCue('send')
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
    if (enabled) void unlockCompanionAudioFromGesture().then((unlocked) => { if (unlocked) playCompanionCue('tick') })
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
  const recentMessages = (session?.messages ?? []).filter((message) => message.role !== 'thinking').slice(-6)
  const recentActivities: Array<Record<string, unknown> & { activityKind: 'tool' | 'file' }> = [
    ...(session?.tools ?? []).slice(-4).map((item): Record<string, unknown> & { activityKind: 'tool' } => ({ ...item, activityKind: 'tool' })),
    ...(session?.files ?? []).slice(-4).map((item): Record<string, unknown> & { activityKind: 'file' } => ({ ...item, activityKind: 'file' })),
  ].sort((a, b) => Number(a['sequence'] ?? 0) - Number(b['sequence'] ?? 0)).slice(-5)
  const color = agent ? agentColorHex(agent.color) : ''
  const name = agent?.name ?? (runtime ? labelize(runtime.provider) : 'Bloblex')
  const peers = activeAgents(agents).filter((item) => item.id !== agent?.id).slice(0, 4)
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
  const focusBlob = (size: number) => <BlobCanvas color={color} size={size} mood={displayMood} fileStage={fileStage} look={agent ? agentLook(agent) : null} soundCues={soundsEnabled} label={name} onDizzy={beginConfused} onDizzyRecovery={recoverFromConfused} />
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
        <div className="compact-copy" onClick={() => fsmRef.current?.click()}><span className="compact-name"><strong>{name}</strong>{agent?.role?.trim() && <span className="companion-role">{agent.role.trim()}</span>}<ApprovalPill mode={approvalMode} compact /></span><span role="status" aria-live="polite" className={`compact-status ${shimmering ? 'shimmer' : ''}`}>{statusLine}</span></div>
        {permission && <ShieldAlert className="companion-alert" size={15} aria-label="Approval required" />}
        {peers.length > 0 && <div className="mini-grid" aria-hidden="true" data-tauri-drag-region>{peers.map((item) => { const peerRuntime = runtimes.find((candidate) => candidate.id === item.runtimeId); const offline = !connected || !peerRuntime || ['offline', 'error', 'disconnected'].includes((peerRuntime.status ?? '').toLowerCase()); return <BlobCanvas key={item.id} color={agentColorHex(item.color)} size={15} mini mood={offline ? 'offline' : 'idle'} look={agentLook(item)} label={item.name} /> })}</div>}
        <button className="companion-collapse" aria-label="Expand companion" onClick={() => fsmRef.current?.click()}><ChevronUp size={15} /></button>
      </div> : <>
        <header className="island-header" data-tauri-drag-region>
          <nav className="tabs" aria-label="Companion navigation">
            <button className={`tab ${view === 'overview' ? 'on' : ''}`} aria-label="Home" title="Home" onClick={() => openView('overview')}><Home size={13} /></button>
            <button className={`tab ${view === 'chat' ? 'on' : ''}`} aria-label="Chat" title="Chat" onClick={() => openView('chat')}><MessageCircle size={13} /></button>
            <button className={`tab ${view === 'activity' ? 'on' : ''}`} aria-label="Activity" title="Activity" onClick={() => openView('activity')}><Activity size={13} /></button>
            <button className="tab" aria-label="New conversation" title="New conversation" disabled={!canStart} onClick={(event) => { openView('chat'); onNewSession(event.currentTarget) }}><Plus size={14} /></button>
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
              {permission.kind === 'question'
                ? <QuestionCard request={permission} onAnswer={(answers) => { playCompanionCue('approve'); return onAnswerQuestion?.(permission, answers) }} onDismiss={() => void onAnswerQuestion?.(permission, null)} />
                : <ApprovalCard permission={permission} variant="companion" onReply={(choice) => replyToPermission(permission, choice)} />}
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
                <div className="who"><span className="name">{name}</span>{agent?.role?.trim() && <span className="companion-role">{agent.role.trim()}</span>}{agent?.leader && <span className="companion-leader" title="Team leader" aria-label="Team leader">★</span>}<span className="tool">{session?.title?.trim() ? session.title : runtime ? labelize(runtime.provider) : (connected ? 'No active session' : 'Offline')}</span></div>
                <div className="ticker">{tickerLines.map((line, index) => <div key={index} className={`ticker-row ${index === tickerLines.length - 1 ? 'current' : ''}`}><span className={index === tickerLines.length - 1 && shimmering ? 'shimmer' : ''}>{line}</span></div>)}</div>
                {focusTeam ? <button type="button" className="glance team-glance" onClick={() => onOpenSession?.(focusTeam.sessionId)} title="Open the side conversation in Bloblex">{focusTeam.peer && <BlobCanvas decorative color={agentColorHex(focusTeam.peer.color)} size={14} mini look={agentLook(focusTeam.peer)} label={focusTeam.peer.name} />}<span>{focusTeam.text}</span></button>
                  : <div className="glance" title={`Reported tokens across all blobs. Input ${inputTokens === null ? 'unknown' : inputTokens.toLocaleString()} · Output ${outputTokens === null ? 'unknown' : outputTokens.toLocaleString()}`}><span>All blobs: Tokens <b>{tokenGlance}</b></span></div>}
              </div>
            </div>
            <CompanionTeamCard agents={agents} projects={projects} sessions={sessions} runtimes={runtimes} connected={connected} selectedId={agent?.id ?? null} onSelect={selectTeamBlob} />
          </div> : view === 'chat' ? <div className="island-card chat-card companion-chat-view">
            <span className="card-bot small">{focusBlob(44)}</span>
            <div className="chat-body">
              <div className="chat-log" ref={chatLogRef} data-companion-no-drag="">
                {!session && <p className="companion-empty companion-no-session">Open or create a session to chat here. <button type="button" disabled={!canStart} onClick={(event) => onNewSession(event.currentTarget)}>New session</button></p>}
                {recentMessages.map((message, index) => <CompanionChatItem key={String(message.id ?? index)} message={message} agents={agents} onOpenSide={(sessionId) => { if (sessionId) onOpenSession?.(sessionId) }} />)}
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
            <CompanionTeamActivity agent={agent} agents={agents} sessions={sessions} onOpen={(sessionId) => onOpenSession?.(sessionId)} />
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
