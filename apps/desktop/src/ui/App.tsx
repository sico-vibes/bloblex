import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { Activity, ListChecks, ArrowUp, ArrowUpRight, ChevronDown, ChevronLeft, ChevronUp, CircleHelp, ClipboardCopy, ClipboardList, Code2, FileDown, FileText, FolderOpen, FolderInput, FolderPlus, Hash, Import, Gauge, Home, Info, LoaderCircle, MessageCircle, MoreHorizontal, PanelLeft, PanelRight, Paperclip, Plus, RefreshCw, RotateCw, Settings2, ShieldAlert, Square, SquarePen, Terminal, Volume2, VolumeX, X, BriefcaseBusiness } from 'lucide-react'
import { agentLook, SHAPE_LABELS, type BlobLook } from '../blob/look'
import { COMPANION_CHAT_SIZE_LABELS, COMPANION_CHAT_SIZES, isCompanionChatSize, MAX_COMPANION_PEERS, type CompanionChatSize } from '../blob/companionLayout'
import { BlobCanvas, type BlobMood } from '../blob/BlobCanvas'
import { setAccentColor, setBitbotsEnabled, setThemeStyle, themeStyle } from '../blob/bitbots'
import { PixelClouds } from './PixelClouds'
import { AppWallpaper } from './AppWallpaper'
import { applyFonts } from './fonts'
import { disposeCompanionAudio, playCompanionCue, setCompanionSoundsEnabled, setCompanionSoundVolume, unlockCompanionAudioFromGesture } from '../blob/soundCues'
import { playDictationCue } from './dictationSound'
import { CompanionFsm, type CompanionMode } from '../blob/companionFsm'
import { buildConversationItems, groupConversationActivity, withoutStaleContextNotices, type ConversationItem, type GroupedConversationItem } from './conversation'
import { compactMoodLabel, deriveCompanionStatus } from './companionStatus'
import { AnalyticsView } from './AnalyticsView'
import { SchedulesView, type AutomationInput } from './SchedulesView'
import { TasksView } from './TasksView'
import type { DaemonSchedule } from './automationSchedule'
import { usageTokenBuckets } from './usagePresentation'
import { Tip } from './Tip'
import { isPendingPermissionLive, nextPermissionDeadline, selectPendingPermission } from './permissionSelection'
import { ApprovalCard } from './ApprovalCard'
import bloblexLogo from '../assets/bloblex-128.png'
import { sessionsForPauseRequest } from './trayActions'
import { applyEvent, formatUnknownSafe, isPermissionReplyAllowed, labelize, isAutomation, normalizeQueueState, type Agent, type AutomationRun, type ChatMessage, type ConnectionState, type DaemonEvent, type PermissionRequest, type Project, type Runtime, type Session, type Snapshot } from '../types'
import { agentColorHex } from './agentColor'
import { TeamSidebar } from './TeamSidebar'
import { RuntimeProblemMarker } from './RuntimeProblemMarker'
import { AutoRetryNotice, ContextResetDivider, ConversationPicker, CreatedBotChip, HandoffDialog, DelegationChip, MentionPicker, PlanCard, QuestionCard, ReplyChip, SideConversationHeader, conversationMatches, mentionMatches, sideTitle } from './TeamMessages'
import { botProjectName, CompanionConversationPicker } from './CompanionConversationPicker'
import { SignInHelp } from './SignInHelp'
import { ProposalCard } from './ProposalCard'
import { ManagerSetupCard } from './ManagerSetupCard'
import { draftSessionFor, isDraftSession, managerOf } from './teamSelectors'
import { CompanionChatItem, CompanionPeers, CompanionTeamActivity, CompanionTeammatesSetting, FocusTicker, sessionSteps, teamLine } from './CompanionTeam'
import { NeedsYouBadge, PermissionQueueBar, nextWaitingAgent, waitingAgentsOf } from './CompanionAttention'
import { CompanionActivitySummary, CompanionRemoteRow, useWorkingSince, CompanionSettingCopy } from './CompanionPanels'
import { detectFinished, nextPeek, peekText, PEEK_VISIBLE_MS, type Peek, type PeekSessionState } from './companionPeek'
import { applyFocusMode, focusModeFromSettings, FOCUS_MODE_CHANGED_EVENT, saveFocusMode, subscribeFocusMode, DEFAULT_FOCUS_MODE } from './companionPrefs'
import { advanceDropZone, dropChips, dropZoneActive, DROP_LEAVE_GRACE_MS, type DropPhase } from './companionDrop'
import { clearCompanionPosition } from './companionPositions'
import { earlierWindow, isNearBottom, metricsOf } from './chatScroll'
import { SoundVolumeSlider } from './SoundVolumeSlider'
import { DEFAULT_SOUND_VOLUME, normalizeSoundVolume } from '../blob/soundVolume'
import { applySoundPrefs, saveSoundsEnabled, saveSoundVolume, soundPrefsFromSettings, subscribeSoundPrefs, SOUNDS_CHANGED_EVENT, SOUND_VOLUME_CHANGED_EVENT } from './soundPrefs'
import { ActivitySteps, ActivitySummaryLine } from './ActivityDetails'
import { busyDelivery, busySendMode, BUSY_SEND_SETTING, sendWithDelivery, steerRuntimeId, useSteerAvailable, type BusySendMode } from './busySend'
import { fetchCached, invalidateCatalog } from './catalogCache'
import { ConversationsPanel } from './ConversationsPanel'
import { SessionRail } from './SessionRail'
import { WorkingBotsPanel } from './WorkingBotsPanel'
import { ChangeBanner } from './ChangeBanner'
import { conversationPlaceName, hashQuery, HYDRATE_AT_ONCE, hydrationOrder, isEmptyConversation, isSideSession, isWaitingDelegation, sideTopic, mainSessionFor, mentionQuery, sideSessionsFor, splitMentions, splitReferences } from './teamSelectors'
import { effectiveApprovalMode } from '../approvalContract'
import type { ExecutionSendGate } from '../executionContract'
import { parseExecSnapshot } from '../executionContract'
import { friendlyError } from './errorCopy'
import { changedFields, createDraft, createParams, daemonCodeOf, draftFromAgent, teamParams, duplicateParams, executionFromAgent, isAgentDirty, messageForDaemonCode, updateParams, validateAgentDraft, type AgentDraft } from './agentForm'
import { activeAgents, agentSessions, agentsForRuntime, duplicateAgentName, legacySessions, nextAgentAfterArchive, placeAgentOrder, projectGroups, reorderAgentInProject, runtimeUsable, sessionDisplayTitle, sessionSelectionTarget } from './rosterSelectors'
import { conversationMarkdown } from './conversationMarkdown'
import { parseSharedBlob, serializeBlob, type SharedBlob } from './blobShare'
import { ApprovalPill } from './approvalUi'
import { BlobPage, ConfirmDialog } from './BlobPage'
import { DictationButton } from './DictationButton'
import { DictationIsland, type IslandPhase } from './DictationIsland'
import { configureDictation, DEFAULT_SPEECH_MODEL_ID, normalizeEngineChoice, setDictationEnginePrefs, type DictationEngineInfo } from './dictation'
import { UpdateAvailableBanner, useMainUpdateOffer } from './UpdateBanner'
import { UpdateBadge } from './UpdateBadge'
import { SettingsSheet, type SettingsPageId } from './SettingsSheet'
import { ProfileMenu, readProfileName, saveProfileName, syncProfileName } from './ProfileMenu'
import { emptyPins, readPins, toggleFavorite, writePins, type SidebarPins } from './sidebarPins'
import { ProviderLogo, RuntimeMark } from './providerBrand'
import { useClock } from './useClock'
import { useDialogAccessibility, useDialogEntered } from './dialogFocus'
import { initialiseSeen, isUnread, markSeen, unreadNeedsApproval, type SeenSessions } from './sessionSeen'
import { notificationAllowed, notificationForTransition } from './notificationTransitions'
import { flashMainWindow, sendDesktopNotification } from '../desktopIntegrations'
import { currentWindow, currentWebviewWindow, invokeNative, isNative, listenNative } from '../transport/nativeBridge'
import { usePlatform } from '../transport/platform'
import { stampCompanionDragRegions } from './companionDrag'
import { DEFAULT_EXPERIMENTS, EXPERIMENTS, filesUnderReply, waitingBlobCount, type ExperimentName } from './experiments'
import { ChangeReview, MessageSearch, ShortcutSheet, UndoToasts, type MessageSearchResult } from './ExperimentalFeatures'
import { openSafeLink } from './openSafeLink'
import { markWhatsNewSeen, readSeenVersion, releaseNotes, shouldShowWhatsNew, WhatsNewDialog } from './WhatsNew'
import { DiagnosticsDialog } from './DiagnosticsDialog'
import { appVersion } from '../appRelease'
import { ConnectionBanner } from './ConnectionBanner'
import { removeUndoToast, useUndoToasts, useUndoable } from './undo'
import { messageExcerpt, MessageActions, MessageContextMenu, MessageReactionBadges, originalMessageText, ReplyContextStrip, type ReplyTarget } from './MessageActions'
import { Skeleton } from './Skeleton'
import { UsageTip } from './UsageTip'
import { appendUsageTipDismissal, parseUsageTipDismissals, selectUsageTip, type UsageTip as UsageTipModel, type UsageTipDismissal } from './usageTips'
import { setApprovalBadge } from '../tauri'
import { QuickSwitcher } from './QuickSwitcher'
import { useQuickSwitcherShortcut } from './useQuickSwitcherShortcut'
import { LaunchIntro, LaunchWarnings } from './LaunchIntro'
import { discoveryResultText, useRuntimeDiscovery } from './runtimeDiscovery'
import { FirstRunOnboarding } from './FirstRunOnboarding'
import { LAUNCH_OVERALL_TIMEOUT_REASON, LAUNCH_TIMEOUTS, launchWarningsFor, runLaunchChecks, runtimeAuthSummary, throwIfLaunchAborted, type LaunchCheck } from './launchChecks'
import { providerBrand } from './providerBrand'
import { applyAppearance, applySurfaceAppearance, isThemeStyle, normalizeAccent, type TextSizeChoice, type ThemeChoice } from './appearance'
import { hydrateDensity, hydrateHints, hydrateTour, useHintSeen } from './uiPrefs'
import { recordInstructionVersion } from './instructionHistory'
import { SessionExecutionControls } from './SessionExecutionControls'
import { composerMaxHeight, useAutosizeTextarea } from './useAutosize'
import { ContextWindowIndicator } from './ContextWindowIndicator'
import { QuotaBar } from './QuotaBar'
import { planProgress, planSteps } from './planProgress'
import { SidebarUsage } from './SidebarUsage'
import { RemoteChip } from './RemoteChip'
import { TourHost } from './tour/TourHost'
import { ContextualHints } from './tour/ContextualHints'
import { startTour } from './tour/startTour'
import { quotaRows, quotaTone, resetIn, updatedAgo } from './quotaModel'
import { QueueBanner } from './PromptQueue'
import { AttachButton, AttachmentTray, MAX_COMPOSER_ATTACHMENTS, MessageAttachments, PermissionModeControl, prepareImageBytes, sessionApprovalMode, type ComposerAttachment } from './ComposerControls'
import { ConversationOutline, outlineItemsFromMessages } from './ConversationOutline'
import { SlashCommandChip, SlashMenu } from './SlashMenu'
import { COMPANION_SLASH_ACTIONS, commandMessage, leadingCommand, requestExecutionPicker, slashItems, slashQuery, type SlashCommand, type SlashItem, type SlashSkill } from './slashCommands'
import { SafeMarkdown, SafeMarkdownInline } from './SafeMarkdown'
import { parseUnifiedDiff } from './diffParser'
import type { QuickSwitcherItem } from './quickSwitcherModel'
import { entityNoun, useEntityNoun } from './vocabulary'
import { ensureDaemon, fetchSnapshot, getActiveRuntime, getActiveSession, inDesktop, inspectLocalFile, listenForActiveRuntime, listenForActiveSession, listenForDaemonConnection, listenForDaemonEvents, listenForOpenSettings, openInEditor, openProjectFolder, previewMode, quitBloblex, readBlobImport, readClipboardImage, refreshTrayMenu, resolveProjectFile, revealInExplorer, rpc, selectBlobImportPath, selectLocalFile, selectMarkdownExportPath, selectBlobExportPath, setActiveRuntime, setActiveSession, setCompanionMode, setCompanionMonitor, setCompanionVisibility, showMainSettings, showMainWindow, stagePromptAttachment, startDaemonEventStream, writeBlobExport, writeMarkdownExport, currentCompanionMonitor } from '../tauri'

type AppliedModelState = { sessionId: string; model: string | null; hasSnapshot: boolean; loading: boolean }
type MessageMenuTarget = { x: number; y: number; sessionId: string; messageId: string; text: string; latest: boolean; references: NonNullable<ChatMessage['references']>; attachments: Array<{ name: string; path: string }>; replyTo: ReplyTarget | null }

function cachedFont(key: string) { try { return localStorage.getItem(key) ?? '' } catch { return '' } }

export function App() {
  const companion = new URLSearchParams(location.search).has('companion')
  useEffect(() => { void applyFonts(cachedFont('bitbots.font'), cachedFont('bitbots.monoFont'), themeStyle()) }, [])
  const noun = useEntityNoun()
  const nouns = useEntityNoun({ plural: true })
  const Noun = useEntityNoun({ capital: true })
  const platform = usePlatform()
  useEffect(() => {
    document.documentElement.classList.toggle('companion-surface', companion)
    return () => document.documentElement.classList.remove('companion-surface')
  }, [companion])
  useEffect(() => () => { if (companion) disposeCompanionAudio() }, [companion])
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  /** Experimental, off by default: the plan-usage bar along the bottom. */
  const [usageBarEnabled, setUsageBarEnabled] = useState(false)
  const [claudeWorkflowsEnabled, setClaudeWorkflowsEnabled] = useState(true)
  /** Experimental and separate from the bottom usage bar. */
  const [usageTipsEnabled, setUsageTipsEnabled] = useState(false)
  const [usageTipDismissals, setUsageTipDismissals] = useState<UsageTipDismissal[]>([])
  const usageTipDismissalsRef = useRef(usageTipDismissals)
  usageTipDismissalsRef.current = usageTipDismissals
  /** Experimental, off by default: each turn's commands, tools and edits as one expandable line. */
  const [activityDetails, setActivityDetails] = useState(false)
  const [busyMode, setBusyMode] = useState<BusySendMode>('steer')
  const [steerRevision, setSteerRevision] = useState(0)
  const [deliveryNotice, setDeliveryNotice] = useState<string | null>(null)
  /** Companion preferences: chat height and the teammates kept on the island. */
  const [companionChatSize, setCompanionChatSize] = useState<CompanionChatSize>('medium')
  const [companionPinned, setCompanionPinned] = useState<string[]>([])
  /** Speech: dictation can be switched off entirely, and uses the chosen downloaded model. */
  const [speechEnabled, setSpeechEnabled] = useState(true)
  const [speechModel, setSpeechModel] = useState(DEFAULT_SPEECH_MODEL_ID)
  const [windowSettingsLoaded, setWindowSettingsLoaded] = useState(false)
  /** Experimental, off by default: each blob's runtime logo beside its name. */
  const [runtimeLogos, setRuntimeLogos] = useState(false)
  const [experiments, setExperiments] = useState(DEFAULT_EXPERIMENTS)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // What's new opens once by itself when the app has moved to a newer version.
  const [whatsNewOpen, setWhatsNewOpen] = useState(() => !companion && shouldShowWhatsNew(readSeenVersion(), appVersion, releaseNotes()))
  useEffect(() => { if (!companion && (!readSeenVersion() || whatsNewOpen)) markWhatsNewSeen() }, [companion, whatsNewOpen])
  // FIX39 P12: the Export diagnostics dialog, from the Help group.
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [messageSearchOpen, setMessageSearchOpen] = useState(false)
  const [messageMenu, setMessageMenu] = useState<MessageMenuTarget | null>(null)
  const messageMenuAnchor = useRef<HTMLElement | null>(null)
  const [searchTarget, setSearchTarget] = useState<MessageSearchResult | null>(null)
  const [reviewDismissals, setReviewDismissals] = useState<Record<string, string[]>>({})
  const [revertTarget, setRevertTarget] = useState<{ sessionId: string; file: Record<string, unknown> } | null>(null)
  const undoToasts = useUndoToasts()
  const changeExperiment = useCallback((name: ExperimentName, enabled: boolean) => setExperiments((current) => ({ ...current, [name]: enabled })), [])
  useEffect(() => {
    if (!experiments.shortcuts || companion) return
    const keydown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === '/' && !event.altKey && !event.shiftKey) { event.preventDefault(); setShortcutsOpen(true) }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [experiments.shortcuts, companion])
  /** True once the daemon has sent `appearance.style`, retiring the legacy bitbots switch. */
  const styleExplicit = useRef(false)
  const applyWindowSetting = useCallback((key: string, value: unknown) => {
    if (key === BUSY_SEND_SETTING) { setBusyMode(busySendMode(value)); return }
    if (key === 'exec_gate.codex.steer') { setSteerRevision(v => v + 1); return }
    const experiment = EXPERIMENTS.find(({ name }) => key === `experimental.${name}`)
    if (experiment) { changeExperiment(experiment.name, typeof value === 'boolean' ? value : DEFAULT_EXPERIMENTS[experiment.name]); return }
    if (key === 'experimental.usageBar') setUsageBarEnabled(value === true)
    if (key === 'automations.paused') { setSchedulesPaused(value === true); return }
    if (key === 'power.keepAwake') { setKeepAwakeEnabled(value === true); return }
    if (key === 'speech.engine') { setDictationEnginePrefs({ engine: normalizeEngineChoice(value) }); return }
    if (key === 'speech.cloud.consent') { setDictationEnginePrefs({ consent: value === true }); return }
    if (key === 'claude.enableWorkflows') setClaudeWorkflowsEnabled(value !== false)
    else if (key === 'experimental.usageTips') setUsageTipsEnabled(value === true)
    else if (key === 'experimental.usageTipDismissals') {
      const parsed = parseUsageTipDismissals(value)
      usageTipDismissalsRef.current = parsed
      setUsageTipDismissals(parsed)
    }
    else if (key === 'experimental.activityDetails') setActivityDetails(value === true)
    else if (key === 'companion.chatSize') setCompanionChatSize(isCompanionChatSize(value) ? value : 'medium')
    else if (key === 'companion.pinnedBlobs') setCompanionPinned(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, MAX_COMPANION_PEERS) : [])
    else if (key === 'speech.enabled') setSpeechEnabled(value !== false)
    else if (key === 'speech.model') setSpeechModel(typeof value === 'string' && value ? value : DEFAULT_SPEECH_MODEL_ID)
    else if (key === 'experimental.runtimeLogos') setRuntimeLogos(value === true)
    else if (key === 'appearance.style') { if (isThemeStyle(value)) { styleExplicit.current = true; setThemeStyle(value); void applyFonts(cachedFont('bitbots.font'), cachedFont('bitbots.monoFont'), value) } }
    else if (key === 'appearance.accent') setAccentColor(normalizeAccent(value))
    else if (key === 'appearance.wallpaper') { try { localStorage.setItem('bitbots.wallpaper', typeof value === 'string' ? value : 'lake') } catch {} document.documentElement.dataset.wallpaper = typeof value === 'string' ? value : 'lake'; window.dispatchEvent(new Event('bitbots-wallpaper-changed')) }
    else if (key === 'appearance.glass') { try { localStorage.setItem('bitbots.glass', typeof value === 'string' ? value : 'solid') } catch {} document.documentElement.dataset.glass = typeof value === 'string' ? value : 'solid' }
    else if (key === 'appearance.font' || key === 'appearance.monoFont') { try { localStorage.setItem(key === 'appearance.font' ? 'bitbots.font' : 'bitbots.monoFont', typeof value === 'string' ? value : '') } catch {}; void applyFonts(cachedFont('bitbots.font'), cachedFont('bitbots.monoFont'), themeStyle()) }
    else if (key === 'appearance.density') hydrateDensity(value)
    else if (key === 'appearance.theme' || key === 'appearance.textSize') {
      try {
        const saved = JSON.parse(localStorage.getItem('bloblex.appearance') || '{}') as { theme?: ThemeChoice; textSize?: TextSizeChoice }
        if (key === 'appearance.theme') saved.theme = value === 'dark' || value === 'light' ? value : 'system'
        else saved.textSize = ['small','default','large','larger'].includes(String(value)) ? value as TextSizeChoice : 'default'
        localStorage.setItem('bloblex.appearance', JSON.stringify(saved))
        if (!companion) applyAppearance(document.documentElement, saved.theme ?? 'system', saved.textSize ?? 'default')
        else applySurfaceAppearance(document.documentElement, saved.theme ?? 'system', saved.textSize ?? 'default', true)
      } catch { /* Settings remain persisted by the daemon. */ }
    }
    else if (key === 'hints.seen') hydrateHints(value)
    else if (key === 'onboarding.tour') hydrateTour(value)
    // Legacy fallback: only while the daemon has never sent `appearance.style`.
    else if (key === 'experimental.bitbots') { if (!styleExplicit.current && typeof value === 'boolean') setBitbotsEnabled(value) }
  }, [])
  const [analyticsOpen, setAnalyticsOpen] = useState(false)
  const [schedulesOpen, setSchedulesOpen] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [handoffBusy, setHandoffBusy] = useState(false)
  const [handoffError, setHandoffError] = useState<string | null>(null)
  const [schedulesAgentId, setSchedulesAgentId] = useState<string | null>(null)
  const [schedulesPaused, setSchedulesPaused] = useState(false)
  const [keepAwakeEnabled, setKeepAwakeEnabled] = useState(false)
  const [schedulesError, setSchedulesError] = useState<string | null>(null)
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
  const [reconnectAttempts, setReconnectAttempts] = useState(0)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [selectedRuntimeId, setSelectedRuntimeId] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  /** A side conversation between two blobs, opened from a chip; overrides the main conversation. */
  const [sideSessionId, setSideSessionId] = useState<string | null>(null)
  const [textPrompt, setTextPrompt] = useState<{ title: string; label: string; value: string; confirmLabel: string; onSubmit: (value: string) => void | Promise<void> } | null>(null)
  const [projectDelete, setProjectDelete] = useState<Project | null>(null)
  const [mention, setMention] = useState<{ start: number; query: string; index: number } | null>(null)
  /** The `#conversation` being typed, and the side conversations already referenced in the draft. */
  const [hashRef, setHashRef] = useState<{ start: number; query: string; index: number } | null>(null)
  const [conversationRefs, setConversationRefs] = useState<Array<{ id: string; title: string }>>([])
  /** Where "Close chat" returns: the blob and conversation a side conversation was opened from. */
  const sideReturn = useRef<{ agentId: string | null; sessionId: string | null } | null>(null)
  const ensuringConversation = useRef(new Set<string>())
  const [mainAttention, setMainAttention] = useState(() => !companion && document.visibilityState === 'visible' && document.hasFocus())
  const [surfaceFocused, setSurfaceFocused] = useState(() => document.visibilityState === 'visible' && document.hasFocus())
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
  const [composer, setComposer] = useState('')
  /** The `/command` being typed, the command picked for this message and this bot's skills. */
  const [slash, setSlash] = useState<{ start: number; query: string; index: number } | null>(null)
  const [slashCommand, setSlashCommand] = useState<SlashCommand | null>(null)
  const [slashSkills, setSlashSkills] = useState<Array<{ name: string; description: string }>>([])
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null)
  const replyTargetRef = useRef<ReplyTarget | null>(null)
  replyTargetRef.current = replyTarget
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const attachmentsRef = useRef<ComposerAttachment[]>([])
  attachmentsRef.current = attachments
  const [clipboardReadPending, setClipboardReadPending] = useState(false)
  const clipboardReadGeneration = useRef(0)
  const [composerDropActive, setComposerDropActive] = useState(false)
  const [dictationPartial, setDictationPartial] = useState('')
  const composerTypingRef = useRef(false)
  const [appliedModelState, setAppliedModelState] = useState<AppliedModelState | null>(null)
  const appliedModelRequest = useRef(0)
  const [busy, setBusy] = useState(false)
  /** Messages sent but not yet confirmed by the daemon: shown at once as "Sending…" so the composer never waits. */
  const [pendingSends, setPendingSends] = useState<PendingSend[]>([])
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
  const { status: discoveryStatus, scan: scanRuntimes } = useRuntimeDiscovery((runtimes) => setSnapshot((current) => current ? { ...current, runtimes } : current))
  const [discoveryConfirmation, setDiscoveryConfirmation] = useState<string | null>(null)
  const discoveryHadFailure = useRef(false)
  useEffect(() => {
    const sync = () => setSurfaceFocused(document.visibilityState === 'visible' && document.hasFocus())
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    document.addEventListener('visibilitychange', sync)
    return () => { window.removeEventListener('focus', sync); window.removeEventListener('blur', sync); document.removeEventListener('visibilitychange', sync) }
  }, [])
  useEffect(() => {
    if (discoveryStatus.failure) { discoveryHadFailure.current = true; return }
    if (!discoveryStatus.completedAt || !discoveryHadFailure.current) return
    discoveryHadFailure.current = false
    setDiscoveryConfirmation(discoveryResultText(discoveryStatus))
    const timer = window.setTimeout(() => setDiscoveryConfirmation(null), 4_000)
    return () => window.clearTimeout(timer)
  }, [discoveryStatus.completedAt, discoveryStatus.failure])
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
          if (draftDirtyRef.current) setRemoteNotice(`This ${entityNoun(themeStyle())} changed elsewhere. Save will overwrite those fields, or cancel to load the latest.`)
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
  /** The per-bot conversations column; open unless it was closed before. */
  const [convosOpen, setConvosOpen] = useState(() => { try { return localStorage.getItem('bloblex.conversations.open') !== '0' } catch { return true } })
  const setConvosVisible = (open: boolean) => { setConvosOpen(open); try { localStorage.setItem('bloblex.conversations.open', open ? '1' : '0') } catch { /* preference only */ } }
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false)
  const openQuickSwitcher = useCallback(() => setQuickSwitcherOpen(true), [])
  const [pins, setPins] = useState<SidebarPins>(() => companion ? emptyPins() : readPins())
  const updatePins = (change: (current: SidebarPins) => SidebarPins) => setPins((current) => { const next = change(current); writePins(next); return next })
  const composerRef = useRef<HTMLTextAreaElement>(null)
  useAutosizeTextarea(composerRef, composer, composerMaxHeight)
  const messageListRef = useRef<HTMLElement>(null)
  /** The outline only appears once the conversation is long enough to scroll. */
  const [conversationScrollable, setConversationScrollable] = useState(false)
  useEffect(() => {
    const list = messageListRef.current
    if (!list) { setConversationScrollable(false); return }
    // Without layout (clientHeight 0) the size is unknown; keep the outline available.
    const measure = () => setConversationScrollable(list.clientHeight === 0 || list.scrollHeight - list.clientHeight > 24)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    for (const child of Array.from(list.children)) observer.observe(child)
    return () => observer.disconnect()
  })
  const stickToBottom = useRef(true)
  const queuedEvents = useRef<DaemonEvent[]>([])
  const hydrating = useRef(true)
  const appearanceHydrated = useRef(false)
  const refreshingRef = useRef(false)
  const refreshAgain = useRef(false)
  const snapshotRef = useRef<Snapshot | null>(null)
  const pendingSessionHydrations = useRef(new Set<string>())
  /** Background loads that failed; the conversation loads again when it is opened. */
  const failedSessionHydrations = useRef(new Set<string>())
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
  /** Every conversation's blob, kept so a removed id can still be traced to its owner. */
  const sessionOwnersRef = useRef(new Map<string, string | null>())
  /**
   * Conversations the UI just created, until a snapshot confirms them. A refresh
   * can arrive before the daemon's new row is in its list; without this the
   * reconcile effect would read the missing id as a removal and move the
   * selection to another bot.
   */
  const pendingSessionIds = useRef(new Set<string>())
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
    void listenNative<boolean>('bloblex-companion-visible-changed', (payload) => {
      companionVisibilityRevision.current += 1
      setCompanionVisibleState(payload)
    }).then((stop) => {
      if (cancelled) { stop(); return }
      unlisten = stop
      const revisionAtRead = companionVisibilityRevision.current
      void invokeNative<boolean>('companion_visible').then((visible) => {
        if (!cancelled && companionVisibilityRevision.current === revisionAtRead) setCompanionVisibleState(visible)
      }).catch(() => undefined)
    })
    return () => { cancelled = true; unlisten?.() }
  }, [companion])

  useEffect(() => {
    if (connection !== 'connected') return
    let active = true
    void rpc<Record<string, unknown>>('settings.get').then((result) => {
      const values = result.settings && typeof result.settings === 'object' ? result.settings as Record<string, unknown> : result
      if (!active) return
      for (const key of ['appearance.style', 'appearance.accent', 'appearance.density', 'appearance.wallpaper', 'appearance.glass', 'appearance.font', 'appearance.monoFont', 'appearance.theme', 'appearance.textSize', 'hints.seen', 'onboarding.tour', 'claude.enableWorkflows', 'automations.paused', 'power.keepAwake', 'speech.engine', 'speech.cloud.consent', 'experimental.bitbots', 'experimental.usageBar', 'experimental.usageTips', 'experimental.usageTipDismissals', 'experimental.activityDetails', 'experimental.runtimeLogos', ...EXPERIMENTS.map(({ name }) => `experimental.${name}`), 'companion.chatSize', 'companion.pinnedBlobs', 'speech.enabled', 'speech.model', BUSY_SEND_SETTING, 'exec_gate.codex.steer']) applyWindowSetting(key, values[key])
      setWindowSettingsLoaded(true)
    }).catch(() => undefined)
    return () => { active = false }
  }, [connection, applyWindowSetting])
  // The main window owns dictation's shortcut and warm-up; the companion only follows.
  // Coming back to the window re-warms it, because the on-device model is let go
  // after ten idle minutes (warming an already warm engine does nothing).
  useEffect(() => {
    if (companion || !windowSettingsLoaded) return
    void configureDictation(speechEnabled, speechModel)
    const rewarm = () => { void configureDictation(speechEnabled, speechModel) }
    window.addEventListener('focus', rewarm)
    return () => window.removeEventListener('focus', rewarm)
  }, [companion, windowSettingsLoaded, speechEnabled, speechModel])

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
    void listenNative<boolean>('bloblex-notifications-enabled-changed', (payload) => setNotificationsEnabled(payload)).then((stop) => { unlisten = stop })
    return () => { active = false; unlisten?.() }
  }, [companion])

  const runtimes = snapshot?.runtimes ?? []
  const sessions = snapshot?.sessions ?? []
  const agents = snapshot?.agents ?? []
  const projects = snapshot?.projects ?? []
  // Conversations load in the background: the selected bot's newest first, a
  // few at a time, so its list opens ready while the rest follow. Each finished
  // load changes the snapshot, which runs this again for the next ones.
  useEffect(() => {
    if (!snapshot || companion || !inDesktop) return
    const queue = hydrationOrder(sessions, selectedAgentId).filter((session) => !pendingSessionHydrations.current.has(session.id) && !failedSessionHydrations.current.has(session.id))
    for (const session of queue.slice(0, Math.max(0, HYDRATE_AT_ONCE - pendingSessionHydrations.current.size))) {
      pendingSessionHydrations.current.add(session.id)
      void rpc<Session>('session.get', { sessionId: session.id }).then((fullSession) => {
        setSnapshot((current) => current ? mergeHydratedSession(current, session.id, fullSession) : current)
      }).catch(() => {
        failedSessionHydrations.current.add(session.id)
        // Nothing changed in the snapshot, so nudge it to start the next load.
        setSnapshot((current) => current ? { ...current } : current)
      }).finally(() => pendingSessionHydrations.current.delete(session.id))
    }
  }, [snapshot, sessions, companion, selectedAgentId])
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null
  const activeSelectedAgent = selectedAgent && !selectedAgent.archived ? selectedAgent : null
  const selectedRuntime = activeSelectedAgent
    ? runtimes.find((runtime) => runtime.id === activeSelectedAgent.runtimeId) ?? null
    : runtimes.find((runtime) => runtime.id === selectedRuntimeId) ?? runtimes[0] ?? null
  const sideSession = sideSessionId ? sessions.find((session) => session.id === sideSessionId && isSideSession(session)) ?? null : null
  const hasActiveBlobs = activeAgents(agents).length > 0
  // A bot with no conversation opens into a local draft: nothing is stored until
  // the first message, so no daemon session and no row exist before then.
  const draftEligible = !companion && !!activeSelectedAgent && connection === 'connected' && runtimeUsable(selectedRuntime)
  const selectedSession = sideSession ?? (activeSelectedAgent
    ? sessions.find((session) => session.id === selectedSessionId && session.agentId === activeSelectedAgent.id && !isSideSession(session) && !session.archived) ?? mainSessionFor(sessions, activeSelectedAgent.id) ?? (draftEligible ? draftSessionFor(activeSelectedAgent) : null)
    : !hasActiveBlobs && !companion ? null
    : sessions.find((session) => session.id === selectedSessionId && (!selectedRuntime || session.runtimeId === selectedRuntime.id))
      ?? sessions.find((session) => session.id === activeSessionId && (!selectedRuntime || session.runtimeId === selectedRuntime.id))
      ?? sessions.filter((session) => session.runtimeId === selectedRuntime?.id && !isSideSession(session)).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0]
      ?? null)
  const selectedSessionIdRef = useRef<string | null>(selectedSession?.id ?? null)
  selectedSessionIdRef.current = selectedSession?.id ?? null
  detailsSessionIdRef.current = selectedSession?.id ?? null
  // Remember every conversation's blob, so a removed id can still be traced to its owner.
  for (const session of sessions) sessionOwnersRef.current.set(session.id, session.agentId ?? null)
  const sessionMessages = selectedSession?.messages ?? selectedSession?.turns?.flatMap((turn) => Array.isArray(turn.messages) ? turn.messages : []) ?? selectedSession?.events ?? []
  const conversationItems = selectedSession ? buildConversationItems(selectedSession) : []
  const waitingCount = waitingBlobCount(snapshot, permissionClock)
  useEffect(() => {
    if (companion || !inDesktop) return
    void setApprovalBadge(experiments.approvalBadge ? waitingCount : 0).catch(() => undefined)
  }, [experiments.approvalBadge, waitingCount, companion])
  useEffect(() => {
    if (!searchTarget || selectedSession?.id !== searchTarget.sessionId) return
    const anchor = `conversation-message-${encodeURIComponent('message:' + searchTarget.messageId)}`
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(anchor)
      if (element) {
        element.scrollIntoView?.({ block: 'center' })
        element.setAttribute('tabindex', '-1')
        element.focus({ preventScroll: true })
        stickToBottom.current = false
        setSearchTarget(null)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [searchTarget, selectedSession?.id, selectedSession?.messages])
  const dismissReviewFile = (sessionId: string, id: string) => setReviewDismissals((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), id] }))
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
    // Keep the read marker when a conversation merely leaves the list (archived, or
    // deleted while Undo is pending): dropping it made a restored conversation pop
    // an unread dot the person never earned. Only permanent deletions are forgotten.
    const deleted = snapshot?.deletedSessionIds ?? []
    if (!deleted.length) return
    setSeenSessions((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => !deleted.includes(id)))
      if (Object.keys(next).length !== Object.keys(current).length) return next
      return current
    })
  }, [snapshot?.deletedSessionIds])

  // A conversation that comes back (Undo, or an archive reverted elsewhere) was already
  // read: restoring it must not pop an unread dot for a timestamp it only gained while away.
  const knownSessionIds = useRef(new Set<string>())
  useEffect(() => {
    if (!seenLoaded.current) return
    const previousIds = knownSessionIds.current
    const appeared = sessions.filter((session) => !previousIds.has(session.id))
    knownSessionIds.current = new Set(sessions.map((session) => session.id))
    if (!appeared.length) return
    setSeenSessions((current) => {
      let next = current
      for (const session of appeared) {
        if (current[session.id] === undefined) continue
        next = markSeen(next, session.id, session.updatedAt ?? new Date().toISOString())
      }
      return next
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
      if (!notificationAllowed(agent?.notificationLevel, notification.state)) continue
      const name = agent?.name ?? labelize(session.provider, entityNoun(themeStyle(), { capital: true }))
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
  // Without the experimental activity setting only failed turns stay visible; the working indicator shows progress.
  const groupedConversationItems = groupConversationActivity(activityDetails || sideSession ? conversationItems : conversationItems.filter((item) => item.kind === 'message' || item.activityKind === 'turn'))
  // A side conversation only shows its own requests, never the leader's.
  const activePermission = sideSessionId
    ? selectPendingPermission((snapshot?.permissions ?? []).filter((permission) => permission.sessionId === sideSessionId), sideSessionId, sideSessionId, permissionClock)
    // Questions wait in their own conversation (the sidebar shows "Waiting for you");
    // only approvals pull focus across blobs.
    : selectPendingPermission((snapshot?.permissions ?? []).filter((permission) => permission.kind !== 'question' || permission.sessionId === selectedSession?.id), selectedSession?.id, activeSessionId, permissionClock)
  const sideAgent = sideSession ? agents.find((agent) => agent.id === sideSession.agentId) ?? null : null
  const sidePeer = sideSession ? agents.find((agent) => agent.id === sideSession.link?.peerAgentId) ?? null : null
  // FIX39 item 18: a delegated conversation whose delivery is queued behind the
  // global limit says so, instead of looking like the bot's empty first-run screen.
  const waitingDelegation = isWaitingDelegation(sessionMessages)
  const steerAvailable = useSteerAvailable(steerRuntimeId(selectedSession?.state, selectedSession?.runtimeId), connection === 'connected', `${selectedSession?.state}:${steerRevision}`)
  useEffect(() => { setDeliveryNotice(null) }, [selectedSession?.id, selectedSession?.state])
  const agentName = sideSession ? sideAgent?.name ?? 'Teammate' : activeSelectedAgent?.name ?? (selectedRuntime ? labelize(selectedRuntime.provider) : 'No runtime selected')
  const outlineItems = outlineItemsFromMessages(
    groupedConversationItems.filter((item): item is ConversationItem & { kind: 'message' } => item.kind === 'message'),
    agentName,
  )
  const accent = sideAgent ? agentColorHex(sideAgent.color) : activeSelectedAgent ? agentColorHex(activeSelectedAgent.color) : ''
  // The companion's approval queue: every live approval across bots, with the ones the person set aside hidden for a while.
  const [companionPick, setCompanionPick] = useState<string | null>(null)
  const [snoozedPermissions, setSnoozedPermissions] = useState<Record<string, number>>({})
  const [, bumpSnooze] = useState(0)
  useEffect(() => {
    const until = Object.values(snoozedPermissions).filter((value) => value > Date.now())
    if (!until.length) return
    const timer = window.setTimeout(() => bumpSnooze((value) => value + 1), Math.max(250, Math.min(...until) - Date.now() + 50))
    return () => window.clearTimeout(timer)
  }, [snoozedPermissions])
  const isSnoozed = (id: string) => (snoozedPermissions[id] ?? 0) > Date.now()
  const companionQueue = (snapshot?.permissions ?? []).filter((item) => item.kind !== 'question' && isPendingPermissionLive(item, permissionClock) && !isSnoozed(item.id))
  const snoozeCompanionPermission = (id: string) => {
    setSnoozedPermissions((current) => ({ ...current, [id]: Date.now() + 5 * 60_000 }))
    setCompanionPick((current) => (current === id ? null : current))
  }
  const companionPermission = companionQueue.find((item) => item.id === companionPick)
    ?? (activePermission && !isSnoozed(activePermission.id) ? activePermission : companionQueue[0] ?? undefined)
  const companionSessionRecord = sessions.find((session) => session.id === companionPermission?.sessionId)
    ?? selectedSession
  const companionSession = companionSessionRecord
  const companionAgent = agents.find((agent) => agent.id === companionSession?.agentId && !agent.archived) ?? activeSelectedAgent
  const companionRuntime = runtimes.find((runtime) => runtime.id === companionAgent?.runtimeId) ?? runtimes.find((runtime) => runtime.id === companionSession?.runtimeId) ?? selectedRuntime
  const companionSteerAvailable = useSteerAvailable(companion ? steerRuntimeId(companionSession?.state, companionSession?.runtimeId) : undefined, companion && connection === 'connected', `${companionSession?.state}:${steerRevision}`)
  const companionStatus = deriveCompanionStatus({ connected: connection === 'connected', runtime: companionRuntime, session: companionSession, permissionPending: !!companionPermission, now })
  const previousCueMood = useRef<string | null>(null)
  // The skills the composer offers: the pool's switch-on set for whoever the
  // composer is talking to (the selected bot, or the companion's bot).
  useEffect(() => {
    const agentId = companion ? companionAgent?.id : activeSelectedAgent?.id
    if (!agentId || connection !== 'connected') { setSlashSkills([]); return }
    let active = true
    void rpc<{ skills?: Array<{ name: string; description: string }> }>('skills.forAgent', { agentId })
      .then((result) => { if (active) setSlashSkills(result.skills ?? []) })
      .catch(() => { if (active) setSlashSkills([]) })
    return () => { active = false }
  }, [companion, companionAgent?.id, activeSelectedAgent?.id, connection])
  const previousPermissionCue = useRef<string | null>(null)
  // The bot's project name; a folder name only for a real project folder, never Bitbots' own per-bot workspace.
  const currentProjectName = conversationPlaceName(selectedSession, agents, projects)
  const headerAgent = selectedSession
    ? (selectedSession.agentId ? agents.find((agent) => agent.id === selectedSession.agentId) ?? null : null)
    : activeSelectedAgent
  const headerMode = selectedSession ? sessionApprovalMode(selectedSession, headerAgent).mode : effectiveApprovalMode(headerAgent)
  const companionMode = effectiveApprovalMode(companionAgent)

  useEffect(() => {
    const sessionId = isDraftSession(selectedSession) ? null : selectedSession?.id
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
      setSnapshot((current) => carryQueues(queued.reduce((state, event) => applyEvent(state, event), next), current))
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
      await runSteps([{ id: 'service', label: 'Connecting to the Bitbots service', timeoutMs: LAUNCH_TIMEOUTS.service, run: async (stageSignal) => {
        await ensureDaemon()
        throwIfLaunchAborted(stageSignal)
        const next = await fetchSnapshot()
        throwIfLaunchAborted(stageSignal)
        setSnapshot((current) => carryQueues(next, current))
        setConnection('connected')
        return 'Connected and loaded the latest state'
      } }])
      if (checks.find((check) => check.id === 'service')?.state === 'failed') { setLaunchServiceDown(true); return }
      if (signal.aborted || generation !== launchGeneration.current) return
      let found: Runtime[] = []
      await runSteps([{ id: 'discovery', label: 'Finding coding agents', timeoutMs: LAUNCH_TIMEOUTS.discovery, run: async (stageSignal) => {
        found = await scanRuntimes()
        throwIfLaunchAborted(stageSignal)
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
        // Through the shared catalog cache, so the composer and editor pickers open from it.
        const result = await fetchCached<Record<string, unknown>>('runtime.models', { runtimeId: runtime.id })
        void fetchCached('runtime.capabilities', { runtimeId: runtime.id }).catch(() => undefined)
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

  // A new approval pulls focus to its conversation once. After that the user may
  // look at other bots while it waits; the sidebar and tray still flag it.
  const focusedPermission = useRef<string | null>(null)
  useEffect(() => {
    if (!activePermission?.sessionId) return
    if (focusedPermission.current === activePermission.id) return
    const target = sessions.find((item) => item.id === activePermission.sessionId)
    if (!target || target.archived) return
    const ownerAgent = target.agentId ? (snapshot?.agents ?? []).find((agent) => agent.id === target.agentId) : undefined
    // An archived blob's conversation never pulls focus; its approval stays in the sidebar.
    if (target.agentId && ownerAgent?.archived) return
    const owner = ownerAgent && !ownerAgent.archived ? ownerAgent : undefined
    // Focus has arrived once the approval's conversation is the one on screen.
    if (target.id === selectedSessionId && target.id === activeSessionId && (!owner || owner.id === selectedAgentId)) { focusedPermission.current = activePermission.id; return }
    if (owner && owner.id !== selectedAgentId) setSelectedAgentId(owner.id)
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
      // A runtime's model list changed (or the runtime itself did): refresh the shared catalog cache.
      if ((event.type === 'runtime.models.changed' || event.type === 'runtime.changed') && event.payload && typeof event.payload === 'object') {
        const runtimeId = (event.payload as { runtimeId?: unknown; id?: unknown }).runtimeId ?? (event.payload as { id?: unknown }).id
        if (typeof runtimeId === 'string') {
          invalidateCatalog(runtimeId)
          void fetchCached('runtime.models', { runtimeId }, { force: true }).catch(() => undefined)
        }
      }
      if (event.type === 'settings.changed' && event.payload && typeof event.payload === 'object') {
        const payload = event.payload as Record<string, unknown>
        if (typeof payload.key === 'string' && 'value' in payload) applyWindowSetting(payload.key, payload.value)
      }
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
  }, [hydrateAgentChanges, refreshAppliedModelFromEvent, applyWindowSetting])

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
    void listenNative<string>('bloblex-tray-notice', (payload) => setError(payload)).then((stop) => { if (cancelled) stop(); else unlistenNotice = stop })
    void listenNative('bloblex-pause-all-requested', () => {
      if (!window.confirm('Pause all agents? Bitbots will send a cancellation request for every active session. A cancelled turn may not be resumable. Scheduled runs are paused too until you turn them back on in Schedules.')) return
      void (async () => {
        try {
          await rpc('settings.set', { key: 'automations.paused', value: true }).then(() => setSchedulesPaused(true)).catch(() => undefined)
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
    if (connection === 'connected') { setReconnectAttempts((current) => current === 0 ? current : 0); return }
    if (!inDesktop) return
    const timer = window.setInterval(() => {
      setReconnectAttempts((current) => current + 1)
      if (!refreshing) void refresh()
    }, 3000)
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
      if (root.dataset.themeChoice === 'system') {
        if (companion) root.dataset.surfaceTheme = media.matches ? 'light' : 'dark'
        else applyAppearance(root, 'system', (root.dataset.textSize as TextSizeChoice) || 'default')
      }
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
    void listenForOpenSettings((page) => { if (page) setSettingsInitialPage(page); setSettingsSheet(true) }).then((stop) => { if (cancelled) stop(); else unlisten = stop })
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
      if (!sessionId) { setActiveSessionId(null); setSideSessionId(null); setSelectedSessionId(null); return }
      const session = snapshotRef.current?.sessions?.find((item) => item.id === sessionId)
      // A deleted or archived conversation must never be adopted: the id can arrive
      // from the companion or the tray after this window has already moved on, and
      // selecting it starts the two windows bouncing between each other.
      if (!session || session.archived) return
      // Side conversations are a main-window view. The companion ignores them
      // entirely: if it adopted one, it would announce it back as active after
      // the main window closed it, and the side chat would reopen at once.
      if (companion && isSideSession(session)) return
      // A side conversation opens over the current blob; it never switches the
      // selection to the teammate who owns it, so "Close chat" can return.
      if (isSideSession(session)) {
        setActiveSessionId(sessionId)
        setSideSessionId((current) => {
          if (current !== session.id && !current) sideReturn.current = { agentId: selectedAgentIdRef.current, sessionId: null }
          return session.id
        })
        return
      }
      if (session.agentId) {
        const owner = (snapshotRef.current?.agents ?? []).find((agent) => agent.id === session.agentId && !agent.archived)
        // The blob was archived while its conversation id was in flight: ignore it.
        if (!owner) return
        setActiveSessionId(sessionId)
        // Any other conversation becoming active (from the companion or the tray) closes a side view.
        setSideSessionId(null)
        sideReturn.current = null
        setSelectedAgentId(owner.id)
        setSelectedRuntimeId(owner.runtimeId)
        setSelectedSessionId(session.id)
        return
      }
      setActiveSessionId(sessionId)
      setSideSessionId(null)
      sideReturn.current = null
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
    // A local draft is not a stored conversation: the shared active session is
    // left alone, so opening a bot with no conversation cannot round-trip through
    // the companion and pull the selection elsewhere.
    if (isDraftSession(selectedSession)) return
    if (!activeSelectedAgent && selectedSession && selectedSession.runtimeId !== selectedRuntimeId) setSelectedRuntimeId(selectedSession.runtimeId)
    if (selectedSession && selectedSession.id !== activeSessionId) {
      const owner = selectedSession.agentId ? agents.find((agent) => agent.id === selectedSession.agentId) : undefined
      // Never announce a conversation that no longer exists or whose blob was archived.
      if (selectedSession.archived || (selectedSession.agentId && (!owner || owner.archived))) return
      setActiveSessionId(selectedSession.id)
      void setActiveSession(selectedSession.id)
    } else if (!selectedSession && selectedSessionId === null && activeSessionId !== null) {
      setActiveSessionId(null)
      void setActiveSession(null)
    }
  }, [activeSelectedAgent, selectedSession, selectedRuntimeId, activeSessionId, selectedSessionId, agents])

  // A conversation left without a single message is not kept: leaving it
  // removes it, so the list only holds conversations that happened.
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const pendingSendsRef = useRef(pendingSends)
  pendingSendsRef.current = pendingSends
  const lastOpenId = useRef<string | null>(null)
  useEffect(() => {
    const previous = lastOpenId.current
    lastOpenId.current = selectedSession?.id ?? null
    if (!previous || previous === selectedSession?.id || companion) return
    const left = sessionsRef.current.find((session) => session.id === previous)
    if (!left || !isEmptyConversation(left) || pendingSendsRef.current.some((item) => item.sessionId === previous)) return
    if ((snapshot?.queues?.[previous]?.items ?? []).length > 0) return
    void rpc('session.delete.schedule', { sessionId: previous }).then(() => {
      setSnapshot((current) => current ? { ...current, sessions: (current.sessions ?? []).filter((session) => session.id !== previous) } : current)
    }).catch(() => undefined)
  }, [selectedSession?.id, companion])

  // Start the open conversation's coding agent a moment after it is shown, so the
  // first message does not wait for it. The daemon refuses side, archived and
  // busy conversations and keeps at most two warmed, so this is cheap to ask.
  const warmSessionId = !companion && connection === 'connected' && selectedSession && !sideSession && !selectedSession.archived && !isEmptyConversation(selectedSession) ? selectedSession.id : null
  useEffect(() => {
    if (!warmSessionId) return
    const timer = window.setTimeout(() => { void rpc('session.warm', { sessionId: warmSessionId }).catch(() => undefined) }, 400)
    return () => window.clearTimeout(timer)
  }, [warmSessionId])

  // When the selected conversation disappears (deleted, or archived elsewhere),
  // choose the next one exactly once: the same blob's next conversation, else the
  // next visible blob's. Every other effect must leave that choice alone.
  useEffect(() => {
    if (!snapshot || !selectionBooted.current || !selectedSessionId) return
    if (sessions.some((session) => session.id === selectedSessionId)) { pendingSessionIds.current.delete(selectedSessionId); return }
    // A conversation this window just created may not be in a snapshot yet: wait
    // for it rather than reading the missing id as a removal. A delete is final,
    // so it falls through to the reconcile below.
    if (pendingSessionIds.current.has(selectedSessionId) && !(snapshot.deletedSessionIds ?? []).includes(selectedSessionId)) return
    pendingSessionIds.current.delete(selectedSessionId)
    const ownerId = sessionOwnersRef.current.get(selectedSessionId) ?? null
    const next = nextSelectionAfterRemoval(sessions, agents, ownerId)
    if (!next) { setSelectedSessionId(null); return }
    const owner = agents.find((agent) => agent.id === next.agentId)
    if (owner) setSelectedRuntimeId(owner.runtimeId)
    setSelectedAgentId(next.agentId)
    setSelectedSessionId(next.sessionId)
  }, [snapshot, sessions, agents, selectedSessionId])

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
    const linkPreviewSession = previewMode && new URLSearchParams(location.search).get('preset') === 'message-links'
      ? (snapshot.sessions ?? []).find((session) => session.id === 'session-codex')
      : undefined
    const storedSession = (snapshot.sessions ?? []).find((session) => session.id === activeSessionIdRef.current)
    const storedOk = !!storedSession && (storedSession.agentId === agent.id || ((storedSession.agentId == null) && storedSession.runtimeId === agent.runtimeId))
    const nextSession = linkPreviewSession ?? (storedOk ? storedSession : agentSessions(snapshot.sessions ?? [], agent.id)[0])
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
          const name = current?.name || prior.find((agent) => agent.id === selectedAgentId)?.name || entityNoun(themeStyle(), { capital: true })
          const next = nextAgentAfterArchive(prior, selectedAgentId)
          const nextSession = next ? agentSessions(snapshot?.sessions ?? [], next.id)[0] ?? null : null
          setRosterAnnouncement(next ? `Archived ${name}. Now showing ${next.name}.` : `Archived ${name}. No ${entityNoun(themeStyle(), { plural: true })} left.`)
          setSelectedAgentId(next?.id ?? null)
          setSelectedSessionId(nextSession?.id ?? null)
          if (next) setSelectedRuntimeId(next.runtimeId)
          focusTimer = window.setTimeout(() => {
            const node = next
              ? document.querySelector<HTMLElement>(`[data-agent-id="${CSS.escape(next.id)}"]`)
              : document.querySelector<HTMLElement>('[data-testid="create-blob"]')
            node?.focus()
          }, 0)
          if (blobPage && blobPage.agentId === selectedAgentId) {
            setArchiveNotice(`Archived “${name}”. Its conversations stay saved. Restoring a ${entityNoun(themeStyle())} is not available yet.`)
            setBlobPage(null)
          }
        }
      }
    }
    if (editorId && editorId !== selectedAgentId) {
      const editor = list.find((agent) => agent.id === editorId)
      if (editor?.archived) {
        setArchiveNotice(`Archived “${editor.name}”. Its conversations stay saved. Restoring a ${entityNoun(themeStyle())} is not available yet.`)
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
  const restoreCreateFocus = () => window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-testid="create-blob"]')?.focus())

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
    if (!runtime) { setError(`The coding agent for this ${entityNoun(themeStyle())} is not available.`); return }
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
    if (previewMode && !companion && new URLSearchParams(location.search).has('preview-usage')) setAnalyticsOpen(true)
  }, [companion])
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
      ;(row ?? document.querySelector<HTMLButtonElement>('[data-testid="create-blob"]'))?.focus()
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
    if (blobPage?.mode === 'create' && !draft.model) { setFormError('Choose a concrete model available in this coding agent catalog.'); return }
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
        if (draft.instructions !== baseline.instructions) recordInstructionVersion(agent.id, draft.instructions)
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
      if (draft.instructions !== baseline.instructions) recordInstructionVersion(agent.id, draft.instructions)
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
      if (experiments.undo) await archiveBlob(agent)
      else await deleteAgent(agent)
    } catch (reason) {
      setError(messageForDaemonCode(daemonCodeOf(reason), 'agent.delete'))
    }
  }

  /** One conversation per blob: "new" opens it, or asks before starting fresh. */
  /**
   * A new conversation with the bot, next to the existing ones (nothing is
   * archived). Its coding agent starts with the first message, and it is
   * removed again if it is left with nothing said. An empty open conversation
   * is reused instead of adding another.
   */
  const newSession = (agentId?: string, _anchor?: HTMLElement | null) => {
    const agent = agents.find((item) => item.id === (agentId ?? activeSelectedAgent?.id) && !item.archived)
    const runtime = agent ? runtimes.find((item) => item.id === agent.runtimeId) : null
    if (!agent || connection !== 'connected' || !runtimeUsable(runtime)) return
    const current = agent.id === activeSelectedAgent?.id ? selectedSession : mainSessionFor(sessions, agent.id)
    if (current && !isSideSession(current) && (current.messages ?? []).length === 0 && current.agentId === agent.id) { selectAgent(agent); return }
    void createConversation(agent)
  }
  const createConversation = async (agent: Agent, options: { quiet?: boolean } = {}): Promise<Session | null> => {
    if (ensuringConversation.current.has(agent.id)) return null
    ensuringConversation.current.add(agent.id)
    try {
      const result = await rpc<{ session?: Session }>('agent.conversation.create', { agentId: agent.id })
      if (!result.session?.id) return null
      // A new conversation has nothing in it yet; saying so lets the empty rules apply at once.
      upsertSession({ ...result.session, messages: result.session.messages ?? [] })
      pendingSessionIds.current.add(result.session.id)
      setSideSessionId(null)
      setSelectedAgentId(agent.id)
      setSelectedSessionId(result.session.id)
      void setActiveSession(result.session.id)
      if (!options.quiet) setRosterAnnouncement(`Started a new conversation with ${agent.name}.`)
      requestAnimationFrame(() => composerRef.current?.focus())
      return result.session
    } catch (reason) { if (!options.quiet) setError(messageOf(reason)); return null }
    finally { ensuringConversation.current.delete(agent.id) }
  }
  const renameConversation = async (session: Session, title: string) => {
    try { await rpc('session.rename', { sessionId: session.id, title }); await refresh() } catch (reason) { setError(messageOf(reason)) }
  }
  const selectConversation = (session: Session) => {
    setSideSessionId(null)
    setSelectedSessionId(session.id)
    void setActiveSession(session.id)
  }

  const archiveConversation = async (session: Session) => {
    try {
      const result = await rpc<{ session?: Session }>('session.archive', { sessionId: session.id, archived: true })
      const saved = result.session
      setSnapshot((current) => current ? { ...current, sessions: (current.sessions ?? []).map((item) => item.id === session.id ? { ...item, ...(saved ?? {}), archived: true } : item) } : current)
      // The reconcile effect moves the selection once, from the now-archived id.
    } catch (reason) { setError(messageOf(reason)) }
  }

  // The pill flips at once; the daemon's answer replaces it, and a failure puts it back.
  const setPlanMode = async (enabled: boolean) => {
    if (!selectedSession) return
    const before = selectedSession
    const optimistic: Session = { ...before, modelLock: { ...(before.modelLock ?? {}), planMode: enabled } }
    setSnapshot((current) => current ? mergeHydratedSession(current, before.id, optimistic) : current)
    try {
      const result = await rpc<{ session?: Session }>('session.model.update', { sessionId: before.id, planMode: enabled })
      if (result.session?.id) setSnapshot((current) => current ? mergeHydratedSession(current, result.session!.id, result.session!) : current)
    } catch (reason) {
      setSnapshot((current) => current ? mergeHydratedSession(current, before.id, before) : current)
      setError(messageOf(reason))
    }
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
  const pickConversation = (session: Session) => {
    if (!hashRef) return
    const title = sideTitle(session, agents)
    const caret = composerRef.current?.selectionStart ?? composer.length
    setComposer(`${composer.slice(0, hashRef.start)}#${title} ${composer.slice(caret)}`)
    setConversationRefs((current) => [...current.filter((ref) => ref.id !== session.id), { id: session.id, title }])
    setHashRef(null)
    requestAnimationFrame(() => { const node = composerRef.current; if (!node) return; const position = hashRef.start + title.length + 2; node.focus(); node.setSelectionRange(position, position) })
  }
  const pickMention = (agent: Agent) => {
    if (!mention) return
    const caret = composerRef.current?.selectionStart ?? composer.length
    const next = `${composer.slice(0, mention.start)}@${agent.name} ${composer.slice(caret)}`
    setComposer(next)
    setMention(null)
    requestAnimationFrame(() => { const node = composerRef.current; if (!node) return; const position = mention.start + agent.name.length + 2; node.focus(); node.setSelectionRange(position, position) })
  }
  /** Runs an action chosen from the `/` menu. These never send a message. */
  const runSlashAction = (action: SlashItem['action']) => {
    if (!action) return
    if (action === 'plan') void setPlanMode(!planOn)
    else if (action === 'new') newSession()
    else if (action === 'model' || action === 'effort') requestExecutionPicker(action)
    else if (action === 'rename' && selectedSession) setTextPrompt({ title: 'Rename conversation', label: 'Conversation name', value: selectedSession.title?.trim() ?? '', confirmLabel: 'Rename', onSubmit: (title: string) => renameConversation(selectedSession, title) })
    else if (action === 'export' && selectedSession) void exportConversation(false)
  }
  /** Picks a `/` menu row: actions run at once; a skill or Manager command attaches to the message. */
  const pickSlash = (item: SlashItem) => {
    const caret = composerRef.current?.selectionStart ?? composer.length
    const token = slash
    const withoutToken = token ? `${composer.slice(0, token.start)}${composer.slice(Math.min(caret, token.start + 1 + token.query.length))}` : composer
    setSlash(null)
    if (item.kind === 'action') {
      setComposer(withoutToken)
      // `/help` keeps the menu open as a list of every command.
      if (item.action === 'help') { setSlash({ start: withoutToken.length, query: '', index: 0 }); return }
      runSlashAction(item.action)
      requestAnimationFrame(() => composerRef.current?.focus())
      return
    }
    setSlashCommand({ kind: item.kind, name: item.name })
    setComposer(withoutToken)
    requestAnimationFrame(() => composerRef.current?.focus())
  }
  const renderText = (text: string) => <SafeMessageText text={text} />
  /** Team messages render as chips and cards instead of chat bubbles. */
  const teamItem = (message: Record<string, unknown>, key: string) => {
    const meta = (message.meta && typeof message.meta === 'object' ? message.meta : null) as { kind?: string; direction?: string; peerAgentId?: string; peerName?: string; fromAgentId?: string; fromName?: string; sideSessionId?: string; topic?: string } | null
    const role = String(message.role ?? '')
    const text = typeof message.content === 'string' ? message.content : ''
    if (role === 'notice' && meta?.kind === 'delegation') {
      const peerId = meta.peerAgentId
      return <DelegationChip key={key} peer={agents.find((agent) => agent.id === peerId)} name={meta.peerName ?? 'Teammate'} topic={typeof meta.topic === 'string' ? meta.topic : undefined} failed={meta.direction === 'failed'} detail={meta.direction === 'failed' ? text : undefined} text={text} onOpenConversation={meta.sideSessionId ? () => openSideConversation(meta.sideSessionId) : peerId ? () => openBlobConversation(peerId) : undefined} />
    }
    if (role === 'user' && meta?.kind === 'blob_reply') {
      const fromId = meta.fromAgentId
      return <ReplyChip key={key} from={agents.find((agent) => agent.id === fromId)} name={meta.fromName ?? 'Teammate'} text={text} onOpenConversation={meta.sideSessionId ? () => openSideConversation(meta.sideSessionId) : fromId ? () => openBlobConversation(fromId) : undefined} />
    }
    if (role === 'notice' && meta?.kind === 'blob_created') {
      const createdId = (message.meta as { agentId?: unknown }).agentId
      const created = typeof createdId === 'string' ? agents.find((agent) => agent.id === createdId) : undefined
      const name = created?.name ?? (typeof (message.meta as { name?: unknown }).name === 'string' ? String((message.meta as { name?: unknown }).name) : 'Teammate')
      const detail = [created?.role?.trim(), created?.projectId ? projects.find((project) => project.id === created.projectId)?.name : null].filter(Boolean).join(' · ')
      return <CreatedBotChip key={key} agent={created} name={name} detail={detail || undefined} onOpen={created && !created.archived ? () => openBlobConversation(created.id) : undefined} />
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
      const planStepList = planSteps(text)
      const planIndex = (selectedSession?.messages ?? []).findIndex((item) => item.id === message.id)
      const laterAssistant = planIndex < 0 ? [] : (selectedSession?.messages ?? []).slice(planIndex + 1).filter((item) => item.role === 'assistant').map((item) => String(item.content ?? ''))
      return <PlanCard key={key} steps={planStepList} progress={planProgress(planStepList, laterAssistant)} text={text} renderText={renderText} canApprove={!sideSession && planOn && !sessionBusy && message.id === latestPlanId} onApprove={() => void approvePlan()} onRevise={() => composerRef.current?.focus()} />
    }
    if (role === 'notice' && meta?.kind === 'auto_retry') {
      const retryMeta = message.meta as { status?: unknown; itemId?: unknown }
      const pending = typeof retryMeta.itemId === 'string' && !!promptQueue?.items.some((entry) => entry.kind === 'retry' && entry.id === retryMeta.itemId)
      return <AutoRetryNotice key={key} id={`conversation-message-${encodeURIComponent(key)}`} text={text} status={String(retryMeta.status ?? '')} onCancel={pending ? cancelAutoRetry : undefined} />
    }
    if (role === 'user' && meta?.kind === 'auto_retry') {
      return <div key={key} className="team-chip-row"><span className="team-notice"><RotateCw size={11} aria-hidden="true" />Continuing automatically</span></div>
    }
    if (role === 'notice' && meta?.kind === 'context_reset') {
      return <ContextResetDivider key={key} id={`conversation-message-${encodeURIComponent(key)}`} text={text} lost={(message.meta as { contextLost?: unknown }).contextLost === true} />
    }
    if (role === 'notice') {
      return <div key={key} className="team-chip-row"><span className="team-notice">{text}</span></div>
    }
    return null
  }

  const stageMessageReply = (message: Record<string, unknown>) => {
    if (!selectedSession || sideSession) return
    const messageId = typeof message.id === 'string' ? message.id : ''
    const text = originalMessageText(message.content ?? message.text)
    if (!messageId || !text.trim()) { setError('This message has no text to quote.'); return }
    const author = message.role === 'user' ? 'You' : agentName
    const target: ReplyTarget = { sourceSessionId: selectedSession.id, messageId, author, excerpt: messageExcerpt(text) }
    replyTargetRef.current = target
    setReplyTarget(target)
    requestAnimationFrame(() => composerRef.current?.focus())
  }

  const openUserMessageMenu = (event: ReactMouseEvent<HTMLElement>, message: Record<string, unknown>) => {
    if (!experiments.messageActions || sideSession || message.role !== 'user' || !selectedSession || typeof message.id !== 'string') return
    const text = originalMessageText(message.content ?? message.text)
    if (!text) return
    event.preventDefault()
    const meta = message.meta && typeof message.meta === 'object' ? message.meta as Record<string, unknown> : {}
    const rawReply = meta.replyTo && typeof meta.replyTo === 'object' ? meta.replyTo as Record<string, unknown> : null
    const replyTo = rawReply && typeof rawReply.sourceSessionId === 'string' && typeof rawReply.messageId === 'string' && typeof rawReply.author === 'string' && typeof rawReply.excerpt === 'string'
      ? { sourceSessionId: rawReply.sourceSessionId, messageId: rawReply.messageId, author: rawReply.author, excerpt: rawReply.excerpt }
      : null
    const references = Array.isArray(message.references) ? message.references.filter((item): item is { id: string; title: string } => !!item && typeof item === 'object' && typeof item.id === 'string' && typeof item.title === 'string') : []
    const attachments = Array.isArray(message.attachments) ? message.attachments.filter((item): item is { name: string; path: string } => !!item && typeof item === 'object' && typeof item.name === 'string' && typeof item.path === 'string') : []
    messageMenuAnchor.current = event.currentTarget
    setMessageMenu({
      x: event.clientX,
      y: event.clientY,
      sessionId: selectedSession.id,
      messageId: message.id,
      text,
      latest: sessionMessages.filter((item) => item.role === 'user').at(-1)?.id === message.id,
      references,
      attachments,
      replyTo,
    })
  }

  const closeMessageMenu = (restoreFocus = false) => {
    const anchor = messageMenuAnchor.current
    messageMenuAnchor.current = null
    setMessageMenu(null)
    if (restoreFocus) requestAnimationFrame(() => anchor?.isConnected && anchor.focus({ preventScroll: true }))
  }

  /**
   * Sends without holding the composer: the draft clears at once and the
   * message shows as "Sending…" until the daemon confirms it. If the daemon
   * refuses, the draft comes back (unless you already typed something new) and
   * the reason shows inline. A second message while one is still on its way
   * goes to the queue, like a message sent during a turn.
   */
  const sendPrompt = async (dueAt?: string, opposite = false) => {
    const text = composer.trim()
    const ready = attachments.filter((item) => item.status === 'ready' && item.path)
    // A picked or hand-typed leading `/command` travels as a `command` with the
    // message stored exactly as typed.
    const sentCommand = slashCommand ?? leadingCommand(text, { skills: slashSkills, isManager: activeSelectedAgent?.systemRole === 'manager' })
    const outbound = sentCommand && slashCommand ? commandMessage(sentCommand, text) : text
    if ((!outbound && ready.length === 0) || clipboardReadPending || attachments.some((item) => item.status === 'staging') || !selectedSession || !runtimeUsable(selectedRuntime)) return
    // The first message of a locally drafted conversation is what creates it: the
    // daemon stores the row then (and titles it from this text).
    let target = selectedSession
    if (isDraftSession(target)) {
      const agent = activeSelectedAgent
      const created = agent ? await createConversation(agent, { quiet: true }) : null
      if (!created) { setError('Could not start the conversation. Try again.'); return }
      target = created
    }
    const sessionId = target.id
    // Only plain messages can steer. Scheduled messages and pending sends keep
    // their durable ordering, and richer messages keep their context in Queue.
    const delivery = busyDelivery(busyMode, opposite, target.state, steerAvailable, !!(ready.length || sentCommand || conversationRefs.length || replyTarget))
    const live = ['working', 'starting', 'waiting_permission', 'cancelling'].includes(target.state ?? '')
    const method = dueAt || pendingSends.some((item) => item.sessionId === sessionId) ? 'session.queue.add'
      : live ? delivery.mode === 'steer' ? 'session.steer' : 'session.queue.add' : 'session.prompt'
    const queueIt = method === 'session.queue.add'
    setDeliveryNotice(live && queueIt ? delivery.reason : null)
    const sentReplyTarget = replyTarget
    const sentRefs = conversationRefs
    const sentChip = slashCommand
    const sentAttachmentIds = new Set(ready.map((item) => item.id))
    const refs = sentRefs.filter((ref) => outbound.includes(`#${ref.title}`)).map((ref) => ref.id)
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setComposer('')
    setSlash(null)
    setSlashCommand(null)
    setConversationRefs([])
    setReplyTarget(null)
    setAttachments((current) => current.filter((item) => !sentAttachmentIds.has(item.id)))
    if (method === 'session.prompt') setPendingSends((current) => [...current, { id: pendingId, sessionId, text: outbound, attachments: ready.length, at: Date.now() }])
    setError(null)
    try {
      const sent = await sendWithDelivery(method, { sessionId, text: outbound, ...(sentCommand ? { command: { kind: sentCommand.kind, name: sentCommand.name } } : {}), ...(dueAt ? { dueAt } : {}), ...(ready.length ? { attachments: ready.map((item) => ({ path: item.path, name: item.name })) } : {}), ...(refs.length ? { conversationRefs: refs } : {}), ...(sentReplyTarget ? { replyTo: { sourceSessionId: sentReplyTarget.sourceSessionId, messageId: sentReplyTarget.messageId } } : {}) })
      for (const item of ready) URL.revokeObjectURL(item.previewUrl)
      if (sent.fallback) setDeliveryNotice('Queued because this turn could not accept steering. It sends after the turn ends.')
      if (sent.queued) void loadQueue(sessionId)
      await refresh()
    } catch (reason) {
      setError(messageOf(reason))
      // Put the draft back where it was, unless something new has been typed since.
      if (!composerRef.current?.value.trim()) {
        setComposer(text)
        setSlashCommand(sentChip)
        setConversationRefs(sentRefs)
        setReplyTarget(sentReplyTarget)
        setAttachments((current) => [...ready, ...current.filter((item) => !sentAttachmentIds.has(item.id))])
      } else for (const item of ready) URL.revokeObjectURL(item.previewUrl)
    } finally {
      setPendingSends((current) => current.filter((item) => item.id !== pendingId))
    }
  }

  const clearAttachments = (only?: ReadonlySet<string>) => {
    const removed = only ? attachmentsRef.current.filter((item) => only.has(item.id)) : attachmentsRef.current
    for (const item of removed) URL.revokeObjectURL(item.previewUrl)
    setAttachments((current) => only ? current.filter((item) => !only.has(item.id)) : [])
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
  const handleComposerPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    if (!imagesSupported) return
    const directFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
    const itemFiles = Array.from(event.clipboardData.items ?? [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    const files = directFiles.length ? directFiles : itemFiles
    if (files.length) {
      event.preventDefault()
      addAttachments(files)
      return
    }
    // Text pastes belong to the textarea. WebViews often report screenshot
    // pastes as an empty event, so read the image from the native clipboard.
    if (event.clipboardData.getData?.('text/plain')) return
    event.preventDefault()
    const generation = ++clipboardReadGeneration.current
    const sessionId = selectedSessionIdRef.current
    setClipboardReadPending(true)
    void readClipboardImage()
      .then((bytes) => {
        if (generation !== clipboardReadGeneration.current || selectedSessionIdRef.current !== sessionId) return
        const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        addAttachments([new File([bytes], `Pasted image ${stamp}.png`, { type: 'image/png' })])
      })
      .catch((reason) => {
        if (generation !== clipboardReadGeneration.current || selectedSessionIdRef.current !== sessionId) return
        const message = messageOf(reason)
        if (message !== 'The clipboard does not contain a readable image.') setError(message)
      })
      .finally(() => {
        if (generation === clipboardReadGeneration.current) setClipboardReadPending(false)
      })
  }
  useEffect(() => {
    clipboardReadGeneration.current += 1
    setClipboardReadPending(false)
    clearAttachments()
    replyTargetRef.current = null
    setReplyTarget(null)
    messageMenuAnchor.current = null
    setMessageMenu(null)
    setSlash(null)
    setSlashCommand(null)
  }, [selectedSession?.id])

  const cancelTurn = async (session: Session | null = selectedSession) => {
    if (!session) return
    try { await doRpc('session.cancel', { sessionId: session.id }); void refreshTrayMenu().catch(() => undefined); await refresh() } catch { /* inline */ }
  }

  /** Queued prompts for the open conversation; the daemon pushes `queue.changed`, this loads the first view and heals gaps. */
  const loadQueue = useCallback(async (sessionId: string) => {
    try {
      const result = await rpc<unknown>('session.queue.list', { sessionId })
      const state = normalizeQueueState(result)
      setSnapshot((current) => current ? { ...current, queues: { ...current.queues, [sessionId]: state } } : current)
    } catch { /* The queue is optional chrome; the conversation keeps working without it. */ }
  }, [])
  useEffect(() => { if (selectedSession?.id && !isDraftSession(selectedSession) && connection === 'connected') void loadQueue(selectedSession.id) }, [selectedSession?.id, connection, loadQueue])
  const queueRpc = async (method: string, params: Record<string, unknown>) => {
    if (!selectedSession) return
    try { await doRpc(method, { sessionId: selectedSession.id, ...params }) } catch { /* inline */ }
    void loadQueue(selectedSession.id)
  }
  const sendQueuedNow = (id: string) => void queueRpc('session.queue.send_now', { id })
  const deleteQueued = (id: string) => void queueRpc('session.queue.delete', { id })
  const updateQueued = (id: string, text: string) => void queueRpc('session.queue.update', { id, text })
  const reorderQueued = (ids: string[]) => void queueRpc('session.queue.reorder', { ids })
  const resumeQueue = () => void queueRpc('session.queue.resume', {})
  const cancelAutoRetry = () => void queueRpc('turn.retry.cancel', {})

  /** Schedules (automations): the daemon owns the timer; these calls only edit definitions and read runs. */
  const loadAutomations = useCallback(async () => {
    try {
      const result = await rpc<{ automations?: unknown[] }>('automation.list', {})
      const list = (Array.isArray(result.automations) ? result.automations : []).filter(isAutomation)
      setSnapshot((current) => current ? { ...current, automations: list } : current)
      setSchedulesError(null)
    } catch (reason) { setSchedulesError(messageOf(reason)) }
  }, [])
  useEffect(() => { if (schedulesOpen && connection === 'connected') void loadAutomations() }, [schedulesOpen, connection, loadAutomations])
  const [schedulesNowMs, setSchedulesNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!schedulesOpen) return
    setSchedulesNowMs(Date.now())
    const timer = window.setInterval(() => setSchedulesNowMs(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [schedulesOpen])
  const automationPayload = (input: AutomationInput) => ({ agentId: input.agentId, name: input.name, prompt: input.prompt, schedule: input.schedule, sessionMode: input.sessionMode, approvalMode: input.approvalMode, maxRuntimeSecs: input.maxRuntimeSecs, ...(input.enabled === undefined ? {} : { enabled: input.enabled }) })
  const createAutomation = async (input: AutomationInput) => { await rpc('automation.create', automationPayload(input)); await loadAutomations() }
  const updateAutomation = async (id: string, input: AutomationInput) => { await rpc('automation.update', { id, ...automationPayload(input) }); await loadAutomations() }
  const setAutomationEnabled = async (id: string, enabled: boolean) => { await rpc(enabled ? 'automation.resume' : 'automation.pause', { id }); await loadAutomations() }
  const runAutomationNow = async (id: string) => { await rpc('automation.run_now', { id }); await loadAutomations() }
  const deleteAutomation = async (id: string) => { await rpc('automation.delete', { id }); await loadAutomations() }
  const loadAutomationRuns = async (id: string): Promise<AutomationRun[]> => {
    const result = await rpc<{ runs?: AutomationRun[] }>('automation.runs', { id, limit: 20 })
    return Array.isArray(result.runs) ? result.runs : []
  }
  const previewAutomation = async (schedule: DaemonSchedule): Promise<string[]> => {
    const result = await rpc<{ occurrences?: Array<string | { local?: string; at?: string }> }>('automation.preview', { schedule, count: 3 })
    const zone = schedule.kind === 'cron' ? schedule.timezone : undefined
    const show = (iso: string) => {
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return iso
      try { return at.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(zone ? { timeZone: zone } : {}) }) } catch { return at.toLocaleString() }
    }
    return (result.occurrences ?? []).map((entry) => typeof entry === 'string' ? entry : entry.at ?? entry.local ?? '').filter(Boolean).map(show)
  }
  const setAutomationsPaused = async (paused: boolean) => {
    await rpc('settings.set', { key: 'automations.paused', value: paused })
    setSchedulesPaused(paused)
  }
  const openAutomationSession = (sessionId: string) => {
    const target = sessions.find((item) => item.id === sessionId)
    if (!target) { setError('This conversation is no longer available.'); return }
    setSchedulesOpen(false); setBlobPage(null); setAnalyticsOpen(false); setSideSessionId(null)
    selectSession(target)
  }

  // Keep-awake: only while the user opted in and a blob is working, a scheduled run is going, or one is about to start.
  const [powerNowMs, setPowerNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!keepAwakeEnabled || companion) return
    const timer = window.setInterval(() => setPowerNowMs(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [keepAwakeEnabled, companion])
  useEffect(() => { if (keepAwakeEnabled && !companion && connection === 'connected') void loadAutomations() }, [keepAwakeEnabled, companion, connection, loadAutomations])
  const keepAwakeWanted = keepAwakeEnabled && !companion && (
    sessions.some((item) => ['working', 'starting', 'waiting_permission'].includes(item.state ?? ''))
    || (snapshot?.automations ?? []).some((item) => item.running === true || (item.enabled && !!item.nextRunAt && Date.parse(item.nextRunAt) - powerNowMs < 15 * 60_000 && Date.parse(item.nextRunAt) - powerNowMs > -60_000))
  )
  useEffect(() => {
    if (!inDesktop || companion) return
    void invokeNative('set_keep_awake', { enabled: keepAwakeWanted }).catch(() => undefined)
  }, [keepAwakeWanted, companion])
  useEffect(() => () => { if (inDesktop) void invokeNative('set_keep_awake', { enabled: false }).catch(() => undefined) }, [])


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
    try { await scanRuntimes() } catch { /* Scan status carries the safe error. */ }
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

  const usageTip = windowSettingsLoaded && usageTipsEnabled && surfaceFocused
    ? selectUsageTip(companion ? companionRuntime?.provider : selectedRuntime?.provider, snapshot?.quotas ?? [], usageTipDismissals, now)
    : null

  const dismissUsageTip = (tip: UsageTipModel) => {
    const previous = usageTipDismissalsRef.current
    const next = appendUsageTipDismissal(previous, tip.dismissal)
    usageTipDismissalsRef.current = next
    setUsageTipDismissals(next)
    void rpc('settings.set', { key: 'experimental.usageTipDismissals', value: next }).catch((reason) => {
      usageTipDismissalsRef.current = previous
      setUsageTipDismissals(previous)
      setError(messageOf(reason))
    })
  }

  const toggleMessageReaction = async (sessionId: string, messageId: string, emoji: string) => {
    await rpc('message.reaction.toggle', { sessionId, messageId, emoji })
  }

  const jumpToMessage = (sourceSessionId: string, messageId: string) => {
    if (sourceSessionId !== selectedSession?.id) { setError('This reply points to a message in another conversation.'); return }
    const target = document.getElementById(`conversation-message-${encodeURIComponent(`message:${messageId}`)}`)
    if (!target) { setError('The original message is not visible in this conversation.'); return }
    target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' })
    target.focus({ preventScroll: true })
  }

  const selectAgent = (agent: Agent) => {
    const main = mainSessionFor(sessions, agent.id)
    setSideSessionId(null)
    setAnalyticsOpen(false)
    setSchedulesOpen(false)
    setSelectedAgentId(agent.id)
    setSelectedRuntimeId(agent.runtimeId)
    setSelectedSessionId(main?.id ?? null)
    void setActiveRuntime(agent.runtimeId)
    // A bot with no conversation is not announced as the active session: there is
    // none to announce yet. Its local draft is shown instead, and the conversation
    // is created (and announced) with the first message.
    if (main) void setActiveSession(main.id)
    setBlobPage((page) => page && page.agentId !== agent.id ? null : page)
  }
  /** Jump to a blob and its latest conversation; the delegation chips link here. */
  const openBlobConversation = (agentId: string) => {
    const agent = agents.find((item) => item.id === agentId && !item.archived)
    if (agent) selectAgent(agent)
  }
  const upsertSession = (session: Session) => setSnapshot((current) => {
    if (!current) return current
    const exists = (current.sessions ?? []).some((item) => item.id === session.id)
    return exists ? mergeHydratedSession(current, session.id, session) : { ...current, sessions: [session, ...(current.sessions ?? [])] }
  })
  const openSideConversation = (sessionId: string | undefined | null) => {
    if (!sessionId) return
    if (!sideSessionId) sideReturn.current = { agentId: activeSelectedAgent?.id ?? null, sessionId: selectedSession?.id ?? null }
    const session = sessions.find((item) => item.id === sessionId)
    if (!session) { void refresh().then(() => setSideSessionId(sessionId)); return }
    setSideSessionId(sessionId)
  }
  /** Back to the conversation the side conversation was opened from. */
  const closeSideConversation = () => {
    const back = sideReturn.current
    sideReturn.current = null
    setSideSessionId(null)
    if (back?.agentId && agents.some((agent) => agent.id === back.agentId && !agent.archived)) {
      setSelectedAgentId(back.agentId)
      if (back.sessionId) setSelectedSessionId(back.sessionId)
    }
  }
  /** Persists a new roster order for the blob's runtime (the daemon needs every active id). */
  const reorderRoster = async (agent: Agent, agentIds: string[]) => {
    try {
      const result = await doRpc<{ agents?: Agent[] }>('agent.reorder', { runtimeId: agent.runtimeId, agentIds }, (reason) => messageForDaemonCode(daemonCodeOf(reason), 'agent.reorder'))
      for (const updated of result.agents ?? []) mergeAgent(updated)
    } catch { /* inline */ }
  }
  const reorderAgent = (agent: Agent, direction: -1 | 1) => {
    const order = reorderAgentInProject(agents, agent.id, direction)
    if (!order) return
    setRosterAnnouncement(`Moved ${agent.name} ${direction === -1 ? 'up' : 'down'}.`)
    void reorderRoster(agent, order)
  }
  const placeAgent = async (agent: Agent, target: Agent, edge: 'before' | 'after') => {
    setRosterAnnouncement(`Moved ${agent.name} next to ${target.name}.`)
    if ((agent.projectId ?? null) !== (target.projectId ?? null)) await teamUpdate(agent, { projectId: target.projectId ?? null })
    const order = placeAgentOrder(agents, agent.id, target.id, edge)
    if (order) await reorderRoster(agent, order)
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

  // --- Uniform undo -----------------------------------------------------------------
  const deleteAgent = async (agent: Agent) => {
    const result = await doRpc<{ agent?: Agent }>('agent.delete', { agentId: agent.id }, (reason) => messageForDaemonCode(daemonCodeOf(reason), 'agent.delete'))
    if (result.agent?.id) mergeAgent(result.agent)
    else mergeAgent({ ...agent, archived: true })
  }
  const restoreAgent = async (agent: Agent) => { const result = await rpc<{ agent: Agent }>('agent.restore', { agentId: agent.id }); mergeAgent(result.agent); await refresh() }
  const archiveBlob = useUndoable<[Agent]>(deleteAgent, restoreAgent, (agent) => `Archived '${agent.name}'.`)

  const renameAgent = async (agent: Agent, name: string) => {
    const result = await doRpc<{ agent?: Agent }>('agent.update', { agentId: agent.id, name }, (reason) => messageForDaemonCode(daemonCodeOf(reason), 'agent.update', { sentName: true }))
    if (result.agent?.id) mergeAgent(result.agent)
  }
  const renameBlob = useUndoable<[Agent, string, string]>(
    async (agent, name) => { await renameAgent(agent, name) },
    async (agent, _name, previous) => { await renameAgent(agent, previous) },
    (agent, name) => `Renamed '${agent.name}' to '${name}'.`,
  )

  const moveAgent = async (agent: Agent, projectId: string | null) => { await teamUpdate(agent, { projectId }) }
  const projectLabel = (projectId: string | null) => projectId ? (projects.find((project) => project.id === projectId)?.name ?? 'the project') : 'Unassigned'
  const moveBlob = useUndoable<[Agent, string | null, string | null]>(
    async (agent, projectId) => { await moveAgent(agent, projectId) },
    async (agent, _projectId, previous) => { await moveAgent(agent, previous) },
    (agent, projectId) => `Moved '${agent.name}' to ${projectLabel(projectId)}.`,
  )

  const deleteProject = async (project: Project) => { await projectAction('project.delete', { projectId: project.id }) }
  const restoreProject = async (project: Project, memberIds: string[]) => {
    const created = await projectAction('project.create', { name: project.name, path: project.path ?? null })
    if (created?.id) {
      for (const id of memberIds) await rpc('agent.team.update', { agentId: id, projectId: created.id }).catch(() => undefined)
      await refresh()
    }
  }
  const removeProject = useUndoable<[Project, string[]]>(
    async (project) => { await deleteProject(project) },
    async (project, memberIds) => { await restoreProject(project, memberIds) },
    (project) => `Deleted project '${project.name}'.`,
  )

  const scheduleConversationDelete = async (session: Session) => {
    await rpc<{ deadline: number }>('session.delete.schedule', { sessionId: session.id })
    // The selection is not moved here: once the conversation leaves the snapshot the
    // reconcile effect chooses the next one once, deterministically.
    await refresh()
  }
  const cancelConversationDelete = async (session: Session) => { await rpc('session.delete.cancel', { sessionId: session.id }); await refresh() }
  const deleteConversation = useUndoable<[Session]>(
    scheduleConversationDelete,
    cancelConversationDelete,
    (session) => `Deleted '${session.title?.trim() || 'Conversation'}'.`,
  )
  const reconnectFailed = connection !== 'connected' && reconnectAttempts >= 3 && error !== null
  const retryConnection = () => { setReconnectAttempts(0); void refresh() }
  const createProject = async () => {
    const path = await openProjectFolder()
    if (!path) return
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? 'Project'
    const project = await projectAction('project.create', { name, path })
    if (project) setRosterAnnouncement(`Created project ${project.name}.`)
    return project
  }
  /** Opens the Manager's conversation with a starter message to edit and send; false without a Manager. */
  const planWithManager = (text: string) => {
    const manager = managerOf(agents)
    if (!manager) return false
    selectAgent(manager)
    setComposer(text)
    window.setTimeout(() => composerRef.current?.focus(), 0)
    return true
  }
  const startProjectWithManager = () => {
    setCreateMenuOpen(false)
    if (!planWithManager('I want to start a new project. Ask me about it, then propose the project and a team.')) void createProject()
  }
  const importProjectWithManager = async () => {
    setCreateMenuOpen(false)
    if (!managerOf(agents)) { void createProject(); return }
    const path = await openProjectFolder()
    if (!path) return
    planWithManager(`I want to bring in the existing project at ${path}. Look through it, ask me what you need, then propose the project and a team.`)
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
      <Companion deliveryNotice={deliveryNotice} busyMode={busyMode} steerAvailable={companionSteerAvailable} onToggleReaction={(sessionId, messageId, emoji) => toggleMessageReaction(sessionId, messageId, emoji)} permissionQueue={companionQueue} onPickPermission={setCompanionPick} onSnoozePermission={snoozeCompanionPermission} agent={companionAgent} agents={agents} projects={snapshot?.projects ?? []} sessions={sessions} quotas={snapshot?.quotas ?? []} onSessionUpdated={(updated) => setSnapshot((current) => current ? mergeHydratedSession(current, updated.id, updated) : current)} onError={(reason) => setError(messageOf(reason))} chatSize={companionChatSize} pinned={companionPinned} activityDetails={activityDetails} speechEnabled={speechEnabled} speechModel={speechModel} usageTip={usageTip} onDismissUsageTip={dismissUsageTip} onChatSizeChange={(size) => { setCompanionChatSize(size); void rpc('settings.set', { key: 'companion.chatSize', value: size }).catch(() => undefined) }} onPinnedChange={(ids) => { setCompanionPinned(ids); void rpc('settings.set', { key: 'companion.pinnedBlobs', value: ids }).catch(() => undefined) }} onAnswerQuestion={answerQuestion} onOpenSession={(sessionId) => void showMainWindow(sessionId)} runtime={companionRuntime} runtimes={runtimes} session={companionSession} usage={snapshot?.usageSummary} connected={connection === 'connected'} appError={error} reconnectAttempts={reconnectAttempts} reconnectFailed={reconnectFailed} onRetryConnection={retryConnection} activityLabel={companionStatus.label} permission={companionPermission} approvalMode={companionMode} onReply={answerPermission} onNewSession={(anchor) => newSession(companionAgent?.id, anchor)} onOpenMain={() => void showMainWindow(companionSession?.id)} onOpenSettings={(page) => void showMainSettings(companionSession?.id, page)} onSendPrompt={(sessionId, text, command, opposite = false, hasContext = false) => {
        const state = sessions.find((item) => item.id === sessionId)?.state
        const live = ['working', 'starting', 'waiting_permission', 'cancelling'].includes(state ?? '')
        const delivery = busyDelivery(busyMode, opposite, state, companionSteerAvailable, hasContext || !!command)
        const method = live ? delivery.mode === 'steer' ? 'session.steer' : 'session.queue.add' : 'session.prompt'
        return sendWithDelivery(method, { sessionId, text, ...(command ? { command: { kind: command.kind, name: command.name } } : {}) }).then(({ queued, fallback }) => { setDeliveryNotice(fallback ? 'Queued because this turn could not accept steering.' : live ? delivery.reason : null); if (queued) void loadQueue(sessionId); void refreshTrayMenu().catch(() => undefined); return refresh() })
      }} queuedCount={companionSession ? snapshot?.queues?.[companionSession.id]?.items.length ?? 0 : 0} onLoadQueue={(sessionId) => void loadQueue(sessionId)} onCancelTurn={(sessionId) => doRpc('session.cancel', { sessionId }).then(() => { void refreshTrayMenu().catch(() => undefined); return refresh() })} onSelectAgent={selectAgent} onSelectConversation={(chosen) => { setSideSessionId(null); setSelectedAgentId(String(chosen.agentId ?? '')); setSelectedSessionId(chosen.id); void setActiveSession(chosen.id) }} slashSkills={slashSkills} />
    </>
  }

  const selectedMood = deriveCompanionStatus({ connected: connection === 'connected', runtime: selectedRuntime, session: selectedSession, composing: !!composer.trim(), now }).mood
  const sessionBusy = ['working', 'starting', 'waiting_permission'].includes(selectedSession?.state ?? '')
  const turnLive = ['working', 'waiting_permission'].includes(selectedSession?.state ?? '')
  const composerDelivery = busyDelivery(busyMode, false, selectedSession?.state, steerAvailable, !!(attachments.length || slashCommand || leadingCommand(composer, { skills: slashSkills, isManager: activeSelectedAgent?.systemRole === 'manager' }) || conversationRefs.length || replyTarget))
  const promptQueue = selectedSession ? snapshot?.queues?.[selectedSession.id] : undefined
  const hasScheduledPrompt = !!promptQueue?.items.some((item) => item.kind === 'send_later')
  const [queueNowMs, setQueueNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!hasScheduledPrompt) return
    setQueueNowMs(Date.now())
    const timer = window.setInterval(() => setQueueNowMs(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [hasScheduledPrompt])
  const imagesSupported = ['claude', 'codex'].includes(String(selectedRuntime?.provider ?? '').toLowerCase())
  const sessionQuota = (snapshot?.quotas ?? []).find((item) => String(item.provider) === String(selectedRuntime?.provider ?? '').toLowerCase()) ?? null
  const selectedModelLock = selectedSession?.modelLock
  const contextModel = selectedModelLock && Object.prototype.hasOwnProperty.call(selectedModelLock, 'model')
    ? selectedModelLock.model ?? null
    : activeSelectedAgent?.model ?? null
  const runtimeReady = runtimeUsable(selectedRuntime)
  const approvalFocusOnMount = !composerTypingRef.current || connection !== 'connected' || busy || selectedSession?.state === 'waiting_permission' || !runtimeReady
  const canStartSession = connection === 'connected' && !busy && !!activeSelectedAgent && runtimeReady && !sideSession
  const visiblePendingSends = selectedSession && !sideSession ? pendingSends.filter((item) => item.sessionId === selectedSession.id && !(selectedSession.messages ?? []).some((message) => message.role === 'user' && originalMessageText(message.content ?? message.text).trim() === item.text && Date.parse(String(message.createdAt ?? '')) >= item.at - 5000)) : []
  const conversationEmpty = !selectedSession || (selectedSession.messages ?? []).length === 0
  const lastAgentIndex = conversationItems.reduce((last, item, index) => item.kind === 'message' && !isUserMessage(item.value) ? index : last, -1)
  // The details panel describes the open conversation, so it steps aside for the blob editor and Analytics.
  const detailsVisible = inspectorOpen && !blobPage && !analyticsOpen && !tasksOpen
  const toggleInspector = () => setInspectorOpen((open) => { localStorage.setItem('bloblex.inspector.open', open ? '0' : '1'); return !open })
  const editingAgent = blobPage?.mode === 'edit' ? agents.find((agent) => agent.id === blobPage.agentId) ?? null : null
  const otherNames = activeAgents(agents).filter((agent) => agent.id !== editingAgent?.id).map((agent) => agent.name)
  const fieldErrors = draft ? validateAgentDraft(draft, otherNames) : {}
  const draftReady = Object.keys(fieldErrors).length === 0
  const draftDirty = !!(draft && baseline && isAgentDirty(draft, baseline))
  const draftRuntime = draft ? runtimes.find((runtime) => runtime.id === draft.runtimeId) ?? null : selectedRuntime
  const pageSessions = editingAgent ? agentSessions(sessions, editingAgent.id) : []
  const pageLegacy = legacySessions(sessions, (editingAgent ?? activeSelectedAgent)?.runtimeId ?? draft?.runtimeId ?? '')
  const planOn = selectedSession?.modelLock?.planMode === true
  const latestPlanId = [...(selectedSession?.messages ?? [])].reverse().find((message) => message.role === 'plan')?.id ?? null
  const lastTurnWasPlan = planOn && !sessionBusy && (selectedSession?.messages ?? []).some((message) => message.role === 'assistant' || message.role === 'plan')
  const mentionCandidates = mention ? mentionMatches(agents.filter((agent) => agent.id !== activeSelectedAgent?.id && !agent.hidden), mention.query) : []
  const blobSideSessions = activeSelectedAgent ? sideSessionsFor(sessions, activeSelectedAgent.id) : []
  const hashCandidates = hashRef ? conversationMatches(blobSideSessions, agents, hashRef.query) : []
  const slashCandidates = slash ? slashItems(slash.query, { skills: slashSkills, isManager: activeSelectedAgent?.systemRole === 'manager' }) : []
  const visibleSessions = sessions.filter((session) => session.archived !== true)
  const quickSwitcherItems: QuickSwitcherItem[] = [
    ...activeAgents(agents).map((agent) => ({ id: agent.id, kind: 'blob' as const, title: agent.name, subtitle: [agent.role?.trim(), agent.description].filter(Boolean).join(' · '), searchText: `${agent.name} ${agent.role ?? ''} ${agent.description}`, color: agentColorHex(agent.color) })),
    ...visibleSessions.map((session) => {
      const owner = agents.find((agent) => agent.id === session.agentId)
      const title = sessionDisplayTitle(session)
      const place = conversationPlaceName(session, agents, projects)
      const subtitle = [owner?.name ?? labelize(session.provider, Noun), place].filter(Boolean).join(' · ')
      return { id: session.id, kind: 'conversation' as const, title, subtitle, searchText: `${title} ${subtitle} ${session.projectPath ?? ''}`, recentAt: session.updatedAt ?? session.createdAt ?? null }
    }),
    ...activeAgents(agents).flatMap((agent) => projectGroups(visibleSessions, agent.id).filter((project) => project.key !== null).map((project) => ({ id: `${agent.id}:${project.key}`, kind: 'project' as const, title: project.label, subtitle: agent.name, searchText: `${project.label} ${agent.name} ${project.path}` }))),
    ...(activeSelectedAgent ? [{ id: 'new-session', kind: 'action' as const, category: 'Create' as const, icon: 'new-conversation' as const, title: 'New conversation', subtitle: `With ${activeSelectedAgent.name}`, searchText: `New conversation session chat ${activeSelectedAgent.name}` }] : []),
    { id: 'new-blob', kind: 'action', category: 'Create', icon: 'new-bot', title: `New ${noun}`, subtitle: '', searchText: `New ${noun} create` },
    ...(experiments.search ? [{ id: 'search-messages', kind: 'action' as const, category: 'Go to' as const, icon: 'search' as const, title: 'Search messages', subtitle: 'Across all conversations', searchText: 'Search messages text history' }] : []),
    { id: 'usage', kind: 'action', category: 'Go to', icon: 'usage', title: 'Usage', subtitle: 'Plan limits and tokens', searchText: 'Usage limits quota tokens' },
    { id: 'remote-devices', kind: 'action', category: 'Go to', icon: 'remote', title: 'Remote devices', subtitle: 'Reach your bots from a phone', searchText: 'Remote devices phone tablet browser pair mobile settings' },
    { id: 'settings', kind: 'action', category: 'Settings', icon: 'settings', title: 'Settings', subtitle: '', searchText: 'Settings preferences' },
    { id: 'change-look', kind: 'action', category: 'Settings', icon: 'look', title: 'Change look', subtitle: 'Bitbots, Blobots and more looks, wallpaper, fonts', searchText: 'Change look appearance theme style bitbots blobots accent legacy pop dot frost wallpaper glass font colour' },
    { id: 'find-agents', kind: 'action', category: 'Settings', icon: 'agents', title: 'Find coding agents', subtitle: 'Scan for Claude Code, Codex and OpenCode', searchText: 'Find coding agents runtime scan claude codex opencode' },
    { id: 'toggle-details', kind: 'action', category: 'Settings', icon: 'details', title: 'Toggle details panel', subtitle: '', searchText: 'Toggle details panel inspector rail' },
    { id: 'whats-new', kind: 'action', category: 'Help', icon: 'whats-new', title: 'What’s new', subtitle: 'Release notes', searchText: 'What is new changelog release notes version' },
    { id: 'export-diagnostics', kind: 'action', category: 'Help', icon: 'details', title: 'Export diagnostics', subtitle: 'Logs, versions and settings', searchText: 'Export diagnostics logs support report problem bug' },
    { id: 'take-tour', kind: 'action', category: 'Help', icon: 'tour', title: 'Take the tour', subtitle: 'Six quick stops', searchText: 'Take the tour guide onboarding help' },
    { id: 'shortcuts', kind: 'action', category: 'Help', icon: 'shortcuts', title: 'Keyboard shortcuts', subtitle: '', hint: 'Ctrl+/', searchText: 'Keyboard shortcuts keys hotkeys' },
  ]
  const chooseQuickSwitcherItem = (item: QuickSwitcherItem) => {
    if (item.id === 'whats-new') { setWhatsNewOpen(true); return }
    if (item.id === 'search-messages' && experiments.search) { setMessageSearchOpen(true); return }
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
      else if (item.id === 'find-agents') { setSettingsInitialPage('Agents'); setSettingsFocus(null); setSettingsSheet(true); void refreshRuntimes() }
      else if (item.id === 'toggle-details') toggleInspector()
      else if (item.id === 'change-look') { setSettingsInitialPage('Appearance'); setSettingsFocus(null); setSettingsSheet(true) }
      else if (item.id === 'remote-devices') { setSettingsInitialPage('Remote'); setSettingsFocus(null); setSettingsSheet(true) }
      else if (item.id === 'take-tour') startTour()
      else if (item.id === 'shortcuts') setShortcutsOpen(true)
      else if (item.id === 'export-diagnostics') { setQuickSwitcherOpen(false); setDiagnosticsOpen(true) }
    }
  }
  const launchWarnings = launchWarningsFor(launchChecks.filter((check) => check.id !== 'discovery'), runtimes)
  if (discoveryStatus.failure && !discoveryStatus.retrying) launchWarnings.push(discoveryStatus.failure.step + ': ' + discoveryStatus.failure.message)
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
  /** The onboarding's first bot: its look, colour, name, role, description and verified model. */
  /** Onboarding and the upgrade card both set up the Manager (or return the one that exists). */
  const createOnboardedBlob = async (onboardingDraft: AgentDraft) => {
    const draft: AgentDraft = onboardingDraft
    try {
      // Onboarding only offers models from a verified catalog, so the chosen model is sent.
      const params = createParams(draft, { model: true, thinking: false, serviceTier: false })
      const result = await doRpc<{ manager?: Agent }>('manager.ensure', params, (reason) => messageForDaemonCode(daemonCodeOf(reason), 'agent.create'))
      const agent = result.manager
      if (!agent?.id) return null
      mergeAgent(agent)
      setSelectedAgentId(agent.id)
      setSelectedRuntimeId(agent.runtimeId)
      setSelectedSessionId(null)
      return agent
    } catch (reason) { setError(messageForDaemonCode(daemonCodeOf(reason), 'agent.create')); return null }
  }
  if (launchVisible && !companion) return <LaunchIntro checks={launchChecks} runtimes={runtimes} agent={activeSelectedAgent} serviceDown={launchServiceDown} onRetry={retryLaunch} onContinueOffline={() => { setConnection('disconnected'); finishLaunch() }} onComplete={finishLaunch} />
  if (onboardingVisible && !companion) return <FirstRunOnboarding runtimes={runtimes} scanning={discoveryStatus.scanning} error={error} onScan={() => void refreshRuntimes()} onCreate={createOnboardedBlob} onFinish={finishOnboarding} onSaveName={saveProfileName} />
  return (
    <>
    {!companion && <AppWallpaper />}
    <main className={`app-shell ${detailsVisible ? 'inspector-open' : ''} ${convosOpen && activeSelectedAgent && !schedulesOpen && !tasksOpen ? 'convos-open' : ''} ${reducedLaunchFade ? 'reduced-launch-fade' : ''}`} style={{ ...(accent ? { '--agent-accent': accent } : {}), ...(reducedLaunchFade ? { '--launch-fade-duration': '180ms' } : {}) } as React.CSSProperties}>
      <aside className="sidebar" aria-label="Agents">
        <div className="sidebar-top">
          <div className="brand-lockup"><img className="brand-logo" src={bloblexLogo} alt="Bitbots logo" /><strong>Bitbots</strong></div>
          <div className="sidebar-create-actions">
            <button type="button" className={`icon-button${tasksOpen ? ' active' : ''}`} title="Tasks" aria-label="Tasks" aria-pressed={tasksOpen} disabled={connection !== 'connected'} onClick={() => { setTasksOpen((open) => !open); setSchedulesOpen(false); setAnalyticsOpen(false); setBlobPage(null) }}><ListChecks size={16} /></button>
            <button data-testid="create-blob" className="icon-button" title={`Create ${noun}`} aria-label={`Create ${noun}`} disabled={connection !== 'connected' || busy || runtimes.length === 0} onClick={() => openCreate()}><Plus size={17} /></button>
            <div className="more-menu-wrap" onKeyDown={(event) => { if (event.key === 'Escape') { setCreateMenuOpen(false); restoreCreateFocus() } }}>
              <button type="button" className="icon-button small" title={`Import a ${noun} setup`} aria-label={`${Noun} actions`} aria-haspopup="menu" aria-expanded={createMenuOpen} disabled={connection !== 'connected' || busy} onClick={() => setCreateMenuOpen((open) => !open)}><ChevronDown size={14} /></button>
              {createMenuOpen && <div className="menu-surface more-menu" role="menu">
                {managerOf(agents)
                  ? <><button className="menu-item" role="menuitem" onClick={startProjectWithManager}><BriefcaseBusiness size={15} />New project with {managerOf(agents)?.name ?? 'the Manager'}</button>
                    <button className="menu-item" role="menuitem" onClick={() => void importProjectWithManager()}><FolderInput size={15} />Import project folder…</button></>
                  : <button className="menu-item" role="menuitem" onClick={() => { setCreateMenuOpen(false); void createProject() }}><FolderPlus size={15} />New project…</button>}
                <button className="menu-item" role="menuitem" onClick={() => void importBlob()}><Import size={15} />Import {noun}…</button>
              </div>}
            </div>
          </div>
        </div>
        <div className="sr-only" aria-live="polite">{rosterAnnouncement}</div>
        <TeamSidebar banner={!managerOf(agents) && connection === 'connected' ? <ManagerSetupCard runtimes={runtimes.filter((runtime) => runtimeUsable(runtime))} disabled={connection !== 'connected'} onCreate={createOnboardedBlob} /> : null} agents={agents} projects={projects} sessions={sessions} runtimes={runtimes} runtimeLogos={runtimeLogos} sidebarModel={experiments.sidebarModel} botLock={experiments.botLock} connected={connection === 'connected'} now={now} pinnedIds={pins.favorites ?? []} unreadSessionIds={unreadSessionIds} approvalSessionIds={approvalSessionIds} selectedAgentId={activeSelectedAgent?.id ?? null} onOpenSearch={openQuickSwitcher} actions={{
          onSelect: selectAgent,
          onCreate: (projectId) => openCreate(projectId),
          onCreateProject: () => void createProject(),
          onEdit: openEdit,
          onArchive: setArchiveTarget,
          onDuplicate: (agent) => void duplicateAgent(agent),
          onExportBlob: (agent) => void exportBlob(agent),
          onRename: (agent) => setTextPrompt({ title: `Rename ${agent.name}`, label: `${Noun} name`, value: agent.name, confirmLabel: 'Rename', onSubmit: async (name) => { if (experiments.undo) await renameBlob(agent, name, agent.name); else await renameAgent(agent, name) } }),
          onTogglePin: (agentId) => updatePins((current) => toggleFavorite(current, agentId)),
          onMove: (agent, projectId) => { if (experiments.undo) void moveBlob(agent, projectId, agent.projectId ?? null); else void moveAgent(agent, projectId) },
          onReorder: (agent, direction) => reorderAgent(agent, direction),
          onPlace: (agent, target, edge) => void placeAgent(agent, target, edge),
          onSetHidden: (agent, hidden) => void teamUpdate(agent, { hidden }),
          onToggleLock: (agent) => { void rpc<{ agent: Agent }>('agent.lock.set', { agentId: agent.id, locked: agent.locked !== true }).then(({ agent: updated }) => mergeAgent(updated)).catch((reason) => setError(messageOf(reason))) },
          onToggleUnread: (_agent, session, unread) => { if (session) setSeenSessions((current) => markSeen(current, session.id, unread ? new Date(0).toISOString() : new Date().toISOString())) },
          onCopyConversationId: (_agent, session) => { if (session) void navigator.clipboard.writeText(session.id).catch(() => undefined) },
          onDeleteConversation: (_agent, session) => setSessionDeleteTarget(session),
          onRenameProject: (project) => setTextPrompt({ title: 'Rename project', label: 'Project name', value: project.name, confirmLabel: 'Rename', onSubmit: async (name) => { await projectAction('project.update', { projectId: project.id, name }) } }),
          onChangeProjectFolder: (project) => void openProjectFolder().then((path) => { if (path) void projectAction('project.update', { projectId: project.id, path }) }),
          onDeleteProject: setProjectDelete,
          onToggleProjectCollapsed: (project) => void projectAction('project.update', { projectId: project.id, collapsed: !project.collapsed }),
          onOpenRuntimeSettings: () => { setSettingsInitialPage('Agents'); setSettingsFocus(null); setSettingsSheet(true) },
        }} />
        <RemoteChip onOpen={() => { setSettingsInitialPage('Remote'); setSettingsFocus(null); setSettingsSheet(true) }} />
        <SidebarUsage quotas={snapshot?.quotas ?? []} onOpen={() => void showUsage()} />
        {platform.companion && <button type="button" role="switch" aria-label={`Companion, keep your ${noun} on screen while you work`} aria-checked={companionVisible} data-tour="companion" className="companion-sidebar-card" title={`Keep your ${noun} on screen while you work`} onClick={() => { void setCompanionVisibility(!companionVisible).catch((reason) => setError(messageOf(reason))) }}><BlobCanvas color="#b7a7f4" size={30} mini mood="idle" label="Companion" /><span><strong>Companion</strong></span><i className={`toggle ${companionVisible ? 'on' : ''}`} aria-hidden="true"><b /></i></button>}
        <ProfileMenu
          connection={connection}
          onShortcuts={experiments.shortcuts ? () => setShortcutsOpen(true) : undefined}
          usageActive={analyticsOpen}
          triggerRef={usageLinkRef}
          onUsage={() => { setSchedulesOpen(false); setTasksOpen(false); setAnalyticsOpen(true) }}
          onSchedules={() => { setAnalyticsOpen(false); setTasksOpen(false); setSchedulesAgentId(null); setSchedulesOpen(true) }}
          onRemote={() => { setSettingsInitialPage('Remote'); setSettingsFocus(null); setSettingsSheet(true) }}
          onBackup={() => { setSettingsInitialPage('Backup'); setSettingsFocus(null); setSettingsSheet(true) }}
          onWhatsNew={() => setWhatsNewOpen(true)}
          schedulesActive={schedulesOpen}
          onSettings={() => { setSettingsInitialPage('General'); setSettingsFocus(null); setSettingsSheet(true) }}
          onQuit={() => void quitBloblex()}
        />
      </aside>

      {activeSelectedAgent
        ? <ConversationsPanel agent={activeSelectedAgent} agents={agents} sessions={sessions} selectedSessionId={selectedSession?.id ?? null} sideSessionId={sideSessionId} canCreate={connection === 'connected' && runtimeReady} onSelect={selectConversation} onOpenSide={openSideConversation} onNew={() => newSession()} onRename={renameConversation} onArchive={(session) => void archiveConversation(session)} onDelete={(session) => setSessionDeleteTarget(session)} onClose={() => setConvosVisible(false)} />
        : <aside className="conversations-panel" aria-hidden="true" />}

      <section className="conversation-pane">
        {platform.updater && updateOffer.version && <UpdateAvailableBanner version={updateOffer.version} onView={() => { setSettingsInitialPage('General'); setSettingsFocus('updates'); setSettingsSheet(true) }} onLater={updateOffer.dismiss} />}
        {(launchWarnings.length > 0 || discoveryStatus.retrying) && !agentWarningDismissed && <LaunchWarnings warnings={launchWarnings} retrying={discoveryStatus.retrying} onSettings={() => { setSettingsInitialPage('Agents'); setSettingsSheet(true) }} onDismiss={() => setAgentWarningDismissed(true)} />}
        {discoveryConfirmation && <aside className="launch-scan-confirmation" role="status">{discoveryConfirmation}</aside>}
        {tasksOpen ? <TasksView agents={agents} projects={projects} runtimes={runtimes} connected={connection === 'connected'} onBack={() => setTasksOpen(false)} onOpenSession={(sessionId) => { setTasksOpen(false); const session = sessions.find((item) => item.id === sessionId); if (session) { setSelectedAgentId(session.agentId || null); setSelectedSessionId(session.id) } }} /> : schedulesOpen ? <SchedulesView automations={snapshot?.automations ?? []} agents={agents} connected={connection === 'connected'} paused={schedulesPaused} nowMs={schedulesNowMs} agentId={schedulesAgentId} loadError={schedulesError} onBack={() => setSchedulesOpen(false)} onCreate={createAutomation} onUpdate={updateAutomation} onSetEnabled={setAutomationEnabled} onRunNow={runAutomationNow} onDelete={deleteAutomation} onLoadRuns={loadAutomationRuns} onPreview={previewAutomation} onSetPaused={setAutomationsPaused} onOpenSession={openAutomationSession} /> : analyticsOpen ? <AnalyticsView sessions={sessions} agents={agents} quotas={snapshot?.quotas ?? []} connected={connection === 'connected'} onRefreshQuota={refreshQuota} onBack={closeAnalytics} /> : blobPage && draft ? <BlobPage mode={blobPage.mode} agent={editingAgent} onOpenMemory={() => { setSettingsInitialPage('Memory'); setSettingsFocus(null); setSettingsSheet(true) }} onOpenSkills={() => { setSettingsInitialPage('Skills'); setSettingsFocus(null); setSettingsSheet(true) }} changes={draft && baseline ? changedFields(draft, baseline) : []} onDuplicate={editingAgent ? () => void duplicateAgent(editingAgent) : undefined} onExport={editingAgent ? () => void exportBlob(editingAgent) : undefined} draft={draft} runtime={draftRuntime} session={blobPage.mode === 'edit' ? selectedSession : null} runtimes={runtimes} projects={projects} sessions={pageSessions} legacyCount={pageLegacy.length} connected={connection === 'connected'} saving={busy} dirty={draftDirty} ready={draftReady} canStartSession={connection === 'connected' && !busy && runtimeUsable(draftRuntime)} error={formError} remoteNotice={remoteNotice} errors={fieldErrors} execution={executionFromAgent(editingAgent)} autoApprovals={snapshot?.autoApprovals ?? []} bypassNotices={snapshot?.bypassNotices ?? []} onDraftChange={(next) => { setDraft(next); setFormError(null) }} onExecutionGate={(gate) => { executionGate.current = gate }} onBack={() => closeBlobPage(editingAgent?.id ?? activeSelectedAgent?.id ?? null)} onSave={() => void saveBlob()} onCancel={() => { const source = remoteNotice && editingAgent ? draftFromAgent(editingAgent) : baseline; if (!source) return; setDraft(source); setBaseline(source); setRemoteNotice(null); setFormError(null) }} onArchive={() => { if (editingAgent) setArchiveTarget(editingAgent) }} onNewSession={() => { if (editingAgent) newSession(editingAgent.id) }} onOpenSession={(session) => { setSelectedSessionId(session.id); closeBlobPage(editingAgent?.id ?? null) }} /> : <>
        <header className="chat-header">
          <div className="chat-title">
            {activeSelectedAgent && !convosOpen && !sideSession && <button className="icon-button chat-convos-toggle" title="Show conversations" aria-label="Show conversations" onClick={() => setConvosVisible(true)}><PanelLeft size={16} /></button>}
            {sideSession
              ? <SideConversationHeader peer={sidePeer} peerName={sidePeer?.name ?? sideSession.link?.peerName ?? 'Teammate'} target={sideAgent} targetName={sideAgent?.name ?? 'Teammate'} topic={sideTopic(sideSession)} permission={sideAgent && <PermissionModeControl session={sideSession} agent={sideAgent} disabled={connection !== 'connected' || sideAgent.locked === true} locked={sideAgent.locked === true} note={`Applies to this ${noun}, from the next turn.`} onSessionUpdated={(updated) => setSnapshot((current) => current ? mergeHydratedSession(current, updated.id, updated) : current)} onAgentUpdated={(updated) => mergeAgent(updated)} onError={(reason) => setError(messageOf(reason))} />} />
              : activeSelectedAgent
                ? <>{runtimeLogos && <RuntimeMark provider={selectedRuntime?.provider} size={15} />}<button type="button" className="chat-title-button" aria-label={`Edit ${activeSelectedAgent.name}`} title={`${Noun} settings`} onClick={() => openEdit(activeSelectedAgent)}>{activeSelectedAgent.name}</button><RuntimeProblemMarker runtime={selectedRuntime} onOpenSettings={() => { setSettingsInitialPage('Agents'); setSettingsFocus(null); setSettingsSheet(true) }} />{activeSelectedAgent.role?.trim() && <span className="role-chip">{activeSelectedAgent.role.trim()}</span>}{selectedSession && <ConversationCrumb project={currentProjectName} title={selectedSession.title && selectedSession.title !== activeSelectedAgent.name ? selectedSession.title : 'New chat'} />}</>
                : hasActiveBlobs ? <strong className="chat-title-text">{agentName}</strong> : null}
          </div>
          <div className="header-actions" hidden={!hasActiveBlobs && !selectedSession}>
            <UpdateBadge />
            <ApprovalPill mode={headerMode} />
            {!sideSession && <button className="icon-button" title={conversationEmpty ? 'This conversation is already fresh' : 'Start a fresh conversation'} aria-label="New conversation" disabled={!canStartSession || conversationEmpty} onClick={(event) => newSession(undefined, event.currentTarget)}><SquarePen size={16} /></button>}
            <button className={`icon-button ${inspectorOpen ? 'active' : ''}`} title="Details" aria-label="Toggle context pane" aria-pressed={inspectorOpen} onClick={toggleInspector}><PanelRight size={16} /></button>
            <div className="more-menu-wrap" onKeyDown={(event) => { if (event.key === 'Escape') { setMoreOpen(false); restoreMoreFocus() } }}>
              <button className="icon-button" title="More options" aria-label="More options" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}><MoreHorizontal size={17} /></button>
              {moreOpen && <div className="menu-surface more-menu" role="menu"><button className="menu-item" role="menuitem" disabled={refreshing} onClick={() => { setMoreOpen(false); void refresh() }}><RefreshCw size={15} />Refresh state</button><button className="menu-item" role="menuitem" disabled={!selectedSession} onClick={() => { setMoreOpen(false); void showUsage() }}><Gauge size={15} />Usage details</button><button className="menu-item" role="menuitem" disabled={!selectedSession} onClick={() => { setMoreOpen(false); void exportConversation(true) }}><ClipboardCopy size={15} />Copy as Markdown</button><button className="menu-item" role="menuitem" disabled={!selectedSession} onClick={() => { setMoreOpen(false); void exportConversation(false) }}><FileDown size={15} />Export as Markdown…</button>{activeSelectedAgent && <button className="menu-item" role="menuitem" onClick={() => { setMoreOpen(false); openEdit(activeSelectedAgent) }}><Settings2 size={15} />{Noun} settings</button>}{selectedSession && !sideSession && agents.filter((item) => !item.archived && !item.hidden && item.id !== activeSelectedAgent?.id).length > 0 && <button className="menu-item" role="menuitem" onClick={() => { setMoreOpen(false); setHandoffError(null); setHandoffOpen(true) }}><ArrowUpRight size={15} />Continue in another {noun}…</button>}<span className="menu-separator" />{platform.tray && <button role="menuitem" className="menu-item danger" onClick={() => void quitBloblex()}><X size={15} />Quit Bitbots</button>}</div>}
            </div>
          </div>
        </header>

        <ConnectionBanner state={connection} attempts={reconnectAttempts} failed={reconnectFailed} onRetry={retryConnection} />

        {error && <div className="inline-error" role="alert"><ShieldAlert size={16} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}><X size={15} /></button></div>}
        {archiveNotice && <div className="inline-error" role="status"><span>{archiveNotice}</span><button aria-label="Dismiss notice" onClick={() => setArchiveNotice(null)}><X size={15} /></button></div>}

        {!selectedSession ? <>{activePermission && <ApprovalCard permission={activePermission} onReply={(choice) => answerPermission(activePermission, choice)} /> }<EmptyConversation connected={connection === 'connected'} hasRuntime={runtimes.length > 0} hasAgent={!!activeSelectedAgent} runtimeReady={runtimeReady} runtimeStatus={selectedRuntime?.status} accent={accent} mood={selectedMood} agentName={agentName} look={activeSelectedAgent ? agentLook(activeSelectedAgent) : null} onNewSession={(anchor) => newSession(undefined, anchor)} onCreate={() => openCreate()} onRefresh={() => void refreshRuntimes()} /></> : <>
          {!sideSession && <ChangeBanner session={selectedSession} dismissed={reviewDismissals[selectedSession.id] ?? []} onDiff={(path, content) => setDiffViewer({ path, content })} onUndo={(file) => setRevertTarget({ sessionId: selectedSession.id, file })} onDismiss={(ids) => setReviewDismissals((current) => ({ ...current, [selectedSession.id]: [...(current[selectedSession.id] ?? []), ...ids] }))} onNewConversation={() => newSession()} />}
          <div className="conversation-frame">
            {conversationScrollable && <ConversationOutline key={selectedSession.id} sessionId={selectedSession.id} items={outlineItems} />}
          <section ref={messageListRef} className="message-list" aria-label="Conversation" onScroll={(event) => { const node = event.currentTarget; stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72 }}>
            <div className="conversation-layout">
              <div className="chat-column">
              {groupedConversationItems.length === 0 && visiblePendingSends.length === 0 && !waitingDelegation && !sideSession ? <div className="session-first-state"><BlobCanvas color={accent || '#e6e9ee'} size={112} mood={selectedMood} effectOverscanTop={118} look={activeSelectedAgent ? agentLook(activeSelectedAgent) : null} label={activeSelectedAgent?.name ?? agentName} /><h2>{runtimeReady ? 'Ready when you are.' : 'This bot needs attention.'}</h2><p>{runtimeReady ? currentProjectName ? <>Ask {agentName} to explore <code>{currentProjectName}</code> or make a change.</> : <>Ask {agentName} a question or make a change.</> : selectedRuntime?.status === 'error' ? 'Open Settings → Coding agents. Update or repair this CLI, then choose Scan again.' : 'Open Settings → Coding agents and scan again before starting a conversation.'}</p></div> : groupedConversationItems.map((item, index) => {
                const team = item.kind === 'message' ? teamItem(item.value!, item.id) : null
                const content = item.kind === 'activity-group'
                  ? <ActivitySummaryLine group={item} onDiff={(path, content) => setDiffViewer({ path, content })} />
                  : item.kind === 'message'
                    ? (team && experiments.search && !team.props.id ? <div id={`conversation-message-${encodeURIComponent(item.id)}`}>{team}</div> : team) ?? <MessageItem id={`conversation-message-${encodeURIComponent(item.id)}`} message={item.value!} accent={accent} agentName={agentName} showAvatar={!isUserMessage(item.value) && (index === 0 || isPreviousItemNonMessageOrUser(groupedConversationItems, index))} mood={index === lastAgentIndex ? selectedMood : 'idle'} agents={agents} onOpenReference={openSideConversation} sourceSessionId={selectedSession?.id ?? ''} sourceMessages={sessionMessages} onJumpToMessage={jumpToMessage} onContextMenu={item.value?.role === 'user' && !sideSession ? (event) => openUserMessageMenu(event, item.value!) : undefined} onToggleReaction={experiments.messageActions && !sideSession && item.value?.id ? (emoji) => { void toggleMessageReaction(selectedSession.id, String(item.value!.id), emoji).catch(() => setError('Could not save your reaction. Try again.')) } : undefined} />
                    : <ActivityItem item={item} onDiff={(path, content) => setDiffViewer({ path, content })} runtime={selectedRuntime} onSignedIn={() => void refresh()} />
                const message = item.kind === 'message' ? item.value : undefined
                const text = originalMessageText(message?.content ?? message?.text)
                const messageMeta = message?.meta && typeof message.meta === 'object' ? message.meta as Record<string, unknown> : {}
                const hasUserOrAssistantMessage = (message?.role === 'user' || message?.role === 'assistant') && !['blob_reply', 'blob_message', 'delegation', 'auto_retry'].includes(String(messageMeta.kind ?? ''))
                const actions = experiments.messageActions && !sideSession && hasUserOrAssistantMessage
                const userMessage = message?.role === 'user'
                const groupStart = !!message && !userMessage && (index === 0 || isPreviousItemNonMessageOrUser(groupedConversationItems, index))
                const files = experiments.changeReview && !sideSession && message ? filesUnderReply(selectedSession, message) : []
                return <Fragment key={item.id}>
                  {actions && message ? <div className={`message-action-shell${userMessage ? ' user' : ''}${groupStart ? ' group-start' : ''}`} onKeyDown={(event) => {
                    if (!userMessage || !(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return
                    event.preventDefault()
                    const row = event.currentTarget.querySelector<HTMLElement>('.message-row')
                    if (!row) return
                    const rect = row.getBoundingClientRect()
                    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + Math.min(rect.width, 120), clientY: rect.top + Math.min(rect.height, 48) }))
                  }}>{content}<MessageActions text={text} time={messageClock(message?.createdAt)} reactions={Array.isArray(message.reactions) ? message.reactions as string[] : []} canReply={!!text.trim() && !!message.id} onReply={() => stageMessageReply(message)} onToggleReaction={(emoji) => toggleMessageReaction(selectedSession.id, String(message.id), emoji)} onError={setError} /></div> : content}
                  {files.length > 0 && <ChangeReview files={files} dismissed={reviewDismissals[selectedSession.id] ?? []} onKeep={(id) => dismissReviewFile(selectedSession.id, id)} onRevert={(file) => setRevertTarget({ sessionId: selectedSession.id, file })} onDiff={(path, content) => setDiffViewer({ path, content })} />}
                </Fragment>
              })}
              {visiblePendingSends.map((item) => <article key={item.id} className="message-row user pending" aria-label="You, sending" aria-busy="true">
                <div className="message-content"><div className="message-bubble-wrap"><div className="message-bubble"><SafeMessageText text={item.text} /></div></div><div className="message-pending-note" role="status">{item.attachments ? `Sending with ${item.attachments} ${item.attachments === 1 ? 'file' : 'files'}…` : 'Sending…'}</div></div>
              </article>)}
              {activePermission && (activePermission.kind === 'proposal'
                ? <ProposalCard key={activePermission.id} request={activePermission} managerName={managerOf(agents)?.name} projects={projects} onDecided={() => void refresh()} onError={setError} />
                : activePermission.kind === 'question'
                ? <QuestionCard request={activePermission} onAnswer={(answers) => answerQuestion(activePermission, answers)} onDismiss={() => void answerQuestion(activePermission, null)} />
                : <ApprovalCard permission={activePermission} focusOnMount={approvalFocusOnMount} onReply={(choice) => answerPermission(activePermission, choice)} />)}
              {!sideSession && lastTurnWasPlan && !latestPlanId && <div className="plan-ready-bar" role="status"><span>Plan mode is on. Approve the plan to let {agentName} start building.</span><button type="button" className="primary-button small" onClick={() => void approvePlan()}>Approve &amp; build</button></div>}
              {selectedSession.state === 'starting' && <div className="working-indicator starting" role="status"><span className="typing" aria-hidden="true"><i /><i /><i /></span>Starting {agentName}…</div>}
              {selectedSession.state === 'working' && <div className="working-indicator" role="status"><span className="typing" aria-hidden="true"><i /><i /><i /></span>{agentName} is working</div>}
              {waitingDelegation && selectedSession.state !== 'working' && <div className="working-indicator waiting" role="status"><span className="typing" aria-hidden="true"><i /><i /><i /></span>Waiting for a free working slot for {sideAgent?.name ?? agentName}…</div>}
              </div>
            </div>
          </section>
          </div>
          {sideSession ? <div className="side-close"><button type="button" className="secondary-button" onClick={closeSideConversation}>Close chat</button></div> : <div className="composer-wrap">
            {usageTip && <UsageTip tip={usageTip} onDismiss={() => dismissUsageTip(usageTip)} onViewUsage={() => void showUsage()} />}
            {dictationPartial && <div className="dictation-partial" role="status" aria-label={`Listening: ${dictationPartial}`}><span className="dictation-partial-dot" aria-hidden="true" />{dictationPartial}</div>}
            {promptQueue && promptQueue.items.length > 0 && <QueueBanner items={promptQueue.items} paused={promptQueue.paused} sessionBusy={sessionBusy} nowMs={queueNowMs} disabled={connection !== 'connected'} onSendNow={sendQueuedNow} onDelete={deleteQueued} onUpdate={updateQueued} onReorder={reorderQueued} onResume={resumeQueue} onCancelRetry={cancelAutoRetry} />}
            {sessionBusy && <div className="composer-send-mode" role="status">{composerDelivery.mode === 'steer' ? 'Steer · reaches this turn now' : 'Queue · sends after this turn'}<span> · Ctrl+Enter / ⌘+Enter sends the other way</span>{deliveryNotice && <span className="composer-send-reason">{deliveryNotice}</span>}</div>}
            <div data-tour="composer" className={`composer-box ${composerDropActive ? 'drop-active' : ''}`} onDragOver={(event) => { if (!imagesSupported || !Array.from(event.dataTransfer.items).some((item) => item.kind === 'file')) return; event.preventDefault(); setComposerDropActive(true) }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setComposerDropActive(false) }} onDrop={(event) => { setComposerDropActive(false); if (!imagesSupported) return; const files = Array.from(event.dataTransfer.files); if (!files.length) return; event.preventDefault(); addAttachments(files) }}>
              {replyTarget && <ReplyContextStrip target={replyTarget} onCancel={() => { replyTargetRef.current = null; setReplyTarget(null) }} />}
              <AttachmentTray attachments={attachments} onRemove={removeAttachment} />
              {clipboardReadPending && <p className="clipboard-paste-status" role="status">Preparing pasted image…</p>}
              {slashCommand && <SlashCommandChip command={slashCommand} onRemove={() => setSlashCommand(null)} />}
              {slash && slashCandidates.length > 0 && <SlashMenu items={slashCandidates} activeIndex={slash.index} onPick={pickSlash} onHover={(index) => setSlash((current) => current ? { ...current, index } : current)} />}
              {hashRef && !mention && <ConversationPicker sessions={blobSideSessions} agents={agents} ownerId={activeSelectedAgent?.id} query={hashRef.query} activeIndex={hashRef.index} onPick={pickConversation} onHover={(index) => setHashRef((current) => current ? { ...current, index } : current)} />}
              {mention && <MentionPicker agents={agents.filter((agent) => agent.id !== activeSelectedAgent?.id && !agent.hidden)} query={mention.query} activeIndex={mention.index} onPick={pickMention} onHover={(index) => setMention((current) => current ? { ...current, index } : current)} />}
              <textarea ref={composerRef} value={composer} onFocus={() => { composerTypingRef.current = true }} onBlur={() => { composerTypingRef.current = false }} onChange={(event) => { const value = event.target.value; setComposer(value); const caret = event.target.selectionStart ?? value.length; const slashFound = slashQuery(value, caret); setSlash(slashFound ? { ...slashFound, index: 0 } : null); const found = slashFound ? null : mentionQuery(value, caret); setMention(found ? { ...found, index: 0 } : null); const hash = (slashFound || found) ? null : hashQuery(value, caret); setHashRef(hash && blobSideSessions.length ? { ...hash, index: 0 } : null) }} onPaste={handleComposerPaste} onKeyDown={(event) => {
                if (event.key === 'Backspace' && slashCommand && !composer) { event.preventDefault(); setSlashCommand(null); return }
                if (slash && slashCandidates.length) {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSlash({ ...slash, index: (slash.index + (event.key === 'ArrowDown' ? 1 : slashCandidates.length - 1)) % slashCandidates.length }); return }
                  if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pickSlash(slashCandidates[Math.min(slash.index, slashCandidates.length - 1)]); return }
                  if (event.key === 'Escape') { event.preventDefault(); setSlash(null); return }
                }
                if (mention && mentionCandidates.length) {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMention({ ...mention, index: (mention.index + (event.key === 'ArrowDown' ? 1 : mentionCandidates.length - 1)) % mentionCandidates.length }); return }
                  if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pickMention(mentionCandidates[Math.min(mention.index, mentionCandidates.length - 1)]); return }
                  if (event.key === 'Escape') { event.preventDefault(); setMention(null); return }
                }
                if (hashRef && hashCandidates.length) {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setHashRef({ ...hashRef, index: (hashRef.index + (event.key === 'ArrowDown' ? 1 : hashCandidates.length - 1)) % hashCandidates.length }); return }
                  if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pickConversation(hashCandidates[Math.min(hashRef.index, hashCandidates.length - 1)]); return }
                  if (event.key === 'Escape') { event.preventDefault(); setHashRef(null); return }
                }
                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendPrompt(undefined, event.ctrlKey || event.metaKey) }
              }} placeholder={`Message ${agentName}`} aria-label={`Message ${agentName}`} disabled={busy || selectedSession.state === 'waiting_permission' || !runtimeReady} rows={1} />
              <div className="composer-control-strip" data-tour="controls">
                <div className="composer-controls-start">
                  <AttachButton supported={imagesSupported} disabled={connection !== 'connected' || busy || !runtimeReady} count={attachments.length} onFiles={addAttachments} />
                  <button type="button" data-tour="plan" className={`composer-pill plan-pill ${planOn ? 'on' : ''}`} aria-pressed={planOn} aria-label="Plan mode" title={planOn ? 'Plan mode: the agent proposes a plan before changing anything' : 'Turn on plan mode'} disabled={connection !== 'connected' || sessionBusy} onClick={() => void setPlanMode(!planOn)}><ClipboardList size={14} aria-hidden="true" /><span>Plan</span></button>
                  <PermissionModeControl session={selectedSession} agent={activeSelectedAgent} disabled={connection !== 'connected' || activeSelectedAgent?.locked === true} locked={activeSelectedAgent?.locked === true} onSessionUpdated={(updated) => setSnapshot((current) => current ? mergeHydratedSession(current, updated.id, updated) : current)} onAgentUpdated={(updated) => mergeAgent(updated)} onError={(reason) => setError(messageOf(reason))} />
                </div>
                <div className="composer-controls-end">
                  {selectedSession && activeSelectedAgent && <SessionExecutionControls session={selectedSession} agent={activeSelectedAgent} locked={activeSelectedAgent.locked === true} onSessionUpdated={(updated) => setSnapshot((current) => current ? mergeHydratedSession(current, updated.id, updated) : current)} onAgentUpdated={(updated) => mergeAgent(updated)} onError={(reason) => setError(messageOf(reason))} />}
                  <ContextWindowIndicator used={selectedSession.contextUsed} size={selectedSession.contextSize} contextModel={selectedSession.contextModel} contextEstimated={selectedSession.contextEstimated} model={contextModel} isNewConversation={(selectedSession.messages ?? []).length === 0} quota={sessionQuota} onOpenUsage={() => void showUsage()} />
                  {platform.nativeSpeech && speechEnabled && <DictationButton owner="desktop" modelId={speechModel} onFinal={(text) => setComposer((current) => (current ? `${current} ${text}` : text))} onPartial={setDictationPartial} disabled={connection !== 'connected' || busy || selectedSession.state === 'waiting_permission' || !runtimeReady} />}
                  {turnLive && <button className="send-button cancel" onClick={() => void cancelTurn()} disabled={busy} aria-label="Cancel turn" title="Stop"><Square size={12} fill="currentColor" /></button>}
                  <button className="send-button" onClick={(event) => void sendPrompt(undefined, event.ctrlKey || event.metaKey)} disabled={connection !== 'connected' || busy || clipboardReadPending || (!composer.trim() && !attachments.some((item) => item.status === 'ready')) || attachments.some((item) => item.status === 'staging') || !runtimeReady} aria-label={sessionBusy ? composerDelivery.mode === 'steer' ? 'Steer now' : 'Queue message' : 'Send message'} title={clipboardReadPending ? 'Preparing the pasted image' : connection !== 'connected' ? 'Waiting for the connection' : sessionBusy ? composerDelivery.mode === 'steer' ? 'Steer this turn now. Ctrl+Enter queues instead.' : 'Add to the queue. Ctrl+Enter sends the other way where supported.' : 'Send'}>{busy ? <LoaderCircle size={16} className="spinning" /> : <ArrowUp size={17} />}</button>
                </div>
              </div>
            </div>
            <div className="composer-note">{currentProjectName ? <><FolderOpen size={11} />{currentProjectName}<span>·</span></> : null}Agent actions run on your device. You approve what matters.</div>
          </div>}
        </>}
        </>}
      </section>

      <aside className="context-pane" aria-label="Conversation details" aria-hidden={!detailsVisible} inert={!detailsVisible}>
        <section className="context-head compact">
          {activeSelectedAgent ? <BlobCanvas color={accent} size={64} mood={selectedMood} look={agentLook(activeSelectedAgent)} label={activeSelectedAgent.name} /> : <span className="context-head-placeholder"><Code2 size={20} /></span>}
          <h2>{agentName}</h2>
          <p>{selectedSession?.title?.trim() || (selectedRuntime ? [labelize(selectedRuntime.provider), selectedRuntime.version].filter(Boolean).join(' · ') : 'No coding agent selected')}</p>
        </section>
        <SessionRail workingBots={<WorkingBotsPanel sessions={sessions} agents={agents} selectedId={sideSessionId} onOpen={openSideConversation} />} session={selectedSession} usage={snapshot?.usage ?? []} appliedModel={appliedModelState?.sessionId === selectedSession?.id ? appliedModelState?.model ?? null : null} onOpenFile={(path) => void openInEditor(path, selectedSession?.projectPath).catch((reason) => setError(messageOf(reason)))} onRevealFile={(path) => void revealInExplorer(path, selectedSession?.projectPath).catch((reason) => setError(messageOf(reason)))} onCopyPath={async (path) => { try { await navigator.clipboard.writeText(await resolveProjectFile(path, selectedSession?.projectPath)) } catch (reason) { setError(messageOf(reason)) } }} onDiff={(path, content) => setDiffViewer({ path, content })} onOpenFolder={(path) => void revealInExplorer(path, path).catch((reason) => setError(messageOf(reason)))} onOpenRemote={() => { setSettingsInitialPage('Remote'); setSettingsFocus(null); setSettingsSheet(true) }} runtimeFacts={selectedRuntime ? [`${labelize(selectedRuntime.provider)} ${selectedRuntime.version ?? ''}`.trim(), `Sign-in: ${labelize(selectedRuntime.authState, 'unknown')}`, selectedRuntime.executablePath ? `Executable: ${selectedRuntime.executablePath}` : null].filter(Boolean).join(' · ') : undefined} />
      </aside>

      {!companion && <ContextualHints enabled={connection === 'connected' && !launchVisible && !onboardingVisible && !settingsSheet && !quickSwitcherOpen && !whatsNewOpen} />}
      {!companion && <TourHost enabled={connection === 'connected' && !launchVisible && !onboardingVisible && !settingsSheet} justOnboarded={onboardingCompleteThisRun} agentColor={activeSelectedAgent?.color ?? '#b7a7f4'} />}
      {!companion && usageBarEnabled && <QuotaBar quotas={snapshot?.quotas ?? []} refreshing={quotaRefreshing} onRefresh={refreshQuota} onOpenDetails={() => void showUsage()} />}
      {usageSheet && <UsageSheet summary={usageSummary} period={usagePeriod} quotas={snapshot?.quotas ?? []} loading={busy && usageSummary === null} quotaRefreshing={quotaRefreshing} onRefreshQuota={refreshQuota} onPeriodChange={(period) => { setUsageSummary(null); void showUsage(period) }} onOpenHistory={() => { setUsageSheet(false); setAnalyticsOpen(true) }} onClose={() => setUsageSheet(false)} />}
      {quickSwitcherOpen && <QuickSwitcher items={quickSwitcherItems} onChoose={chooseQuickSwitcherItem} onClose={() => setQuickSwitcherOpen(false)} />}
      {settingsSheet && <SettingsSheet experiments={experiments} onExperimentChange={changeExperiment} scanStatus={discoveryStatus} snapshot={snapshot} usageBarEnabled={usageBarEnabled} onUsageBarChange={setUsageBarEnabled} claudeWorkflowsEnabled={claudeWorkflowsEnabled} onClaudeWorkflowsChange={setClaudeWorkflowsEnabled} usageTipsEnabled={usageTipsEnabled} onUsageTipsChange={setUsageTipsEnabled} activityDetails={activityDetails} onActivityDetailsChange={setActivityDetails} runtimeLogos={runtimeLogos} onRuntimeLogosChange={setRuntimeLogos} speechEnabled={speechEnabled} onSpeechEnabledChange={setSpeechEnabled} speechModel={speechModel} onSpeechModelChange={setSpeechModel} initialPage={settingsInitialPage} focusUpdates={settingsFocus === 'updates'} onClose={() => { setSettingsSheet(false); setSettingsFocus(null) }} onRefresh={refreshRuntimes} onError={setError} onRunSetup={() => { setSettingsSheet(false); setOnboardingVisible(true) }} onOpenAgent={(agentId) => { const target = agents.find((agent) => agent.id === agentId); setSettingsSheet(false); if (target) openEdit(target) }} />}
      {messageMenu && selectedSession?.id === messageMenu.sessionId && <MessageContextMenu position={messageMenu} canRetry={messageMenu.latest && connection === 'connected' && runtimeReady && !busy && !sessionBusy} onClose={closeMessageMenu} onRetry={() => {
        void doRpc('session.prompt', {
          sessionId: messageMenu.sessionId,
          text: messageMenu.text,
          ...(messageMenu.references.length ? { conversationRefs: messageMenu.references.map((reference) => reference.id) } : {}),
          ...(messageMenu.replyTo ? { replyTo: { sourceSessionId: messageMenu.replyTo.sourceSessionId, messageId: messageMenu.replyTo.messageId } } : {}),
          ...(messageMenu.attachments.length ? { attachments: messageMenu.attachments.map((attachment) => ({ path: attachment.path, name: attachment.name })) } : {}),
        }).then(refresh).catch(() => undefined)
      }} onEdit={() => {
        setComposer(messageMenu.text)
        setConversationRefs(messageMenu.references)
        clearAttachments()
        replyTargetRef.current = messageMenu.replyTo
        setReplyTarget(messageMenu.replyTo)
        requestAnimationFrame(() => composerRef.current?.focus())
      }} />}
      {messageSearchOpen && experiments.search && <MessageSearch agents={agents} onClose={() => setMessageSearchOpen(false)} onChoose={(result) => {
        const session = sessions.find((s) => s.id === result.sessionId)
        if (!session) { setError('This conversation is no longer available.'); return }
        setBlobPage(null); setAnalyticsOpen(false); setSchedulesOpen(false)
        const owner = agents.find((a) => a.id === session.agentId && !a.archived)
        if (session.agentId && !owner) {
          void rpc<{ agent: Agent }>('agent.get', { agentId: session.agentId }).then(({ agent }) => {
            mergeAgent(agent); openSideConversation(session.id); setSearchTarget(result)
          }).catch(() => setError('Could not open this saved conversation.'))
        } else {
          if (session.link?.kind === 'side' || (!session.agentId && !agents.some((a) => !a.archived && a.runtimeId === session.runtimeId))) openSideConversation(session.id)
          else { setSideSessionId(null); selectSession(session) }
          setSearchTarget(result)
        }
      }} />}
      {handoffOpen && selectedSession && <HandoffDialog agents={agents} sourceAgentId={activeSelectedAgent?.id ?? null} busy={handoffBusy} error={handoffError} onClose={() => setHandoffOpen(false)} onPick={(target) => void (async () => {
        setHandoffBusy(true)
        setHandoffError(null)
        try {
          const result = await rpc<{ draft?: string }>('session.handoff.draft', { fromSessionId: selectedSession.id })
          const draftText = typeof result.draft === 'string' ? result.draft : ''
          setHandoffOpen(false)
          selectAgent(target)
          requestAnimationFrame(() => { setComposer(draftText); composerRef.current?.focus() })
        } catch (reason) { setHandoffError(messageOf(reason)) } finally { setHandoffBusy(false) }
      })()} />}
      {whatsNewOpen && !companion && <WhatsNewDialog onClose={() => setWhatsNewOpen(false)} onOpenLink={(url) => void openSafeLink(url)} />}
      {shortcutsOpen && experiments.shortcuts && <ShortcutSheet speechEnabled={speechEnabled} onClose={() => setShortcutsOpen(false)} />}
      {diagnosticsOpen && !companion && <DiagnosticsDialog onClose={() => setDiagnosticsOpen(false)} />}
      <UndoToasts toasts={undoToasts} onRemove={removeUndoToast} onError={setError} />
      {revertTarget && <ConfirmDialog title={`Revert ${String(revertTarget.file.path)}?`} body="Only this turn’s saved change will be reversed. Later edits that conflict with it prevent the revert." confirmLabel="Revert change" cancelLabel="Keep it" tone="warning" onConfirm={async () => {
        try {
          await rpc('file.revert', { sessionId: revertTarget.sessionId, fileChangeId: revertTarget.file.id })
          dismissReviewFile(revertTarget.sessionId, String(revertTarget.file.id))
          setRevertTarget(null)
        } catch (reason) {
          setRevertTarget(null)
          setError(messageOf(reason))
        }
      }} onCancel={() => setRevertTarget(null)} />}
      {diffViewer && <DiffViewer path={diffViewer.path} content={diffViewer.content} onClose={() => setDiffViewer(null)} />}
      {archiveTarget && <ConfirmDialog title={`Archive ${archiveTarget.name}?`} body={experiments.undo ? "It leaves the sidebar and companion. Its conversations stay saved. You can undo this for eight seconds." : "It leaves the sidebar and companion. Its conversations stay saved. Restoring a " + noun + " is not available yet."} confirmLabel={`Archive ${noun}`} cancelLabel="Keep it" tone="warning" icon={<BlobCanvas decorative color={agentColorHex(archiveTarget.color)} size={34} mood="sleeping" look={agentLook(archiveTarget)} label={`${archiveTarget.name} preview`} />} onConfirm={() => void confirmArchive()} onCancel={() => setArchiveTarget(null)} />}
      {sessionDeleteTarget && <ConfirmDialog title="Delete this conversation?" body="This removes it and its messages from Bitbots. The coding agent's own history is not touched." confirmLabel="Delete" cancelLabel="Cancel" holdToConfirm successTitle="Conversation deleted" successBody={experiments.undo ? "Deletion is scheduled. Use Undo within eight seconds to keep the conversation." : "This conversation and its messages were removed from Bitbots."} onConfirm={async () => { if (experiments.undo) await deleteConversation(sessionDeleteTarget); else await rpc('session.delete', { sessionId: sessionDeleteTarget.id }) }} onComplete={() => { setSessionDeleteTarget(null); focusSidebarBlob() }} onCancel={() => { const id = sessionDeleteTarget.id; setSessionDeleteTarget(null); focusSidebarSession(id) }} />}
      {textPrompt && <TextPromptDialog {...textPrompt} onCancel={() => setTextPrompt(null)} onSubmit={async (value) => { try { await textPrompt.onSubmit(value); setTextPrompt(null) } catch (reason) { setError(messageOf(reason)) } }} />}
      {projectDelete && <ConfirmDialog title={`Delete ${projectDelete.name}?`} body={`The project is removed from Bitbots. Its ${nouns} move to Unassigned and the folder on disk is not touched.`} confirmLabel="Delete project" cancelLabel="Keep it" tone="danger" onConfirm={() => { const project = projectDelete; setProjectDelete(null); const memberIds = agents.filter((agent) => agent.projectId === project.id).map((agent) => agent.id); if (experiments.undo) void removeProject(project, memberIds); else void projectAction('project.delete', { projectId: project.id }) }} onCancel={() => setProjectDelete(null)} />}
      {pendingBlobImport && <ImportBlobDialog blob={pendingBlobImport} runtimes={runtimes} onCancel={() => { setPendingBlobImport(null); restoreCreateFocus() }} onCreate={(runtimeId) => createImportedBlob(pendingBlobImport, runtimeId)} />}
    </main>
    </>
  )
}

function ImportBlobDialog({ blob, runtimes, onCancel, onCreate }: { blob: SharedBlob; runtimes: Runtime[]; onCancel: () => void; onCreate: (runtimeId: string) => void }) {
  const noun = useEntityNoun()
  const Noun = useEntityNoun({ capital: true })
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
        <span className="import-kicker">{Noun} file</span>
        <h2 id="import-blob-title">Import {blob.name}</h2>
        <p>{blob.description.trim() || 'No description in this file.'}</p>
      </span>
    </header>
    <dl className="import-facts">{facts.map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>
    {runtimes.length === 0
      ? <p className="import-empty" role="alert">No coding agents are available. Scan again before importing.</p>
      : <div className="import-runtimes" role="radiogroup" aria-label={`Attach imported ${noun} to coding agent`}>
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
    <p className="import-note">Continue opens a draft you can edit. Nothing is created until you choose Create {noun}.</p>
    <div className="blob-dialog-actions"><button type="button" className="secondary-button" data-dialog-initial-focus onClick={close}>Cancel</button><button type="button" className="primary-button" disabled={!runtimeId} onClick={() => onCreate(runtimeId)}>Continue</button></div>
  </section></div>
}

/** "Project / Conversation" beside the bot's name in the chat header. */
function ConversationCrumb({ project, title }: { project: string | null; title: string }) {
  const text = project ? `${project} / ${title}` : title
  return <span className="conversation-crumb" title={text}>{project && <><span className="conversation-crumb-project">{project}</span><span className="conversation-crumb-sep" aria-hidden="true">/</span></>}<span className="conversation-crumb-title">{title}</span></span>
}

function EmptyConversation({ connected, hasRuntime, hasAgent, runtimeReady, runtimeStatus, accent, mood, agentName, look, onNewSession, onCreate, onRefresh }: { connected: boolean; hasRuntime: boolean; hasAgent: boolean; runtimeReady: boolean; runtimeStatus?: string; accent: string; mood: BlobMood; agentName: string; look: BlobLook | null; onNewSession: (anchor?: HTMLElement | null) => void; onCreate: () => void; onRefresh: () => void }) {
  const noun = useEntityNoun()
  const canvas = hasAgent ? <BlobCanvas color={accent} size={128} mood={connected ? mood : 'offline'} effectOverscanTop={135} look={look} label={agentName} /> : <BlobCanvas color="#e6e9ee" size={128} mood={connected ? 'idle' : 'offline'} effectOverscanTop={135} label="Bitbots" />
  const needsRuntimeRecovery = hasAgent && !runtimeReady
  const heading = !connected ? 'Connect to your local runtime' : needsRuntimeRecovery ? 'Coding agent needs attention' : hasAgent ? `Start a conversation with ${agentName}` : hasRuntime ? `Create your first ${noun}` : 'Find your coding agent'
  const description = !connected ? 'Bitbots keeps its daemon and agent sessions on this device. Reconnect to load the latest state.' : needsRuntimeRecovery ? runtimeStatus === 'error' ? 'Update or repair this CLI in Settings → Coding agents, then scan again.' : 'This coding agent is offline. Open Settings → Coding agents and scan again before starting a conversation.' : hasAgent ? 'It works in this bot’s project. Your coding agent starts when you send the first message.' : hasRuntime ? `A ${noun} is a teammate that runs on one of the coding agents installed here. Give it a name and a project, and it is ready to work.` : 'We only show agents installed on this device. Refresh to scan for Claude Code, Codex, or OpenCode.'
  const label = !connected ? 'Try again' : needsRuntimeRecovery ? 'Scan again' : hasAgent ? 'New conversation' : hasRuntime ? `Create your first ${noun}` : 'Scan for agents'
  return <div className="empty-conversation"><PixelClouds className="empty-clouds" /><div className="empty-art">{canvas}</div><h1>{heading}</h1><p className="empty-description">{description}</p><button className="primary-button" onClick={(event) => { if (!connected || needsRuntimeRecovery || !hasAgent && !hasRuntime) onRefresh(); else if (hasAgent) onNewSession(event.currentTarget); else onCreate() }} disabled={!connected && !hasRuntime}>{!hasAgent && hasRuntime && connected ? <Plus size={15} /> : <FolderOpen size={15} />}{label}</button></div>
}

/** Your own message, with @mentions of team blobs shown as their avatar and name in their colour. */
function UserMessageText({ text, agents, references, onOpenReference }: { text: string; agents: readonly Agent[]; references?: Array<{ id: string; title: string }> | null; onOpenReference?: (sessionId: string) => void }) {
  type Segment = { text: string; agent?: Agent; reference?: { id: string; title: string } }
  const segments: Segment[] = splitReferences(text, references).flatMap((part): Segment[] => part.reference ? [part] : splitMentions(part.text, agents))
  if (!segments.some((segment) => segment.agent || segment.reference)) return <SafeMessageText text={text} />
  return <p className="message-mentions">{segments.map((segment, index) => segment.reference
    ? <button key={index} type="button" className="conversation-ref" title="Open this side conversation" onClick={() => onOpenReference?.(segment.reference!.id)}><Hash size={12} aria-hidden="true" />{segment.reference.title}</button>
    : segment.agent
    ? <span key={index} className="mention" style={{ ['--mention' as string]: agentColorHex(segment.agent.color) }} title={`@${segment.agent.name}`}>
        <BlobCanvas decorative color={agentColorHex(segment.agent.color)} size={18} mood="idle" look={agentLook(segment.agent)} label={segment.agent.name} />{segment.agent.name}
      </span>
    : <span key={index}><SafeMarkdownInline text={segment.text} onOpenLink={(url) => void openSafeLink(url)} /></span>)}</p>
}

function MessageItem({ id, message, accent, agentName, showAvatar, mood, agents = [], onOpenReference, sourceSessionId, sourceMessages = [], onJumpToMessage, onContextMenu, onToggleReaction }: { id: string; message: Record<string, unknown>; accent: string; agentName: string; showAvatar: boolean; mood: BlobMood; agents?: readonly Agent[]; onOpenReference?: (sessionId: string) => void; sourceSessionId: string; sourceMessages?: Array<Record<string, unknown>>; onJumpToMessage: (sessionId: string, messageId: string) => void; onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void; onToggleReaction?: (emoji: string) => void }) {
  const isUser = isUserMessage(message)
  const role = String(message.role ?? message.kind ?? 'assistant').toLowerCase()
  const text = typeof message.text === 'string' ? message.text : typeof message.content === 'string' ? message.content : typeof message.delta === 'string' ? message.delta : ''
  const toolName = typeof message.toolName === 'string' ? message.toolName : typeof message.tool === 'string' ? message.tool : undefined
  const eventType = typeof message.eventType === 'string' ? message.eventType : ''
  const isTool = Boolean(toolName) || eventType.startsWith('tool.') || eventType.startsWith('command.')
  const isError = message.status === 'error' || role === 'error' || eventType === 'turn.error'
  const meta = message.meta && typeof message.meta === 'object' ? message.meta as Record<string, unknown> : {}
  const rawReply = meta.replyTo && typeof meta.replyTo === 'object' ? meta.replyTo as Record<string, unknown> : null
  const replyTarget = rawReply && typeof rawReply.messageId === 'string' && typeof rawReply.sourceSessionId === 'string' && typeof rawReply.author === 'string' && typeof rawReply.excerpt === 'string'
    ? { messageId: rawReply.messageId, sourceSessionId: rawReply.sourceSessionId, author: rawReply.author, excerpt: rawReply.excerpt }
    : null
  const replyAvailable = !!replyTarget && replyTarget.sourceSessionId === sourceSessionId && sourceMessages.some((candidate) => candidate.id === replyTarget.messageId)
  const time = typeof message.createdAt === 'string' ? new Date(message.createdAt) : null
  const stamp = time && !Number.isNaN(time.valueOf()) ? <time>{time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time> : null
  return <article id={id} tabIndex={-1} className={`message-row ${isUser ? 'user' : 'agent'} ${showAvatar ? 'group-start' : ''}`} aria-label={isUser ? 'You' : agentName} data-mood={isError ? 'error' : mood} data-accent={accent || undefined} onContextMenu={onContextMenu}>
    <div className="message-content">
      {replyTarget && <ReplyContextStrip target={replyTarget} compact available={replyAvailable} onJump={onJumpToMessage} />}
      {isUser && <MessageAttachments attachments={message.attachments} />}
      <div className="message-bubble-wrap">{isTool ? <div className={`activity-card ${isError ? 'error' : ''}`}><div className="activity-heading"><Terminal size={14} /><strong>{labelize(toolName ?? eventType.replace('.', ' '))}</strong><span>{isError ? 'Failed' : formatUnknownSafe(String(message.status ?? ''), 'Activity')}</span></div><p>{text || (typeof message.command === 'string' ? message.command : typeof message.summary === 'string' ? message.summary : 'Details are unavailable for this event.')}</p>{typeof message.path === 'string' && <code>{message.path}</code>}</div> : text || !(isUser && Array.isArray(message.attachments) && message.attachments.length) ? <div className={`message-bubble ${isError ? 'message-error' : ''}`}>{isUser && text ? <UserMessageText text={text} agents={agents} references={Array.isArray(message.references) ? message.references as Array<{ id: string; title: string }> : null} onOpenReference={onOpenReference} /> : <SafeMessageText text={text || 'Message content unavailable.'} />}</div> : null}
      <MessageReactionBadges reactions={message.reactions} onRemove={onToggleReaction} /></div>
      {stamp && <div className="message-time">{stamp}</div>}
    </div>
  </article>
}

type PendingSend = { id: string; sessionId: string; text: string; attachments: number; at: number }

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

/** Local clock time of a message, for the hover toolbar. */
function messageClock(value: unknown) {
  if (typeof value !== 'string') return undefined
  const time = new Date(value)
  return Number.isNaN(time.valueOf()) ? undefined : time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function storageFlag(key: string) {
  try { return localStorage.getItem(key) === '1' } catch { return false }
}

function readStoredAgentId() {
  if (previewMode && new URLSearchParams(location.search).get('preset') === 'message-links') return 'agent-codex'
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

/** A fresh snapshot has no queues; keep the ones the daemon already told us about. */
function carryQueues(next: Snapshot, previous: Snapshot | null | undefined): Snapshot {
  if (!previous?.queues) return next
  return { ...next, queues: { ...previous.queues, ...next.queues } }
}

/**
 * The one selection to make after a conversation disappears: the same blob's
 * next conversation, else the next visible blob's, else the first visible blob.
 * A blob with no conversation at all is still returned, with a null session.
 */
function nextSelectionAfterRemoval(sessions: readonly Session[], agents: readonly Agent[], ownerId: string | null): { agentId: string; sessionId: string | null } | null {
  const active = activeAgents(agents)
  if (!active.length) return null
  const owner = ownerId ? active.find((agent) => agent.id === ownerId) ?? null : null
  if (owner) {
    const same = mainSessionFor(sessions, owner.id)
    if (same) return { agentId: owner.id, sessionId: same.id }
  }
  const start = owner ? active.findIndex((agent) => agent.id === owner.id) : -1
  const ordered = start >= 0 ? [...active.slice(start + 1), ...active.slice(0, start + 1)] : active
  for (const agent of ordered) {
    if (owner && agent.id === owner.id) continue
    const session = mainSessionFor(sessions, agent.id)
    if (session) return { agentId: agent.id, sessionId: session.id }
  }
  const fallback = owner ?? ordered[0]
  return fallback ? { agentId: fallback.id, sessionId: null } : null
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
    contextModel: fullSession.contextModel === undefined ? existing.contextModel : fullSession.contextModel,
    contextEstimated: fullSession.contextEstimated === undefined ? existing.contextEstimated : fullSession.contextEstimated,
  }
  return { ...snapshot, sessions: [...sessions.filter((session) => session.id !== id), merged] }
}

function ActivityItem({ item, onDiff, runtime, onSignedIn }: { item: ConversationItem; onDiff?: (path: string, content: string) => void; runtime?: Runtime | null; onSignedIn?: () => void }) {
  const activity = item.activity ?? {}
  const file = item.activityKind === 'file'
  const failed = ['error', 'failed', 'rejected'].includes(String(activity.state ?? activity.status ?? '').toLowerCase()) || item.activityKind === 'turn'
  const rawTurnDetail = String(activity.summary ?? activity.detail ?? activity.output ?? activity.command ?? '')
  const friendly = item.activityKind === 'turn' ? friendlyError({ ...(typeof activity.failureClass === 'string' ? { code: activity.failureClass } : {}), message: rawTurnDetail }) : null
  const title = friendly ? friendly.title : file ? labelize(activity.operation, 'File change') : formatUnknownSafe(activity.title, formatUnknownSafe(activity.kind, 'Agent activity'))
  const detail = friendly ? '' : file ? String(activity.path ?? 'Changed file') : String(activity.command ?? activity.summary ?? activity.detail ?? activity.output ?? '')
  const timeValue = activity.completedAt ?? activity.startedAt ?? activity.createdAt
  const time = typeof timeValue === 'string' ? new Date(timeValue) : null
  return <article className={`activity-card timeline-activity ${failed ? 'error' : ''}`}>
    <div className="activity-heading">{file ? <FileText size={15} /> : <Terminal size={15} />}<strong>{title}</strong><span>{labelize(activity.state ?? activity.status, file ? 'Reported' : 'Activity')}</span>{time && !Number.isNaN(time.valueOf()) && <time>{time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}</div>
    {friendly?.detail && <p>{friendly.detail}</p>}
    {friendly?.action?.kind === 'sign-in' && runtime && <SignInHelp provider={runtime.provider} runtimeId={runtime.id} onChecked={onSignedIn} />}
    {detail && <p>{detail}</p>}
    {typeof activity.exitCode === 'number' && <small>Exit code {activity.exitCode}</small>}
    {typeof activity.diff === 'string' && <button type="button" className="ghost-button small activity-diff-button" onClick={() => onDiff?.(String(activity.path ?? activity.filePath ?? activity.title ?? 'Reported change'), activity.diff as string)}>View reported diff</button>}
    {typeof activity.output === 'string' && activity.output !== detail && <details className="activity-detail"><summary>Output</summary><pre>{activity.output}</pre></details>}
    {item.activityKind === 'turn' && rawTurnDetail && rawTurnDetail !== friendly?.detail && <details className="activity-detail"><summary>Details</summary><pre>{rawTurnDetail}</pre></details>}
  </article>
}

function SafeMessageText({ text }: { text: string }) {
  return <SafeMarkdown text={text} onOpenLink={(url) => void openSafeLink(url)} />
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
    <div className="usage-block-heading quota-heading"><h3>Plan usage limits</h3><span className="usage-divider" aria-hidden="true" /><span className="usage-provenance">Reported by each CLI account</span><Tip text="Each coding agent reports its own plan limits from its signed-in account. Token counts describe recorded activity; plan limits are a separate account quota." describe><button type="button" className="icon-button usage-info-button" aria-label="About plan usage limits"><Info size={14} /></button></Tip><button type="button" className="icon-button usage-refresh-button" aria-label="Refresh plan usage" title="Refresh plan usage" onClick={onRefresh} disabled={refreshing}><RefreshCw size={14} className={refreshing ? 'spinning' : ''} /></button></div>
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
    })}</div> : <p className="usage-empty-line">No account quota source available.</p>}
  </section>
}

export function UsageSheet({ summary, period, quotas, loading, quotaRefreshing, onRefreshQuota, onPeriodChange, onOpenHistory, onClose }: { summary: Record<string, unknown> | null; period: 'today' | 'month'; quotas: Record<string, unknown>[]; loading: boolean; quotaRefreshing: boolean; onRefreshQuota: () => void; onPeriodChange: (period: 'today' | 'month') => void; onOpenHistory: () => void; onClose: () => void }) {
  const { ref: dialogRef, close } = useDialogAccessibility(onClose)
  const tokenBuckets = summary ? usageTokenBuckets(summary) : []
  return <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}><section ref={dialogRef} className="usage-sheet" role="dialog" aria-modal="true" aria-labelledby="usage-title">
    <header><div><p className="eyebrow">USAGE</p><h2 id="usage-title">Usage summary</h2><small className="usage-scope">All runtimes on this device</small></div><button className="icon-button" data-dialog-initial-focus aria-label="Close usage summary" onClick={close}><X size={17} /></button></header>
    <div className="usage-sheet-body">
      <QuotaDetails quotas={quotas} refreshing={quotaRefreshing} onRefresh={onRefreshQuota} />
      <section className="usage-block">
        <div className="usage-block-heading"><h3>Token usage</h3><span>{summary && typeof summary.from === 'string' && typeof summary.to === 'string' ? `${shortDate(summary.from)} – ${shortDate(summary.to)}` : 'Recorded activity'}</span></div>
        <div className="usage-period-switch" aria-label="Usage date range"><button className={period === 'today' ? 'active' : ''} aria-pressed={period === 'today'} onClick={() => onPeriodChange('today')}>Today</button><button className={period === 'month' ? 'active' : ''} aria-pressed={period === 'month'} onClick={() => onPeriodChange('month')}>This month</button></div>
        {loading ? <div className="sheet-loading" role="status" aria-busy="true"><Skeleton variant="row" lines={4} /><span className="sr-only">Loading the daemon summary…</span></div> : summary ? tokenBuckets.every((bucket) => bucket.value === 'N/A') ? <p className="usage-empty-line" data-usage-empty>No usage yet {period === 'today' ? 'today' : 'this month'}.</p> : <div className="usage-token-grid">{tokenBuckets.map((bucket) => <div className="usage-token" key={bucket.key}><span>{bucket.label}</span><strong>{bucket.value}</strong></div>)}</div> : <div className="sheet-empty"><CircleHelp size={20} /><strong>Usage summary unavailable</strong><p>The daemon did not return token usage for this period.</p></div>}
      </section>
    </div>
    <footer><button type="button" className="secondary-button small" onClick={onOpenHistory}>Usage history</button></footer>
  </section></div>
}

function shortDate(value: unknown) {
  if (typeof value !== 'string') return 'unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function recordFrom(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }

/** How long a press on the companion's name area waits before it becomes a drag, and how far it may wander first. */
const COMPACT_HOLD_TO_DRAG_MS = 220
const COMPACT_DRAG_SLOP_PX = 4

function Companion({ deliveryNotice, busyMode = 'steer', steerAvailable = false, agent, agents, projects = [], sessions = [], quotas = [], onSessionUpdated, onError, chatSize = 'medium', pinned = [], activityDetails = false, speechEnabled = true, speechModel = DEFAULT_SPEECH_MODEL_ID, usageTip, onDismissUsageTip, onChatSizeChange, onPinnedChange, runtime, runtimes, session, usage, connected, appError, reconnectAttempts = 0, reconnectFailed = false, onRetryConnection, activityLabel, permission, approvalMode, onReply, onAnswerQuestion, onNewSession, onOpenMain, onOpenSession, onOpenSettings, onSendPrompt, onCancelTurn, onSelectAgent, onSelectConversation, queuedCount = 0, onLoadQueue, permissionQueue = [], onPickPermission, onSnoozePermission, onToggleReaction, slashSkills = [] }: { deliveryNotice?: string | null; busyMode?: BusySendMode; steerAvailable?: boolean; agent: Agent | null; agents: Agent[]; projects?: Project[]; sessions?: Session[]; quotas?: Record<string, unknown>[]; onSessionUpdated?: (session: Session) => void; onError?: (reason: unknown) => void; chatSize?: CompanionChatSize; pinned?: string[]; activityDetails?: boolean; speechEnabled?: boolean; speechModel?: string; usageTip?: UsageTipModel | null; onDismissUsageTip?: (tip: UsageTipModel) => void; onChatSizeChange?: (size: CompanionChatSize) => void; onPinnedChange?: (ids: string[]) => void; runtime: Runtime | null; runtimes: Runtime[]; session: Session | null; usage?: Record<string, unknown>; connected: boolean; appError: string | null; reconnectAttempts?: number; reconnectFailed?: boolean; onRetryConnection?: () => void; activityLabel: string; permission?: PermissionRequest; approvalMode: ReturnType<typeof effectiveApprovalMode>; onReply: (permission: PermissionRequest, choice: string) => boolean | void | Promise<boolean | void>; onAnswerQuestion?: (permission: PermissionRequest, answers: Record<string, string[]> | null) => Promise<unknown> | void; onNewSession: (anchor?: HTMLElement | null) => void; onOpenMain: () => void; onOpenSession?: (sessionId: string) => void; onOpenSettings: (page?: SettingsPageId) => void; onSendPrompt: (sessionId: string, text: string, command?: SlashCommand | null, opposite?: boolean, hasContext?: boolean) => Promise<unknown>; onCancelTurn: (sessionId: string) => Promise<unknown>; queuedCount?: number; onLoadQueue?: (sessionId: string) => void; onSelectAgent: (agent: Agent) => void; onSelectConversation?: (session: Session) => void; permissionQueue?: PermissionRequest[]; onPickPermission?: (id: string) => void; onSnoozePermission?: (id: string) => void; onToggleReaction?: (sessionId: string, messageId: string, emoji: string) => Promise<unknown> | void; slashSkills?: SlashSkill[] }) {
  const sessionModelLock = session?.modelLock
  const nouns = useEntityNoun({ plural: true })
  const platform = usePlatform()
  const contextModel = sessionModelLock && Object.prototype.hasOwnProperty.call(sessionModelLock, 'model')
    ? sessionModelLock.model ?? null
    : agent?.model ?? null
  const contextQuota = runtime ? quotas.find((item) => item.provider === runtime.provider) ?? null : null
  // The browser preview can open a view directly: /?companion&mode=home&view=chat.
  const previewParams = previewMode ? new URLSearchParams(location.search) : null
  const [view, setView] = useState<'overview' | 'chat' | 'activity' | 'settings'>(() => {
    const requested = previewParams?.get('view')
    return requested === 'chat' || requested === 'activity' || requested === 'settings' ? requested : 'overview'
  })
  const [draft, setDraft] = useState('')
  const draftRef = useRef<HTMLTextAreaElement>(null)
  useAutosizeTextarea(draftRef, draft, 132)
  const [slash, setSlash] = useState<{ start: number; query: string; index: number } | null>(null)
  const [slashCommand, setSlashCommand] = useState<SlashCommand | null>(null)
  const [dictationPartial, setDictationPartial] = useState('')
  const [sending, setSending] = useState(false)
  const [confused, setConfused] = useState(false)
  const [dropPhase, setDropPhase] = useState<DropPhase>('idle')
  const dropActive = dropZoneActive(dropPhase)
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [dragSize, setDragSize] = useState<number | null>(null)
  const [focusMode, setFocusMode] = useState(DEFAULT_FOCUS_MODE)
  const [peek, setPeek] = useState<Peek | null>(null)
  const [chatWindow, setChatWindow] = useState(8)
  const [showNewMessages, setShowNewMessages] = useState(false)
  const [startPosition, setStartPosition] = useState<'launch' | 'last'>('launch')
  const [droppedFile, setDroppedFile] = useState<string | null>(null)
  const [fileInfo, setFileInfo] = useState<{ path: string; fileName: string; sizeBytes: number } | null>(null)
  const [preparingFile, setPreparingFile] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [soundsEnabled, setSoundsEnabled] = useState(false)
  const [soundVolume, setSoundVolume] = useState(DEFAULT_SOUND_VOLUME)
  const [soundError, setSoundError] = useState<string | null>(null)
  const [dropError, setDropError] = useState<string | null>(null)
  // The shared error line (appError / fileError / dropError) can be dismissed,
  // and clears itself after 8 seconds while the daemon is reachable.
  const [dismissedError, setDismissedError] = useState<string | null>(null)
  const [dictationSurface, setDictationSurface] = useState<'bubble' | 'companion' | 'none'>('none')
  const [dictationPhase, setDictationPhase] = useState<'idle' | IslandPhase>('idle')
  const [dictationError, setDictationError] = useState('')
  const [dictationLevel, setDictationLevel] = useState(0)
  const [dictationEngine, setDictationEngine] = useState<DictationEngineInfo | null>(null)
  const [dictationWarming, setDictationWarming] = useState(false)
  const [dictationFinals, setDictationFinals] = useState('')
  const [dictationClock, setDictationClock] = useState<{ since: number | null; stoppedAt: number | null }>({ since: null, stoppedAt: null })
  const dictationHeard = useRef(false)
  const fileRequest = useRef(0)
  const viewBeforeConfused = useRef<typeof view>('overview')
  const viewBeforeDrop = useRef<typeof view>('overview')
  const dropLeaveTimer = useRef<number | null>(null)
  const dragPathRef = useRef<string | null>(null)
  const previousPeekStates = useRef<PeekSessionState[]>([])
  const chatAnchor = useRef<{ id: string; delta: number } | null>(null)
  const stickToBottom = useRef(true)
  const dropPhaseRef = useRef(dropPhase)
  const viewRef = useRef(view)
  const droppedFileRef = useRef(droppedFile)
  const permissionRef = useRef(permission)
  const sessionRef = useRef(session)
  const dictationSurfaceRef = useRef<'bubble' | 'companion' | 'none'>('none')
  dropPhaseRef.current = dropPhase
  viewRef.current = view
  droppedFileRef.current = droppedFile
  permissionRef.current = permission
  sessionRef.current = session
  dictationSurfaceRef.current = dictationSurface
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
  /** One-time drag hint, shown the first time the companion is expanded. */
  const [dragHintSeen, markDragHintSeen] = useHintSeen('companion.drag')
  if (!fsmRef.current) fsmRef.current = new CompanionFsm()
  // Chat, activity, settings and inline questions use the taller island; approvals keep the overview size.
  const tall = mode === 'home' && (permission ? true : (view === 'chat' || view === 'activity' || view === 'settings'))
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
    void listenNative<boolean>('bloblex-companion-visible-changed', (payload) => {
      if (!payload) return
      setPopIn(true)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setPopIn(false), 240)
    }).then((stop) => { if (cancelled) stop(); else unlisten = stop })
    return () => { cancelled = true; unlisten?.(); window.clearTimeout(timer) }
  }, [])
  useEffect(() => { void setCompanionMode(presentation, undefined, COMPANION_CHAT_SIZES[chatSize]) }, [presentation, chatSize])
  // Sounds for the island's own moments: it peeks in, opens, closes, and pops on a new reply.
  const previousMode = useRef(mode)
  useEffect(() => {
    if (previousMode.current === 'petit' && mode === 'home') playCompanionCue('open')
    else if (previousMode.current === 'home' && mode === 'petit') playCompanionCue('close')
    previousMode.current = mode
  }, [mode])
  useEffect(() => { if (popIn) playCompanionCue('peek') }, [popIn])
  // C7: completion peek. Watch each bot's main conversation for a busy -> idle
  // edge; the focused bot and failed turns are excluded by the pure helper.
  const peekStates: PeekSessionState[] = agents.map((item) => ({ id: item.id, state: mainSessionFor(sessions, item.id)?.state }))
  const peekKey = peekStates.map((item) => `${item.id}:${item.state ?? ''}`).join('|')
  useEffect(() => {
    const finished = detectFinished(previousPeekStates.current, peekStates, agent?.id)
    previousPeekStates.current = peekStates
    if (!finished.length || focusMode || mode !== 'petit') return
    setPeek((current) => nextPeek(current, finished, Date.now()))
  }, [peekKey, focusMode, mode, agent?.id])
  // The peek plays the soft cue once and returns to the status line after 4 s.
  useEffect(() => {
    if (!peek) return
    playCompanionCue('blip')
    const timer = window.setTimeout(() => setPeek((current) => (current === peek ? null : current)), PEEK_VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [peek?.ids.join(','), peek?.at])
  // C7: Focus mode is one shared value across the island and the Settings sheet.
  useEffect(() => {
    const unsubscribe = subscribeFocusMode(setFocusMode)
    let cancelled = false
    let unlisten: (() => void) | undefined
    let received = false
    void listenNative<boolean>(FOCUS_MODE_CHANGED_EVENT, (payload) => { received = true; applyFocusMode(payload === true) }).then((stop) => {
      if (cancelled) { stop(); return }
      unlisten = stop
      return rpc<Record<string, unknown>>('settings.get').then((result) => {
        const value = focusModeFromSettings(result)
        applyFocusMode(value)
        if (!cancelled && !received) setFocusMode(value)
      }).catch(() => undefined)
    })
    return () => { cancelled = true; unsubscribe(); unlisten?.() }
  }, [])
  useEffect(() => { if (focusMode) setPeek(null) }, [focusMode])
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
  // C5: peer-grid keyboard access, live only while this companion window has
  // focus (its own document), and never while the person is typing.
  const waitingCursor = useRef(-1)
  useEffect(() => {
    const peers = () => [...document.querySelectorAll<HTMLButtonElement>('.peer-grid .peer')]
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && /^[1-4]$/.test(event.key)) {
        const peer = peers()[Number(event.key) - 1]
        if (!peer) return
        event.preventDefault()
        peer.focus()
        return
      }
      if (!event.ctrlKey && !event.altKey && !event.metaKey && (event.key === 'n' || event.key === 'N')) {
        const waiting = peers().map((peer, index) => ({ peer, index })).filter(({ peer }) => peer.classList.contains('state-waiting'))
        if (!waiting.length) return
        const next = waiting.find(({ index }) => index > waitingCursor.current) ?? waiting[0]!
        waitingCursor.current = next.index
        event.preventDefault()
        next.peer.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
  useEffect(() => {
    if (!inDesktop) return
    let unlisten: (() => void) | undefined
    let cancelled = false
    const openForDrop = () => { if (!permissionRef.current) { setView('chat'); fsmRef.current?.forceHome() } }
    const collapseForLeave = () => {
      setDropPhase('idle')
      setDragPath(null)
      dragPathRef.current = null
      setDragSize(null)
      if (!droppedFileRef.current && !permissionRef.current) {
        setDropError(null)
        setView(viewBeforeDrop.current)
        fsmRef.current?.forcePetit()
      }
    }
    void currentWindow().onDragDropEvent(({ payload }) => {
      if (payload.type === 'enter') {
        const path = payload.paths?.[0] ?? null
        dragPathRef.current = path
        setDragPath(path)
        setDragSize(null)
        // C12: a drag that dips out and back in within the grace period must not
        // collapse and re-expand, so cancel any pending collapse.
        if (dropLeaveTimer.current) { window.clearTimeout(dropLeaveTimer.current); dropLeaveTimer.current = null }
        setDropError(null)
        setFileError(null)
        const wasIdle = dropPhaseRef.current === 'idle'
        if (wasIdle) viewBeforeDrop.current = viewRef.current
        setDropPhase((phase) => advanceDropZone(phase, 'enter'))
        if (wasIdle) openForDrop()
        if (path) void inspectLocalFile(path).then((info) => { if (dragPathRef.current === path) setDragSize(info.sizeBytes) }).catch(() => undefined)
      } else if (payload.type === 'over') {
        setDropPhase((phase) => advanceDropZone(phase, 'enter'))
      } else if (payload.type === 'leave') {
        setDropPhase((phase) => advanceDropZone(phase, 'leave'))
        if (dropLeaveTimer.current) window.clearTimeout(dropLeaveTimer.current)
        dropLeaveTimer.current = window.setTimeout(() => { dropLeaveTimer.current = null; collapseForLeave() }, DROP_LEAVE_GRACE_MS)
      } else if (payload.type === 'drop') {
        if (dropLeaveTimer.current) { window.clearTimeout(dropLeaveTimer.current); dropLeaveTimer.current = null }
        setDropPhase('idle')
        const path = payload.paths?.[0] ?? dragPathRef.current
        dragPathRef.current = null
        setDragPath(null)
        setDragSize(null)
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
    return () => { cancelled = true; if (dropLeaveTimer.current) window.clearTimeout(dropLeaveTimer.current); unlisten?.() }
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
  const chatSessionRef = useRef(session?.id)
  useLayoutEffect(() => {
    const log = chatLogRef.current
    if (!log) return
    if (chatSessionRef.current !== session?.id) {
      chatSessionRef.current = session?.id
      stickToBottom.current = true
      setShowNewMessages(false)
      setChatWindow(8)
    }
    // C10: follow new content only while the person is at the bottom; otherwise
    // keep their place and offer the "New messages" pill.
    if (stickToBottom.current) { log.scrollTop = log.scrollHeight }
    else if (view === 'chat') setShowNewMessages(true)
  }, [view, session?.id, session?.messages?.length, session?.state])
  // C10: revealing earlier messages keeps the first visible one in place.
  useLayoutEffect(() => {
    const log = chatLogRef.current
    const anchor = chatAnchor.current
    if (!log || !anchor) return
    chatAnchor.current = null
    const node = [...log.querySelectorAll<HTMLElement>('[data-companion-message-id]')].find((item) => item.getAttribute('data-companion-message-id') === anchor.id)
    if (node) log.scrollTop = node.offsetTop - anchor.delta
  }, [chatWindow])
  useLayoutEffect(() => {
    const root = capsuleRef.current
    if (root) stampCompanionDragRegions(root)
  })
  const toggleExpanded = () => { if (mode === 'home') fsmRef.current?.forcePetit(); else fsmRef.current?.click() }
  const openView = (next: typeof view) => { if (next !== view) playCompanionCue('blip'); setView(next); setSideId(null); if (mode !== 'home') fsmRef.current?.forceHome() }
  // The name area is a button (keyboard access, FIX20) that still drags the island:
  // press and move, or press and hold, starts a window drag; a plain click opens home.
  const compactPress = useRef<{ x: number; y: number; timer: number; dragged: boolean } | null>(null)
  const startCompactDrag = () => {
    const press = compactPress.current
    if (!press || press.dragged) return
    press.dragged = true
    window.clearTimeout(press.timer)
    void currentWindow().startDragging().catch(() => undefined)
  }
  const compactDrag = {
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return
      if (compactPress.current) window.clearTimeout(compactPress.current.timer)
      compactPress.current = { x: event.clientX, y: event.clientY, timer: window.setTimeout(startCompactDrag, COMPACT_HOLD_TO_DRAG_MS), dragged: false }
    },
    onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => {
      const press = compactPress.current
      if (press && !press.dragged && (event.buttons & 1) && Math.hypot(event.clientX - press.x, event.clientY - press.y) > COMPACT_DRAG_SLOP_PX) startCompactDrag()
    },
    onPointerUp: () => { if (compactPress.current) window.clearTimeout(compactPress.current.timer) },
    onPointerCancel: () => { if (compactPress.current) window.clearTimeout(compactPress.current.timer); compactPress.current = null },
    /** True (once) when the press that ends in this click was a drag. */
    consumeDrag: () => { const dragged = !!compactPress.current?.dragged; compactPress.current = null; return dragged },
  }
  // A conversation between two bots opens here in the companion, not in the main window.
  const [sideId, setSideId] = useState<string | null>(null)
  const sideSession = sideId ? sessions.find((item) => item.id === sideId) ?? null : null
  useEffect(() => { setSideId(null) }, [agent?.id])
  const openSide = (sessionId: string) => {
    if (view !== 'chat') openView('chat')
    setSideId(sessionId)
    const known = sessions.find((item) => item.id === sessionId)
    if (!known || !Array.isArray(known.messages)) void rpc<Session>('session.get', { sessionId }).then((full) => { if (full?.id) onSessionUpdated?.(full) }).catch(() => undefined)
  }
  // Ctrl+E reaches the companion while it is on screen. With the chat open its
  // dictation button handles it; otherwise open the chat and start there.
  const [dictateOnOpen, setDictateOnOpen] = useState(false)
  const chatOpenRef = useRef(false)
  chatOpenRef.current = mode === 'home' && view === 'chat' && !permission
  const openViewRef = useRef(openView)
  openViewRef.current = openView
  useEffect(() => {
    if (!isNative() || !speechEnabled) return
    let unlisten: (() => void) | undefined
    let cancelled = false
    void currentWebviewWindow().listen('bloblex-dictation-toggle', () => {
      if (chatOpenRef.current) return
      openViewRef.current('chat')
      setDictateOnOpen(true)
    }).then((stop) => { if (cancelled) stop(); else unlisten = stop }).catch(() => undefined)
    return () => { cancelled = true; unlisten?.() }
  }, [speechEnabled])
  const selectTeamBlob = (item: Agent) => { if (item.id !== agent?.id) playCompanionCue('blip'); onSelectAgent(item) }
  const replyToPermission = (request: PermissionRequest, choice: string) => { if (/allow|approve|accept|yes/i.test(choice)) playCompanionCue('approve'); return onReply(request, choice) }
  const focusTeam = teamLine(agent, agents, sessions)
  const focusSteps = sessionSteps(session)
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
  const sendCompanionPrompt = async (event: React.FormEvent | React.KeyboardEvent, opposite = false) => {
    event.preventDefault()
    if (!session || sending || !connected || !runtimeUsable(runtime) || session.state === 'waiting_permission') return
    const requested = draft.trim() || (droppedFile ? 'Please inspect this local file.' : '')
    if (!requested) return
    const sentCommand = slashCommand ?? leadingCommand(requested, { skills: slashSkills, isManager: agent?.systemRole === 'manager' })
    const body = sentCommand && slashCommand ? commandMessage(sentCommand, requested) : requested
    const prompt = droppedFile && fileInfo ? `${body}\n\nLocal file reference selected by the user: ${fileInfo.fileName} (${fileInfo.path}, ${formatBytes(fileInfo.sizeBytes)}). File contents were not read by Bitbots. The provider may only access this path if its own process permissions and working directory allow it.` : body
    // The draft clears at once; the composer stays usable while the daemon confirms.
    const sentDraft = draft
    setSending(true)
    setDropError(null)
    setDraft('')
    setSlash(null)
    setSlashCommand(null)
    playCompanionCue('send')
    try { await onSendPrompt(session.id, prompt, sentCommand, opposite, !!droppedFile); setDroppedFile(null); setFileInfo(null); setFileError(null) }
    catch (reason) {
      if (!draftRef.current?.value.trim()) { setDraft(sentDraft); setSlashCommand(slashCommand) }
      if (fileInfo) setFileError(messageOf(reason)); else setDropError(messageOf(reason))
    }
    finally { setSending(false) }
  }
  const companionSlashCandidates = slash ? slashItems(slash.query, { skills: slashSkills, isManager: agent?.systemRole === 'manager', actions: COMPANION_SLASH_ACTIONS }) : []
  const pickCompanionSlash = (item: SlashItem) => {
    const caret = draftRef.current?.selectionStart ?? draft.length
    const token = slash
    const withoutToken = token ? `${draft.slice(0, token.start)}${draft.slice(Math.min(caret, token.start + 1 + token.query.length))}` : draft
    setSlash(null)
    if (item.kind === 'action') {
      setDraft(withoutToken)
      if (item.action === 'new') onNewSession(null)
      else if (item.action === 'model' || item.action === 'effort') requestExecutionPicker(item.action)
      requestAnimationFrame(() => draftRef.current?.focus())
      return
    }
    setSlashCommand({ kind: item.kind, name: item.name })
    setDraft(withoutToken)
    requestAnimationFrame(() => draftRef.current?.focus())
  }
  useEffect(() => { if (session?.id) onLoadQueue?.(session.id) }, [session?.id]) // eslint-disable-line react-hooks/exhaustive-deps
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
    void saveSoundsEnabled(enabled)
      .then(() => { setSoundError(null) })
      .catch((reason) => { setSoundsEnabled(!enabled); setCompanionSoundsEnabled(!enabled); setSoundError(messageOf(reason)) })
  }
  // One short cue at the new level, so the slider is judged by ear. It is only
  // heard when sounds are on and audio is already unlocked by a gesture.
  const previewVolume = () => { void unlockCompanionAudioFromGesture().then((unlocked) => { if (unlocked) playCompanionCue('blip') }) }
  const changeSoundVolume = (volume: number) => { setSoundVolume(volume); setCompanionSoundVolume(volume) }
  const savedSoundVolume = useRef(DEFAULT_SOUND_VOLUME)
  const commitSoundVolume = (volume: number) => {
    changeSoundVolume(volume)
    previewVolume()
    void saveSoundVolume(volume)
      .then(() => { savedSoundVolume.current = volume; setSoundError(null) })
      .catch((reason) => { changeSoundVolume(savedSoundVolume.current); setSoundError(messageOf(reason)) })
  }
  // C7: Focus mode silences the peeks; approvals and questions always show.
  const toggleFocusMode = () => {
    const enabled = !focusMode
    setFocusMode(enabled)
    if (enabled) setPeek(null)
    void saveFocusMode(enabled).catch((reason) => { setFocusMode(!enabled); setSoundError(messageOf(reason)) })
  }
  // C8: Reset position clears the remembered spot for this display and applies
  // the start position the person chose (centre near the bottom, unless they
  // chose "where I left it"). setCompanionMonitor already does that move.
  const resetPosition = () => {
    void (async () => {
      try {
        const monitor = await currentCompanionMonitor()
        await clearCompanionPosition(monitor)
        if (startPosition !== 'last' && monitor) await setCompanionMonitor(monitor)
      } catch (reason) { setSoundError(messageOf(reason)) }
    })()
  }
  // C7: Open on the peek selects the finished bot and expands the island.
  const openPeek = () => {
    const target = agents.find((item) => item.id === peek?.ids[0])
    setPeek(null)
    if (target) onSelectAgent(target)
    if (mode !== 'home') fsmRef.current?.forceHome()
  }
  // C10: follow the bottom only when the person is there; otherwise offer the pill.
  const onChatScroll = () => {
    stickToBottom.current = isNearBottom(metricsOf(chatLogRef.current))
    if (stickToBottom.current) setShowNewMessages(false)
  }
  const scrollChatToBottom = () => {
    const log = chatLogRef.current
    if (log) log.scrollTop = log.scrollHeight
    stickToBottom.current = true
    setShowNewMessages(false)
  }
  // C10: reveal eight earlier messages, remembering the first one on screen.
  const loadEarlier = () => {
    const log = chatLogRef.current
    const first = log?.querySelector<HTMLElement>('[data-companion-message-id]')
    chatAnchor.current = log && first ? { id: first.getAttribute('data-companion-message-id') ?? '', delta: first.offsetTop - log.scrollTop } : null
    setChatWindow((current) => current + 8)
  }

  useEffect(() => {
    const unsubscribe = subscribeSoundPrefs((prefs) => {
      setSoundsEnabled(prefs.soundsEnabled)
      setCompanionSoundsEnabled(prefs.soundsEnabled)
      savedSoundVolume.current = prefs.soundVolume
      setSoundVolume(prefs.soundVolume)
      setCompanionSoundVolume(prefs.soundVolume)
    })
    let cancelled = false
    let receivedSoundUpdate = false
    let receivedVolumeUpdate = false
    let unlisten: (() => void) | undefined
    let unlistenVolume: (() => void) | undefined
    void listenNative<{ volume?: unknown; preview?: boolean }>(SOUND_VOLUME_CHANGED_EVENT, (payload) => {
      receivedVolumeUpdate = true
      const volume = normalizeSoundVolume(payload?.volume)
      applySoundPrefs({ soundVolume: volume })
      savedSoundVolume.current = volume
      setSoundVolume(volume)
      setCompanionSoundVolume(volume)
      if (payload?.preview === true) previewVolume()
    }).then((stop) => { if (cancelled) stop(); else unlistenVolume = stop })
    void listenNative<boolean>(SOUNDS_CHANGED_EVENT, (payload) => {
      receivedSoundUpdate = true
      const enabled = payload === true
      applySoundPrefs({ soundsEnabled: enabled })
      setSoundsEnabled(enabled)
      setCompanionSoundsEnabled(enabled)
    }).then((stop) => {
      if (cancelled) { stop(); return }
      unlisten = stop
      return rpc<Record<string, unknown>>('settings.get').then((result) => {
        const settings = recordFrom(result.settings ?? result)
        const prefs = soundPrefsFromSettings(settings)
        applySoundPrefs(prefs)
        if (!cancelled && !receivedSoundUpdate) { setSoundsEnabled(prefs.soundsEnabled); setCompanionSoundsEnabled(prefs.soundsEnabled) }
        if (!cancelled && !receivedVolumeUpdate) { savedSoundVolume.current = prefs.soundVolume; setSoundVolume(prefs.soundVolume); setCompanionSoundVolume(prefs.soundVolume) }
        if (!cancelled) { setStartPosition(settings['companion.startPosition'] === 'last' ? 'last' : 'launch') }
      }).catch(() => undefined)
    })
    return () => { cancelled = true; unsubscribe(); unlisten?.(); unlistenVolume?.() }
  }, [])
  useEffect(() => {
    let disposed = false
    const unsubs: Array<() => void> = []
    const add = (unlisten: () => void) => { if (disposed) unlisten(); else unsubs.push(unlisten) }
    void (async () => {
      add(await listenNative<{ surface: string }>('bloblex-dictation-surface', (payload) => {
        const isCompanion = payload.surface === 'companion'
        setDictationSurface(isCompanion ? 'companion' : 'none')
        if (isCompanion) {
          dictationHeard.current = false
          setDictationEngine(null)
          setDictationPhase('listening'); setDictationError(''); setDictationFinals(''); setDictationWarming(false)
          setDictationClock({ since: Date.now(), stoppedAt: null })
          playDictationCue('record-start')
        }
      }))
      add(await listenNative<{ type: string; text?: string }>('bloblex-dictation', (payload) => {
        if (dictationSurfaceRef.current !== 'companion') return
        const { type, text } = payload
        if (type === 'loading') setDictationWarming(true)
        else if (type === 'loaded') setDictationWarming(false)
        else if (type === 'partial') { if (text) dictationHeard.current = true }
        else if (type === 'final') { if (text) { dictationHeard.current = true; setDictationFinals((current) => (current ? `${current} ${text}` : text)) } }
        else if (type === 'processing') { setDictationClock((clock) => ({ ...clock, stoppedAt: Date.now() })); setDictationPhase('processing'); playDictationCue('processing-start') }
        else if (type === 'stopped') {
          setDictationWarming(false)
          setDictationClock((clock) => ({ ...clock, stoppedAt: clock.stoppedAt ?? Date.now() }))
          setDictationPhase(dictationHeard.current ? 'done' : 'silent'); playDictationCue('processing-finish')
          window.setTimeout(() => { setDictationPhase('idle'); setDictationSurface('none') }, 1400)
        }
        else if (type === 'error') {
          setDictationWarming(false)
          setDictationPhase('error'); setDictationError(text || 'Dictation failed.'); playDictationCue('error')
          window.setTimeout(() => { setDictationPhase('idle'); setDictationSurface('none') }, 2400)
        }
      }))
      add(await listenNative<{ level: number }>('bloblex-dictation-level', (payload) => setDictationLevel(payload.level)))
      add(await listenNative<{ engine: DictationEngineInfo['engine']; fallback?: boolean; reason?: string | null }>('bloblex-dictation-engine', (payload) => {
        if (dictationSurfaceRef.current !== 'companion') return
        setDictationEngine({ engine: payload.engine, fallback: payload.fallback === true, reason: payload.reason ?? null })
      }))
    })().catch(() => undefined)
    return () => { disposed = true; unsubs.forEach((unlisten) => unlisten()) }
  }, [])


  const inputTokens = typeof usage?.inputTokens === 'number' ? usage.inputTokens : null
  const outputTokens = typeof usage?.outputTokens === 'number' ? usage.outputTokens : null
  const tokenGlance = inputTokens !== null && outputTokens !== null ? formatCount(inputTokens + outputTokens) : inputTokens !== null ? `${formatCount(inputTokens)} in · out ?` : outputTokens !== null ? `in ? · ${formatCount(outputTokens)} out` : 'Unknown'
  const recentMessages = withoutStaleContextNotices((session?.messages ?? []).filter((message) => message.role !== 'thinking'))
  const sessionMessageIds = new Set(recentMessages.map((message) => message.id).filter((id): id is string => typeof id === 'string'))
  // C10: the chat shows the last eight, plus eight more per "Load earlier".
  const chatWindowInfo = earlierWindow(chatWindow, recentMessages.length)
  const visibleMessages = recentMessages.slice(Math.max(0, recentMessages.length - chatWindowInfo.shown))
  const recentSteps = session ? buildConversationItems(session).filter((item) => item.kind === 'activity' && item.activityKind !== 'turn').slice(-12) : []
  const workingSince = useWorkingSince(agents, sessions, runtimes, connected, clock)
  const peekNames = (peek?.ids ?? []).map((id) => agents.find((item) => item.id === id)?.name).filter((value): value is string => !!value)
  const dragChips = dragPath ? dropChips(dragPath, dragSize) : null
  const color = agent ? agentColorHex(agent.color) : ''
  const name = agent?.name ?? (runtime ? labelize(runtime.provider) : 'Bitbots')
  const peers = activeAgents(agents).filter((item) => item.id !== agent?.id).slice(0, 4)
  const waitingAgents = waitingAgentsOf(activeAgents(agents), sessions, runtimes, connected)
  const openNextWaiting = () => { const next = nextWaitingAgent(waitingAgents, agent?.id); if (next) { playCompanionCue('blip'); onSelectAgent(next); setView('overview') } }
  const peerSummary = `${peers.length} teammate${peers.length === 1 ? '' : 's'}${waitingAgents.length ? ', ' + waitingAgents.length + ' waiting' : ''}`
  const canStart = !!agent && connected && runtimeUsable(runtime)
  // C6: one shared, dismissible error line. It clears itself after 8 seconds
  // while the daemon is reachable; a disconnected daemon stays visible.
  const errorLine = fileError ?? dropError ?? appError
  const visibleError = errorLine && errorLine !== dismissedError ? errorLine : null
  // Dismissing clears the file/drop errors as well, so the same message can show again later.
  const dismissError = () => { setFileError(null); setDropError(null); setDismissedError(errorLine ?? null) }
  useEffect(() => { if (dismissedError && errorLine !== dismissedError) setDismissedError(null) }, [errorLine, dismissedError])
  useEffect(() => {
    if (!visibleError || !connected) return
    const timer = window.setTimeout(dismissError, 8_000)
    return () => window.clearTimeout(timer)
  }, [visibleError, connected]) // eslint-disable-line react-hooks/exhaustive-deps
  // C11: the compact bar keeps to the short mood words for attention states.
  const moodLabel = compactMoodLabel(displayMood)
  const statusLine = confused ? 'A little dizzy… back to normal shortly' : visibleError ?? (preparingFile ? 'Checking local file access…' : moodLabel ?? activity)
  const shimmering = ['working', 'thinking', 'tool_activity', 'file_activity'].includes(displayMood)
  const sessionBusy = !!session && ['working', 'starting', 'waiting_permission'].includes(session.state ?? '')
  // While a turn is live the one button queues what is typed, or stops the turn when the box is empty.
  const companionDelivery = busyDelivery(busyMode, false, session?.state, steerAvailable, !!(droppedFile || slashCommand || leadingCommand(draft, { skills: slashSkills, isManager: agent?.systemRole === 'manager' })))
  const queuesPrompt = sessionBusy && (!!draft.trim() || !!droppedFile)
  const stopsTurn = sessionBusy && !queuesPrompt
  const wash = displayMood === 'success' ? 'green' : displayMood === 'error' || displayMood === 'rate_limited' ? 'red' : null
  const focusBlob = (size: number) => <BlobCanvas color={color} size={size} mood={displayMood} fileStage={fileStage} look={agent ? agentLook(agent) : null} soundCues={soundsEnabled} label={name} onDizzy={beginConfused} onDizzyRecovery={recoverFromConfused} />
  const dictating = dictationSurface === 'companion' && dictationPhase !== 'idle'
  const dictationText = `${dictationFinals}${dictationFinals && dictationPartial ? ' ' : ''}${dictationPartial}`
  const dictationIsland = dictating ? <DictationIsland variant="companion" engine={dictationEngine} phase={dictationPhase as IslandPhase} level={dictationLevel} since={dictationClock.since} stoppedAt={dictationClock.stoppedAt} text={dictationText} warming={dictationWarming} errorText={dictationError} /> : null
  const chatShown = mode === 'home' && view === 'chat' && !permission

  return <main className={`companion-root ${popIn ? 'pop-in' : ''}`} data-mode={mode} style={color ? { '--agent-accent': color } as React.CSSProperties : undefined} onMouseEnter={() => fsmRef.current?.mouseEntered()} onMouseLeave={() => fsmRef.current?.mouseLeft()}>
    {dictating && !chatShown && <div className="companion-listening">{dictationIsland}</div>}
    <div ref={capsuleRef} className={`companion-capsule island ${mode}`} data-tauri-drag-region>
      {mode === 'petit' ? <div className="companion-compact" data-tauri-drag-region>
        <button className="compact-bot" aria-label="Open companion home" onClick={() => fsmRef.current?.click()}>{focusBlob(40)}</button>
        {peekNames.length > 0
          ? <button type="button" className="companion-peek" aria-live="polite" aria-label={`${peekText(peekNames, nouns)} Open`} onClick={openPeek}><span className="companion-peek-text">{peekText(peekNames, nouns)}</span><span className="companion-peek-open">Open</span></button>
          : <button type="button" className="compact-copy" aria-label="Open companion home" onPointerDown={compactDrag.onPointerDown} onPointerMove={compactDrag.onPointerMove} onPointerUp={compactDrag.onPointerUp} onPointerCancel={compactDrag.onPointerCancel} onClick={() => { if (compactDrag.consumeDrag()) return; fsmRef.current?.click() }}><span className="compact-name"><strong>{name}</strong>{agent?.role?.trim() && <span className="companion-role">{agent.role.trim()}</span>}<ApprovalPill mode={approvalMode} compact /></span><span role="status" aria-live="polite" className={`compact-status ${shimmering ? 'shimmer' : ''}`}>{statusLine}</span></button>}
        <NeedsYouBadge count={waitingAgents.length} compact onOpen={openNextWaiting} />
        {permission && <ShieldAlert className="companion-alert" size={15} aria-label="Approval required" />}
        {peers.length > 0 && <div className="mini-grid" role="img" aria-label={peerSummary} data-tauri-drag-region>{peers.map((item) => { const peerRuntime = runtimes.find((candidate) => candidate.id === item.runtimeId); const offline = !connected || !peerRuntime || ['offline', 'error', 'disconnected'].includes((peerRuntime.status ?? '').toLowerCase()); return <BlobCanvas key={item.id} color={agentColorHex(item.color)} size={15} mini mood={offline ? 'offline' : 'idle'} look={agentLook(item)} label={item.name} /> })}</div>}
        <button className="companion-collapse" aria-label="Expand companion" onClick={() => fsmRef.current?.click()}><ChevronUp size={14} /></button>
      </div> : <>
        <header className="island-header" data-tauri-drag-region>
          <nav className="tabs" aria-label="Companion navigation">
            <button className={`tab ${view === 'overview' ? 'on' : ''}`} aria-label="Home" title="Home" onClick={() => openView('overview')}><Home size={13} /></button>
            <button className={`tab ${view === 'chat' ? 'on' : ''}`} aria-label="Chat" title="Chat" onClick={() => openView('chat')}><MessageCircle size={13} /></button>
            <button className={`tab ${view === 'activity' ? 'on' : ''}`} aria-label="Activity" title="Activity" onClick={() => openView('activity')}><Activity size={13} /></button>
            <button className="tab" aria-label="New conversation" title="New conversation" disabled={!canStart} onClick={(event) => { openView('chat'); onNewSession(event.currentTarget) }}><Plus size={14} /></button>
          </nav>
          {!dragHintSeen && <span className="companion-hint-pill" data-companion-no-drag="" role="note" title="Drag me anywhere. Ctrl+Alt+B shows or hides me."><span>Drag me anywhere</span><button type="button" onClick={markDragHintSeen}>Got it</button></span>}
          <span className="island-drag" data-tauri-drag-region title="Drag companion" aria-hidden="true" />
          <div className="island-actions">
            <NeedsYouBadge count={waitingAgents.length} onOpen={openNextWaiting} />
            <ApprovalPill mode={approvalMode} compact />
            <button className={view === 'settings' ? 'on' : ''} aria-label="Settings" title="Settings" onClick={() => openView('settings')}><Settings2 size={14} /></button>
            <button className={soundsEnabled ? 'on' : ''} aria-label={soundsEnabled ? 'Mute companion sounds' : 'Enable companion sounds'} aria-pressed={soundsEnabled} title={soundsEnabled ? 'Mute companion sounds' : 'Enable companion sounds'} onClick={toggleSounds}>{soundsEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}</button>
            <button className="companion-collapse" aria-label="Collapse companion" title="Collapse" disabled={!!permission} onClick={toggleExpanded}><ChevronDown size={14} /></button>
          </div>
        </header>
        <ConnectionBanner state={connected ? 'connected' : 'disconnected'} attempts={reconnectAttempts} failed={reconnectFailed} onRetry={() => onRetryConnection?.()} />
        {confused && <span className="sr-only" role="status" aria-live="polite">A little dizzy. Returning to normal shortly.</span>}
        <section className="island-views companion-content" aria-hidden={mode !== 'home'} inert={mode !== 'home'}>
          {permission ? <div className="island-card wash amber">
            <span className="card-bot">{focusBlob(56)}</span>
            <div className="card-stack">
              {permission.kind !== 'question' && <PermissionQueueBar
                index={Math.max(0, permissionQueue.findIndex((item) => item.id === permission.id))} total={Math.max(1, permissionQueue.length)}
                onPrev={() => { const at = Math.max(0, permissionQueue.findIndex((item) => item.id === permission.id)); onPickPermission?.(permissionQueue[(at - 1 + permissionQueue.length) % permissionQueue.length]?.id ?? permission.id) }}
                onNext={() => { const at = Math.max(0, permissionQueue.findIndex((item) => item.id === permission.id)); onPickPermission?.(permissionQueue[(at + 1) % permissionQueue.length]?.id ?? permission.id) }}
                onLater={() => { playCompanionCue('tick'); onSnoozePermission?.(permission.id) }} />}
              {permission.kind === 'proposal'
                ? <ProposalCard key={permission.id} request={permission} managerName={managerOf(agents)?.name} projects={projects} onDecided={(decision) => playCompanionCue(decision === 'approve' ? 'approve' : 'tick')} onError={(message) => onError?.(message)} />
                : permission.kind === 'question'
                ? <QuestionCard request={permission} onAnswer={(answers) => { playCompanionCue('approve'); return onAnswerQuestion?.(permission, answers) }} onDismiss={() => void onAnswerQuestion?.(permission, null)} />
                : <ApprovalCard permission={permission} variant="companion" onReply={(choice) => replyToPermission(permission, choice)} />}
              {session && <button className="btn ghost" onClick={cancelCompanionTurn} disabled={sending}>Cancel turn</button>}
            </div>
          </div> : confused ? <div className="island-card wash pink">
            <span className="card-bot">{focusBlob(62)}</span>
            <div className="card-stack"><div className="title">Too many hits at once.</div><div className="sub">Give me a sec — back to work in three seconds.</div></div>
          </div> : dropActive ? <div className="island-card drop-card over">
            <span className="card-bot">{focusBlob(58)}</span>
            <div className="card-stack"><div className="title">Drop to hand this file to {name}</div><div className="drop-tags">{dragChips ? <><span>{dragChips.name}</span><span>{dragChips.type}</span><span>{dragChips.size}</span></> : <><span>Name</span><span>Type</span><span>Size</span></>}</div><div className="sub">Bitbots checks the path only. It never reads file contents.</div></div>
          </div> : view === 'overview' ? <div className="island-overview">
            <div key={agent?.id ?? 'none'} className={`island-card focus ${wash ? `wash ${wash}` : ''}${shimmering ? ' is-working' : ''}`} style={color ? { ['--focus-glow' as string]: color } : undefined}>
              <span className="card-bot"><span className="focus-glow" aria-hidden="true" />{focusBlob(58)}</span>
              <button className="icon-btn jump" aria-label="Open in Bitbots" title="Open in Bitbots" onClick={onOpenMain}><ArrowUpRight size={9} /></button>
              <div className="card-stack">
                <div className="who"><span className="name">{name}</span><RuntimeProblemMarker runtime={runtime} onOpenSettings={onOpenSettings} />{agent?.role?.trim() && <span className="companion-role">{agent.role.trim()}</span>}{agent?.systemRole === 'manager' && <span className="companion-leader" title="Manager" aria-label="Manager"><BriefcaseBusiness size={9} strokeWidth={2.4} aria-hidden="true" /></span>}{botProjectName(agent, projects) && <span className="companion-project" title="Project">{botProjectName(agent, projects)}</span>}<span className="tool">{session?.title?.trim() ? session.title : runtime ? labelize(runtime.provider) : (connected ? 'No active session' : 'Offline')}</span></div>
                <FocusTicker steps={focusSteps} current={statusLine} shimmering={shimmering} />
                {focusTeam ? <button type="button" className="glance team-glance" onClick={() => onOpenSession?.(focusTeam.sessionId)} title="Open the side conversation in Bitbots">{focusTeam.peer && <BlobCanvas decorative color={agentColorHex(focusTeam.peer.color)} size={14} mini look={agentLook(focusTeam.peer)} label={focusTeam.peer.name} />}<span>{focusTeam.text}</span></button>
                  : <div className="glance" title={`Reported tokens across all ${nouns}. Input ${inputTokens === null ? 'unknown' : inputTokens.toLocaleString()} · Output ${outputTokens === null ? 'unknown' : outputTokens.toLocaleString()}`}><span>All {nouns}: Tokens <b>{tokenGlance}</b></span></div>}
              </div>
            </div>
            <CompanionPeers agents={agents} projects={projects} sessions={sessions} runtimes={runtimes} connected={connected} focusedId={agent?.id ?? null} pinned={pinned} onSelect={selectTeamBlob} onPinnedChange={(ids) => { playCompanionCue('tick'); onPinnedChange?.(ids) }} />
          </div> : view === 'chat' && sideSession ? <div className="island-card chat-card companion-chat-view companion-side-view">
            <div className="companion-side-head" data-companion-no-drag="">
              <button type="button" className="icon-btn" aria-label="Back to the conversation" title="Back" onClick={() => setSideId(null)}><ChevronLeft size={13} /></button>
              <SideConversationHeader peer={agents.find((item) => item.id === sideSession.link?.peerAgentId)} peerName={agents.find((item) => item.id === sideSession.link?.peerAgentId)?.name ?? sideSession.link?.peerName ?? 'Teammate'} target={agents.find((item) => item.id === sideSession.agentId)} targetName={agents.find((item) => item.id === sideSession.agentId)?.name ?? 'Teammate'} topic={sideSession.link?.topic ?? sideSession.title ?? null} />
              <button type="button" className="icon-btn" aria-label="Open in Bitbots" title="Open in Bitbots" onClick={() => onOpenSession?.(sideSession.id)}><ArrowUpRight size={11} /></button>
            </div>
            <div className="chat-log companion-side-log" data-companion-no-drag="">
              {!Array.isArray(sideSession.messages) && <p className="companion-empty" role="status">Loading the conversation…</p>}
              {(sideSession.messages ?? []).map((message, index) => <CompanionChatItem key={String(message.id ?? index)} message={message} agents={agents} currentSessionId={sideSession.id} onOpenSide={(sessionId) => { if (sessionId) openSide(sessionId) }} onOpenAgent={selectTeamBlob} />)}
              {Array.isArray(sideSession.messages) && sideSession.messages.length === 0 && <p className="companion-empty">No messages yet.</p>}
            </div>
          </div> : view === 'chat' ? <div className="island-card chat-card companion-chat-view">
            {onSelectConversation && <CompanionConversationPicker agent={agent} sessions={sessions} projects={projects} current={session} onPick={onSelectConversation} />}
            <span className="card-bot small">{focusBlob(44)}</span>
            <div className="chat-body">
              <div className="chat-log" ref={chatLogRef} data-companion-no-drag="" onScroll={onChatScroll}>
                {chatWindowInfo.canLoad && <button type="button" className="link-btn companion-load-earlier" onClick={loadEarlier}>Load earlier</button>}
                {!session && <p className="companion-empty companion-no-session">Open or create a session to chat here. <button type="button" disabled={!canStart} onClick={(event) => onNewSession(event.currentTarget)}>New session</button></p>}
                {visibleMessages.map((message, index) => <CompanionChatItem key={String(message.id ?? index)} message={message} agents={agents} currentSessionId={session?.id} availableMessageIds={sessionMessageIds} onOpenSide={(sessionId) => { if (sessionId) openSide(sessionId) }} onOpenAgent={selectTeamBlob} onToggleReaction={session && onToggleReaction ? (messageId, emoji) => onToggleReaction(session.id, messageId, emoji) : undefined} />)}
                {session && visibleMessages.length === 0 && <p className="companion-empty">No messages in this conversation yet.</p>}
                {sessionBusy && session?.state !== 'waiting_permission' && <div className="typing" aria-label={`${name} is working`}><i /><i /><i /></div>}
              </div>
              {showNewMessages && <button type="button" className="companion-new-messages" onClick={scrollChatToBottom}>New messages</button>}
            </div>
            {/* Everything below the messages spans the card's full width, clear of the avatar's gutter. */}
            <div className="companion-composer-zone">
              {droppedFile && fileInfo && <div className="chip settled companion-file-ready"><Paperclip size={11} /><span><strong>{fileInfo.fileName}</strong> · {formatBytes(fileInfo.sizeBytes)} · path only</span><button aria-label="Remove local file reference" onClick={() => { fileRequest.current++; setDroppedFile(null); setFileInfo(null); setPreparingFile(false); setFileError(null) }}><X size={11} /></button></div>}
              {preparingFile && <p className="companion-file-note" role="status">Checking the selected path is a readable file… <button type="button" onClick={() => { fileRequest.current++; setPreparingFile(false); setFileInfo(null); setDroppedFile(null) }}>Cancel</button></p>}
              {visibleError && <p className="companion-drop-error" role="alert" tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); dismissError() } }}><span>{visibleError}</span><button type="button" className="icon-btn" aria-label="Dismiss error" onClick={dismissError}><X size={10} /></button></p>}
              {dictating && dictationIsland}
              {usageTip && onDismissUsageTip && <UsageTip tip={usageTip} onDismiss={() => onDismissUsageTip(usageTip)} />}
              {queuedCount > 0 && <p className="companion-queue-note" role="status">{queuedCount} queued · sends when this turn ends</p>}
              {sessionBusy && <p className="companion-queue-note" role="status">{companionDelivery.mode === 'steer' ? 'Steer now' : 'Queue after this turn'} · Ctrl+Enter / ⌘+Enter sends the other way{deliveryNotice ? ` · ${deliveryNotice}` : ''}</p>}
              <form className="chat-bar companion-chat-composer" data-companion-no-drag="" onSubmit={(event) => void sendCompanionPrompt(event)}>
                {slashCommand && <SlashCommandChip command={slashCommand} onRemove={() => setSlashCommand(null)} />}
                {slash && companionSlashCandidates.length > 0 && <SlashMenu items={companionSlashCandidates} activeIndex={slash.index} onPick={pickCompanionSlash} onHover={(index) => setSlash((current) => current ? { ...current, index } : current)} />}
                <textarea ref={draftRef} className="chat-input" aria-label="Message agent" placeholder={!runtimeUsable(runtime) ? 'Coding agent unavailable · Open Settings to recover' : connected ? `Ask ${name}…` : 'Daemon disconnected'} value={draft} onChange={(event) => { const value = event.target.value; setDraft(value); const caret = event.target.selectionStart ?? value.length; const found = slashQuery(value, caret); setSlash(found ? { ...found, index: 0 } : null) }} onKeyDown={(event) => {
                  if (event.key === 'Backspace' && slashCommand && !draft) { event.preventDefault(); setSlashCommand(null); return }
                  if (slash && companionSlashCandidates.length) {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSlash({ ...slash, index: (slash.index + (event.key === 'ArrowDown' ? 1 : companionSlashCandidates.length - 1)) % companionSlashCandidates.length }); return }
                    if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pickCompanionSlash(companionSlashCandidates[Math.min(slash.index, companionSlashCandidates.length - 1)]); return }
                    if (event.key === 'Escape') { event.preventDefault(); setSlash(null); return }
                  }
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendCompanionPrompt(event, event.ctrlKey || event.metaKey) }
                }} disabled={!connected || !runtimeUsable(runtime) || !session || session.state === 'waiting_permission'} rows={1} />
                <div className="companion-composer-bar">
                <div className="companion-composer-start">
                  <button type="button" className="companion-attach" aria-label="Choose a local file" title="Choose a local file" onClick={() => void chooseCompanionFile()} disabled={!connected || !runtimeUsable(runtime) || !session || preparingFile}><Paperclip size={13} /></button>
                  {agent && session && onSessionUpdated && onError && <SessionExecutionControls session={session} agent={agent} onSessionUpdated={onSessionUpdated} onError={onError} />}
                </div>
                <div className="companion-composer-end">
                {session && <ContextWindowIndicator used={session.contextUsed} size={session.contextSize} contextModel={session.contextModel} contextEstimated={session.contextEstimated} model={contextModel} isNewConversation={(session.messages ?? []).length === 0} quota={contextQuota} />}
                {platform.nativeSpeech && speechEnabled && <DictationButton owner="companion" modelId={speechModel} autoStart={dictateOnOpen} onAutoStarted={() => setDictateOnOpen(false)} onFinal={(text) => setDraft((current) => (current ? `${current} ${text}` : text))} onPartial={setDictationPartial} disabled={!connected || !runtimeUsable(runtime) || !session || sending || session.state === 'waiting_permission'} />}
                <button className="send-btn" type={stopsTurn ? 'button' : 'submit'} disabled={!session || sending || !runtimeUsable(runtime) || preparingFile || (!draft.trim() && !droppedFile && !sessionBusy)} onClick={stopsTurn ? cancelCompanionTurn : undefined} aria-label={queuesPrompt ? companionDelivery.mode === 'steer' ? 'Steer now' : 'Queue message' : sessionBusy ? 'Cancel turn' : 'Send message'} title={queuesPrompt ? companionDelivery.mode === 'steer' ? 'Steer this turn now' : 'Send after this turn' : undefined}>{sending ? <LoaderCircle size={13} className="spinning" /> : stopsTurn ? <Square size={10} fill="currentColor" /> : <ArrowUp size={14} />}</button>
                </div>
                </div>
              </form>
            </div>
          </div> : view === 'activity' ? <div className="island-card list-card companion-activity-view">
            <div className="list-head"><strong>Activity</strong><button className="link-btn" onClick={onOpenMain}>View conversation</button></div>
            {onSelectConversation && <CompanionConversationPicker agent={agent} sessions={sessions} projects={projects} current={session} onPick={onSelectConversation} />}
            <CompanionActivitySummary agents={agents} sessions={sessions} runtimes={runtimes} connected={connected} workingSince={workingSince} now={clock} onOpen={(sessionId) => { if (sessionId) onOpenSession?.(sessionId) }} />
            <CompanionTeamActivity agent={agent} agents={agents} sessions={sessions} onOpen={(sessionId) => onOpenSession?.(sessionId)} />
            {activityDetails && (recentSteps.length ? <ActivitySteps items={recentSteps} /> : <p className="companion-empty">No commands, tools or file changes reported for this conversation.</p>)}
          </div> : <div className="island-card companion-settings-view">
            <div className="cset-body">
              <div className="cset-col" data-companion-no-drag="">
                <section className="cset-section" aria-labelledby="cset-sound">
                  <h3 id="cset-sound">Sound</h3>
                  <div className="cset-row">
                    <CompanionSettingCopy label="Companion sounds" hint="Short cues for replies and approvals." />
                    <button type="button" className={`switch ${soundsEnabled ? 'on' : ''}`} role="switch" aria-checked={soundsEnabled} aria-label="Companion sounds" onClick={toggleSounds} />
                  </div>
                  <div className="cset-row">
                    <CompanionSettingCopy label="Volume" hint="Applies to every companion cue. 0% is silent." />
                    <SoundVolumeSlider value={soundVolume} onChange={changeSoundVolume} onCommit={commitSoundVolume} />
                  </div>
                  <div className="cset-row">
                    <CompanionSettingCopy label="Focus mode" hint="No completion peeks or cues. Approvals and questions still show." />
                    <button type="button" className={`switch ${focusMode ? 'on' : ''}`} role="switch" aria-checked={focusMode} aria-label="Focus mode" onClick={toggleFocusMode} />
                  </div>
                </section>
                <section className="cset-section" aria-labelledby="cset-chat">
                  <h3 id="cset-chat">Chat</h3>
                  <div className="cset-row cset-row-stack">
                    <CompanionSettingCopy label="Height" hint="How tall the chat view is." />
                    <div className="segmented" role="radiogroup" aria-label="Chat height">{(Object.keys(COMPANION_CHAT_SIZES) as CompanionChatSize[]).map((size) => <button key={size} type="button" role="radio" aria-checked={chatSize === size} className={chatSize === size ? 'on' : undefined} onClick={() => { playCompanionCue('tick'); onChatSizeChange?.(size) }}>{COMPANION_CHAT_SIZE_LABELS[size]}</button>)}</div>
                  </div>
                </section>
                <section className="cset-section" aria-labelledby="cset-place">
                  <h3 id="cset-place">Placement</h3>
                  <div className="cset-row">
                    <CompanionSettingCopy label="Reset position" hint={startPosition === 'last' ? 'Forgets where this display last left the island.' : 'Returns to the bottom centre of this display.'} />
                    <button type="button" className="btn small secondary" aria-label="Reset companion position" onClick={resetPosition}>Reset</button>
                  </div>
                </section>
              </div>
              <div className="cset-col" data-companion-no-drag="">
                <section className="cset-section" aria-labelledby="cset-team">
                  <h3 id="cset-team">Teammates on the island</h3>
                  <CompanionTeammatesSetting agents={agents} sessions={sessions} runtimes={runtimes} connected={connected} focusedId={agent?.id ?? null} pinned={pinned} onPinnedChange={(ids) => { playCompanionCue('tick'); onPinnedChange?.(ids) }} />
                </section>
                <section className="cset-section" aria-labelledby="cset-remote">
                  <h3 id="cset-remote">Remote</h3>
                  <CompanionRemoteRow onOpenSettings={onOpenSettings} />
                </section>
              </div>
            </div>
            {soundError && <p className="companion-drop-error cset-error" role="alert">{soundError}</p>}
            <div className="cset-footer"><button type="button" className="btn primary" onClick={() => onOpenSettings()}>Open Bitbots settings</button><button type="button" className="btn secondary" onClick={() => void setCompanionVisibility(false)}>Hide companion</button></div>
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
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'The local daemon request failed.'
  if (/selected model does not support this effort|thinking is not supported by the selected model/i.test(message)) {
    return 'This effort is not available for the selected model. Choose a listed effort or reset to that model’s default; the model choice is unchanged.'
  }
  if (/choose a concrete model|model selections cannot be unset/i.test(message)) {
    return 'Choose a concrete model in the conversation controls before sending. No provider default was selected.'
  }
  return message
}
