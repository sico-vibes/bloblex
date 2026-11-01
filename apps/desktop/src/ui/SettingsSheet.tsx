import { EXPERIMENTS, DEFAULT_EXPERIMENTS, type Experiments, type ExperimentName } from './experiments'
import { KeybindingEditor } from './KeybindingEditor'
import { Keys } from './Keys'
import { normalizeBindings, normalizeSendShortcut, oppositeKeys, SEND_SHORTCUTS, type SendShortcut, type ShortcutBindings } from './shortcuts'
import type { ApprovalMode } from '../types'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Bot, Cable, Brain, Check, ChevronDown, ChevronRight, Download, MessageSquare, Plus, RefreshCw, ShieldAlert, ShieldCheck, SlidersHorizontal, Wrench, X, Palette, Search, Smartphone, BriefcaseBusiness, Sparkles } from 'lucide-react'
import { emitNative, invokeNative, listenNative } from '../transport/nativeBridge'
import { SettingsSkeleton } from './SettingsSkeleton'
import { usePlatform } from '../transport/platform'
import type { Agent, Runtime, Snapshot } from '../types'
import { labelize } from '../types'
import { effectiveApprovalMode, parseGlobalMode, type PermissionsPolicy } from '../approvalContract'
import { companionMonitorOptions, currentCompanionMonitor, inDesktop, permissionsPolicyGet, previewMode, rpc, setCloseToTray, setCompanionMonitor, setCompanionVisibility } from '../tauri'
import { agentColorHex } from './agentColor'
import { useDialogAccessibility } from './dialogFocus'
import { Select } from './Select'
import { MemoryPage } from './MemoryPage'
import { ApprovalRulesPage } from './ApprovalRulesPage'
import { HealthPage } from './HealthPage'
import { ManagerPage } from './ManagerPage'
import { managerOf } from './teamSelectors'
import { SkillsPage } from './SkillsPage'
import { BackupPage } from './BackupPage'
import { normalizeEngineChoice, setDictationEnginePrefs, type DictationEngineChoice } from './dictation'
import { UpdatesPanel } from './UpdatesPanel'
import { autostartEnabled, setAutostartEnabled } from '../desktopIntegrations'
import { ProviderLogo, providerBrand } from './providerBrand'
import { runtimeAuthSummary } from './launchChecks'
import { needsSignIn, SignInHelp } from './SignInHelp'
import { discoveryResultText, EMPTY_DISCOVERY_STATUS, runtimeProbeDetail, scanTime, type DiscoveryStatus } from './runtimeDiscovery'
import { ScanRecovery } from './ScanRecovery'
import { ConfirmDialog } from './BlobPage'
import { RowCopy, SettingsGroup, SettingsRow } from './SettingsParts'
import { OutsideWatchSetting } from './OutsideSessions'
import { RemoteSettings } from './RemoteSettings'
import { MachinesPage } from './MachinesPage'
import { AccountsPage } from './AccountsPage'
import { SecretsPage } from './SecretsPage'
import { ConnectionsPage } from './ConnectionsPage'
import { DiagnosticsDialog } from './DiagnosticsDialog'
import { HarnessUpdatesNotice } from './HarnessUpdatesNotice'
import { AppearancePage } from './AppearancePage'
import { searchSettings, type SettingsIndexEntry } from './settingsIndex'
import { SoundVolumeSlider } from './SoundVolumeSlider'
import { DEFAULT_SOUND_VOLUME } from '../blob/soundVolume'
import { applySoundPrefs, previewSoundVolume, saveSoundsEnabled, saveSoundVolume as persistSoundVolume, soundPrefsFromSettings, subscribeSoundPrefs } from './soundPrefs'
import { focusModeFromSettings, saveFocusMode, subscribeFocusMode } from './companionPrefs'
import { clearCompanionPosition } from './companionPositions'
import { useEntityNoun } from './vocabulary'
import { useThemeStyle } from '../blob/bitbots'
import './bitbotsUi.css'

export type SettingsPageId = 'General' | 'Appearance' | 'Chat' | 'Speech' | 'Keyboard' | 'Companion' | 'Agents' | 'Accounts' | 'Manager' | 'Approvals' | 'Memory' | 'Skills' | 'Remote' | 'Machines' | 'Connections' | 'Secrets' | 'Updates' | 'Backup' | 'Health'

type SettingsTab = { label: string; icon: typeof SlidersHorizontal; pages: Array<{ id: SettingsPageId; label: string }> }

// Ten tabs in four groups (owner, 31 October 2026). A tab with several pages shows them as tabs under its title.
const NAV: Array<{ label: string; tabs: SettingsTab[] }> = [
  { label: 'App', tabs: [
    { label: 'General', icon: SlidersHorizontal, pages: [{ id: 'General', label: 'General' }] },
    { label: 'Appearance', icon: Palette, pages: [{ id: 'Appearance', label: 'Appearance' }] },
    { label: 'Chat', icon: MessageSquare, pages: [{ id: 'Chat', label: 'Messages' }, { id: 'Speech', label: 'Dictation' }, { id: 'Keyboard', label: 'Keyboard' }] },
    { label: 'Companion', icon: Sparkles, pages: [{ id: 'Companion', label: 'Companion' }] },
  ] },
  { label: 'Bots', tabs: [
    { label: 'Coding agents', icon: Bot, pages: [{ id: 'Agents', label: 'Agents' }, { id: 'Accounts', label: 'Accounts' }] },
    { label: 'Manager', icon: BriefcaseBusiness, pages: [{ id: 'Manager', label: 'Manager' }] },
    { label: 'Approvals', icon: ShieldCheck, pages: [{ id: 'Approvals', label: 'Approvals' }] },
    { label: 'Memory and skills', icon: Brain, pages: [{ id: 'Memory', label: 'Memory' }, { id: 'Skills', label: 'Skills' }] },
  ] },
  { label: 'Connections', tabs: [
    { label: 'Remote access', icon: Smartphone, pages: [{ id: 'Remote', label: 'Remote' }, { id: 'Machines', label: 'Machines' }] },
    { label: 'Integrations', icon: Cable, pages: [{ id: 'Connections', label: 'Bitbots MCP' }, { id: 'Secrets', label: 'Secrets' }] },
  ] },
  { label: 'System', tabs: [
    { label: 'System', icon: Wrench, pages: [{ id: 'Updates', label: 'Updates' }, { id: 'Backup', label: 'Backup' }, { id: 'Health', label: 'Health check' }] },
  ] },
]
const TABS = NAV.flatMap((group) => group.tabs)
const tabOf = (page: SettingsPageId) => TABS.find((tab) => tab.pages.some((item) => item.id === page)) ?? TABS[0]!

type SpeechModelRow = { id: string; label: string; description: string; language: string; streaming: boolean; recommended: boolean; sizeBytes: number }
const PREVIEW_SPEECH_MODELS: SpeechModelRow[] = [
  { id: 'parakeet-tdt-0.6b-v3-int8', label: 'Parakeet TDT v3', description: 'Highest accuracy for 25 European languages. Punctuation, capitalization, and word-level timestamps.', language: 'multilingual', streaming: false, recommended: true, sizeBytes: 671_000_000 },
  { id: 'parakeet-tdt-0.6b-v2-int8', label: 'Parakeet TDT v2', description: 'English only. Faster than v3 with similar accuracy. Punctuation and capitalization.', language: 'en', streaming: false, recommended: false, sizeBytes: 661_000_000 },
  { id: 'zipformer-streaming-en-20m', label: 'Zipformer Streaming EN', description: 'English only. Lightweight 20M-param model with low-latency real-time partials.', language: 'en', streaming: true, recommended: false, sizeBytes: 128_000_000 },
  { id: 'cactus-whistle-v1', label: 'Whistle', description: 'A very small model for English, German, French, Spanish, Italian, Dutch and Polish: 17 MB plus a 1.5 MB engine. Quick to download and light on memory; it is less accurate than Parakeet and may leave out punctuation.', language: 'multilingual', streaming: false, recommended: false, sizeBytes: 18_490_223 },
]
const EMPTY_RUNTIMES: Runtime[] = []

export function providerDisplayName(provider: string | undefined) {
  return providerBrand(provider ?? '').name || labelize(provider, 'Coding agent')
}

export function SettingsSheet({ snapshot, scanStatus = EMPTY_DISCOVERY_STATUS, initialPage, initialGroup = null, onClose, onRefresh, onError, onOpenAgent, onOpenSession, onRunSetup = () => undefined, focusUpdates = false, usageBarEnabled = false, onUsageBarChange, onSendShortcutChange, onShortcutBindingsChange, claudeWorkflowsEnabled = false, onClaudeWorkflowsChange, usageTipsEnabled = false, onUsageTipsChange, activityDetails = false, onActivityDetailsChange, runtimeLogos = false, onRuntimeLogosChange, experiments = DEFAULT_EXPERIMENTS, onExperimentChange, speechEnabled = true, onSpeechEnabledChange, speechModel = '', onSpeechModelChange }: {
  snapshot: Snapshot | null
  scanStatus?: DiscoveryStatus
  initialPage: SettingsPageId
  /** A group on that page to scroll to and flash. */
  initialGroup?: string | null
  onClose: () => void
  onRefresh: () => void | Promise<void>
  onError: (error: string | null) => void
  onOpenAgent: (agentId: string) => void
  /** Opens a conversation (the last run of a schedule) and leaves Settings. */
  onOpenSession?: (sessionId: string) => void
  onRunSetup?: () => void
  focusUpdates?: boolean
  /** The plan-usage bar along the bottom of the main window. */
  usageBarEnabled?: boolean
  onUsageBarChange?: (enabled: boolean) => void
  onSendShortcutChange?: (shortcut: SendShortcut) => void
  onShortcutBindingsChange?: (bindings: ShortcutBindings) => void
  claudeWorkflowsEnabled?: boolean
  onClaudeWorkflowsChange?: (enabled: boolean) => void
  /** Surface accurate provider-reported high quota above the active composer. */
  usageTipsEnabled?: boolean
  onUsageTipsChange?: (enabled: boolean) => void
  /** Each turn's commands, tools and edits, expandable under the reply. */
  activityDetails?: boolean
  onActivityDetailsChange?: (enabled: boolean) => void
  experiments?: Experiments
  onExperimentChange?: (name: ExperimentName, enabled: boolean) => void
  runtimeLogos?: boolean
  onRuntimeLogosChange?: (enabled: boolean) => void
  /** Speech: whether dictation is on at all, and the downloaded model it uses. */
  speechEnabled?: boolean
  onSpeechEnabledChange?: (enabled: boolean) => void
  speechModel?: string
  onSpeechModelChange?: (modelId: string) => void
}) {
  const { ref: dialogRef, close } = useDialogAccessibility(onClose)
  const platform = usePlatform()
  const style = useThemeStyle()
  const noun = useEntityNoun()
  const nouns = useEntityNoun({ plural: true })
  const Nouns = useEntityNoun({ plural: true, capital: true })
  const [page, setPage] = useState<SettingsPageId>(focusUpdates ? 'Updates' : initialPage)
  useEffect(() => { setPage(focusUpdates ? 'Updates' : initialPage) }, [initialPage, focusUpdates])
  const [busyMode, setBusyMode] = useState<'steer' | 'queue'>('steer')
  // Starts true: the sheet unmounts when it closes, so every open fetched
  // everything again. Starting false painted the real page with default values
  // for a frame, then the skeleton, then the real values — a content, skeleton,
  // content flicker. The three reads below are started together rather than one
  // after another, so one open is one wait.
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [profiles, setProfiles] = useState<Record<string, unknown>[]>([])
  const [policy, setPolicy] = useState<PermissionsPolicy | null>(null)
  const [policyError, setPolicyError] = useState<string | null>(null)
  const [companionVisible, setCompanionVisible] = useState(false)
  const companionVisibilityRevision = useRef(0)
  const [companionOpenAtStartup, setCompanionOpenAtStartup] = useState(false)
  const [closeToTray, setCloseToTrayValue] = useState(true)
  const [monitors, setMonitors] = useState<string[]>([])
  const [companionMonitor, setCompanionMonitorValue] = useState<string | null>(null)
  const [soundsEnabled, setSoundsEnabled] = useState(false)
  const [soundVolume, setSoundVolume] = useState(DEFAULT_SOUND_VOLUME)
  const [focusMode, setFocusMode] = useState(false)
  const savedSoundVolume = useRef(DEFAULT_SOUND_VOLUME)
  const [startPosition, setStartPosition] = useState<'launch' | 'last'>('launch')
  const [companionHotkey, setCompanionHotkey] = useState(true)
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  const [retryMaxWaitSecs, setRetryMaxWaitSecs] = useState(21600)
  const [profileAbout, setProfileAbout] = useState('')
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [sharedMemoryWrites, setSharedMemoryWrites] = useState(false)
  const [keepAwake, setKeepAwake] = useState(false)
  // FIX39 item 18: the only concurrency limit — "Bots working at once",
  // default 4, range 1–16. There is no per-bot cap any more.
  const [botsAtOnce, setBotsAtOnce] = useState(4)
  const [speechEngine, setSpeechEngine] = useState<DictationEngineChoice>('local')
  const [cloudConsent, setCloudConsent] = useState(false)
  const [consentFor, setConsentFor] = useState<DictationEngineChoice | null>(null)
  const [steerGate, setSteerGate] = useState(false)
  const [startWithWindows, setStartWithWindows] = useState(false)
  const [autostartLoaded, setAutostartLoaded] = useState(false)
  const [editorExecutable, setEditorExecutable] = useState('')
  const [editorArgs, setEditorArgs] = useState('[]')
  const [profileName, setProfileName] = useState('')
  const [profileProvider, setProfileProvider] = useState('codex')
  const [profileProtocol, setProfileProtocol] = useState('codex_app_server')
  const [profilePath, setProfilePath] = useState('')
  const [profileArgs, setProfileArgs] = useState('[]')
  const [launcherFormOpen, setLauncherFormOpen] = useState(false)
  const [profileDeleteTarget, setProfileDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [defaultMode, setDefaultMode] = useState<ApprovalMode>('ask')
  const [confirmFullDefault, setConfirmFullDefault] = useState(false)
  const [readSignIns, setReadSignIns] = useState(false)
  const [sendShortcut, setSendShortcut] = useState<SendShortcut>('enter')
  const [bindings, setBindings] = useState<ShortcutBindings>({})
  const [openRuntimes, setOpenRuntimes] = useState<Record<string, boolean>>({})
  const [speechModels, setSpeechModels] = useState<SpeechModelRow[]>([])
  const [speechReady, setSpeechReady] = useState<Record<string, boolean>>({})
  const [speechProgress, setSpeechProgress] = useState<Record<string, number>>({})
  const [speechBusy, setSpeechBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!inDesktop) { setLoading(false); return }
    setLoading(true)
    setFormError(null)
    // Started together, awaited in the order the values are applied. Before
    // 2026-11-01 these were three waits in a row (settings + profiles, then the
    // native hotkey probe, then the permission policy), so the skeleton stayed up
    // for the sum of three round trips.
    const policyRead = permissionsPolicyGet()
      .then((next) => ({ next, failure: null as string | null }))
      .catch((reason) => ({ next: null, failure: messageOf(reason) }))
    const hotkeyRead = invokeNative<boolean>('companion_hotkey_registered')
      .then((registered) => ({ registered, failure: null as string | null }))
      .catch((reason) => ({ registered: null, failure: messageOf(reason) }))
    try {
      const [settingsResult, profileResult] = await Promise.all([
        rpc<Record<string, unknown>>('settings.get').catch((reason) => ({ loadError: messageOf(reason) })),
        rpc('runtime.profile.list').catch((reason) => ({ loadError: messageOf(reason) })),
      ])
      const preferences = recordFrom(settingsResult)
      const settings = recordFrom(preferences.settings ?? preferences)
      setBusyMode(settings['composer.busySendMode'] === 'queue' ? 'queue' : 'steer')
      setSendShortcut(normalizeSendShortcut(settings['composer.sendShortcut']))
      setBindings(normalizeBindings(settings['shortcuts.bindings']))
      setReadSignIns(settings['usage.readCliSignIns'] === true)
      if (typeof settings['companion.openAtStartup'] === 'boolean') setCompanionOpenAtStartup(settings['companion.openAtStartup'])
      if (typeof settings.closeToTray === 'boolean') setCloseToTrayValue(settings.closeToTray)
      const soundPrefs = soundPrefsFromSettings(settings)
      applySoundPrefs(soundPrefs)
      setSoundsEnabled(soundPrefs.soundsEnabled)
      savedSoundVolume.current = soundPrefs.soundVolume
      setSoundVolume(soundPrefs.soundVolume)
      setFocusMode(focusModeFromSettings(settings))
      if (settings['companion.startPosition'] === 'last') setStartPosition('last')
      if (typeof settings['companion.hotkey'] === 'boolean') setCompanionHotkey(settings['companion.hotkey'])
      if (settings['companion.hotkey'] !== false) {
        const hotkey = await hotkeyRead
        if (hotkey.registered !== null) {
          setCompanionHotkey(hotkey.registered)
          if (!hotkey.registered) {
            await rpc('settings.set', { key: 'companion.hotkey', value: false }).catch(() => undefined)
            setFormError('Ctrl+Alt+B is used by another app. The companion shortcut is off.')
          }
        }
      }
      setNotificationsEnabled(settings['notifications.enabled'] !== false)
      if (typeof settings['retry.maxWaitSecs'] === 'number') setRetryMaxWaitSecs(settings['retry.maxWaitSecs'])
      if (typeof settings['profile.about'] === 'string') setProfileAbout(settings['profile.about'])
      setSharedMemoryWrites(settings['memory.sharedAgentWrites'] === true)
      setKeepAwake(settings['power.keepAwake'] === true)
      if (typeof settings['concurrency.botsAtOnce'] === 'number') setBotsAtOnce(settings['concurrency.botsAtOnce'])
      const loadedEngine = normalizeEngineChoice(settings['speech.engine'])
      setSpeechEngine(loadedEngine)
      setCloudConsent(settings['speech.cloud.consent'] === true)
      setDictationEnginePrefs({ engine: loadedEngine, consent: settings['speech.cloud.consent'] === true })
      setSteerGate(settings['exec_gate.codex.steer'] === true)
      if (typeof settings.editorExecutable === 'string') setEditorExecutable(settings.editorExecutable)
      if (Array.isArray(settings.editorArgs) && settings.editorArgs.every((argument) => typeof argument === 'string')) setEditorArgs(JSON.stringify(settings.editorArgs))
      if (settings['permissions.default_mode'] === 'ask' || settings['permissions.default_mode'] === 'auto') setDefaultMode(settings['permissions.default_mode'])
      setProfiles(listFrom(profileResult))
      const policy = await policyRead
      if (policy.next) {
        setPolicy(policy.next)
        setDefaultMode(policy.next.defaultMode)
        setPolicyError(null)
      } else {
        setPolicy(null)
        setPolicyError(policy.failure)
      }
    } finally { setLoading(false) }
    void Promise.all([companionMonitorOptions(), currentCompanionMonitor()]).then(([available, current]) => {
      setMonitors(available)
      setCompanionMonitorValue(current)
    }).catch(() => { setMonitors([]); setCompanionMonitorValue(null) })
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => subscribeSoundPrefs((prefs) => {
    setSoundsEnabled(prefs.soundsEnabled)
    savedSoundVolume.current = prefs.soundVolume
    setSoundVolume(prefs.soundVolume)
  }), [])

  useEffect(() => subscribeFocusMode(setFocusMode), [])

  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined
    if (inDesktop) {
      void listenNative<boolean>('bloblex-companion-visible-changed', (payload) => {
        companionVisibilityRevision.current += 1
        setCompanionVisible(payload)
      }).then((stop) => {
        if (!active) { stop(); return }
        unlisten = stop
        const revisionAtRead = companionVisibilityRevision.current
        void invokeNative<boolean>('companion_visible').then((visible) => {
          if (active && companionVisibilityRevision.current === revisionAtRead) setCompanionVisible(visible)
        }).catch(() => undefined)
      })
    }
    return () => { active = false; unlisten?.() }
  }, [])

  useEffect(() => {
    if (!inDesktop) return
    void autostartEnabled().then((enabled) => { setStartWithWindows(enabled); setAutostartLoaded(true) }).catch((reason) => { setAutostartLoaded(true); setFormError(messageOf(reason)) })
  }, [])

  const loadSpeech = useCallback(async () => {
    if (previewMode) {
      // The browser preview has no speech engine; show the catalog as the app would.
      setSpeechModels(PREVIEW_SPEECH_MODELS)
      setSpeechReady({ [PREVIEW_SPEECH_MODELS[0].id]: true })
      return
    }
    if (!inDesktop) return
    try {
      const models = await invokeNative<SpeechModelRow[]>('speech_models')
      setSpeechModels(models)
      const entries = await Promise.all(models.map(async (model) => {
        try { return [model.id, (await invokeNative<{ ready: boolean }>('speech_model_status', { modelId: model.id })).ready] as const }
        catch { return [model.id, false] as const }
      }))
      setSpeechReady(Object.fromEntries(entries))
    } catch (reason) { setFormError(messageOf(reason)) }
  }, [])

  useEffect(() => { if (page === 'Speech') void loadSpeech() }, [page, loadSpeech])

  const downloadModel = async (modelId: string) => {
    setSpeechBusy(modelId)
    setSpeechProgress((current) => ({ ...current, [modelId]: 0 }))
    let unlisten: (() => void) | undefined
    try {
      unlisten = await listenNative<{ modelId: string; completed: number; total: number }>('bloblex-speech-download', (payload) => {
        if (payload.modelId !== modelId) return
        setSpeechProgress((current) => ({ ...current, [modelId]: payload.total ? payload.completed / payload.total : 0 }))
      })
      await invokeNative('speech_model_download', { modelId })
      const firstReady = !Object.values(speechReady).some(Boolean)
      setSpeechReady((current) => ({ ...current, [modelId]: true }))
      // The first model you download becomes the one dictation uses.
      if (firstReady) { const failure = await saveSetting('speech.model', modelId); if (!failure) onSpeechModelChange?.(modelId) }
      setNotice('Speech model ready for dictation.')
    } catch (reason) { setFormError(messageOf(reason)) }
    finally {
      unlisten?.()
      setSpeechBusy(null)
      setSpeechProgress((current) => ({ ...current, [modelId]: 0 }))
    }
  }

  useEffect(() => {
    if (!focusUpdates || loading || page !== 'Updates') return
    const frame = requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>('[data-settings-section="updates"]')?.scrollIntoView?.({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [focusUpdates, loading, page])

  const guarded = async (action: () => Promise<void>) => {
    setSaving(true)
    setFormError(null)
    try { await action() }
    catch (reason) { const message = messageOf(reason); setFormError(message); return message }
    finally { setSaving(false) }
    return null
  }

  const setCompanion = (visible: boolean) => guarded(async () => { await setCompanionVisibility(visible) })
  const saveSetting = (key: string, value: unknown) => guarded(async () => { await rpc('settings.set', { key, value }) })
  const applySpeechEngine = async (engine: DictationEngineChoice, consent: boolean) => {
    const failure = await guarded(async () => {
      if (consent !== cloudConsent) {
        await rpc('settings.set', { key: 'speech.cloud.consent', value: consent })
        await rpc('settings.set', { key: 'speech.cloud.consentAt', value: consent ? new Date().toISOString() : null })
      }
      await rpc('settings.set', { key: 'speech.engine', value: engine })
    })
    if (failure) return
    setSpeechEngine(engine)
    setCloudConsent(consent)
    setDictationEnginePrefs({ engine, consent })
  }
  const chooseSpeechEngine = (engine: DictationEngineChoice) => {
    if (engine === 'local' || cloudConsent) { void applySpeechEngine(engine, cloudConsent); return }
    setConsentFor(engine)
  }
  const setStartPositionChoice = (value: string) => {
    if (value !== 'launch' && value !== 'last') return
    void saveSetting('companion.startPosition', value).then((failure) => { if (!failure) setStartPosition(value) })
  }
  const setHotkey = async (enabled: boolean) => {
    setNotice(null)
    const failure = await guarded(async () => {
      await invokeNative('set_companion_hotkey', { enabled })
      await rpc('settings.set', { key: 'companion.hotkey', value: enabled })
      setCompanionHotkey(enabled)
    })
    if (failure) {
      try { setCompanionHotkey(await invokeNative<boolean>('companion_hotkey_registered')) } catch { setCompanionHotkey(false) }
      setFormError(enabled && failure.includes('already in use')
        ? 'Ctrl+Alt+B is used by another app. The companion shortcut is off.'
        : failure)
    }
  }
  const updateCloseToTray = (enabled: boolean) => guarded(async () => { await setCloseToTray(enabled); setCloseToTrayValue(enabled) })
  const updateAutostart = (enabled: boolean) => guarded(async () => {
    await setAutostartEnabled(enabled)
    setStartWithWindows(await autostartEnabled())
  })
  const setNotifications = (enabled: boolean) => guarded(async () => {
    await rpc('settings.set', { key: 'notifications.enabled', value: enabled })
    setNotificationsEnabled(enabled)
    try { await emitNative('bloblex-notifications-enabled-changed', enabled) } catch { /* The main window refreshes the saved preference on reconnect. */ }
  })
  const updateCompanionMonitor = (monitorName: string) => guarded(async () => {
    await setCompanionMonitor(monitorName)
    setCompanionMonitorValue(monitorName)
    setNotice(`Companion moved to ${monitorName}.`)
  })

  const setSounds = async (enabled: boolean) => {
    setSoundsEnabled(enabled)
    const failure = await guarded(async () => {
      await saveSoundsEnabled(enabled)
      setNotice(enabled ? 'Companion sounds enabled.' : 'Companion sounds muted.')
    })
    if (failure) { setSoundsEnabled(!enabled); onError(failure) }
  }

  const setFocus = async (enabled: boolean) => {
    setFocusMode(enabled)
    const failure = await guarded(async () => {
      await saveFocusMode(enabled)
      setNotice(enabled ? 'Focus mode on. Completion peeks are quiet.' : 'Focus mode off.')
    })
    if (failure) { setFocusMode(!enabled); onError(failure) }
  }

  const resetCompanionPosition = () => guarded(async () => {
    const monitor = await currentCompanionMonitor()
    await clearCompanionPosition(monitor)
    if (startPosition !== 'last' && monitor) await setCompanionMonitor(monitor)
    setNotice('Companion position reset.')
  })

  // The slider moves the shown value freely; the daemon setting is written once
  // on release, and the companion (which owns the audio) applies it and plays one cue.
  const saveSoundVolume = async (volume: number) => {
    const previous = savedSoundVolume.current
    setSoundVolume(volume)
    try {
      await persistSoundVolume(volume, true)
      savedSoundVolume.current = volume
    } catch (reason) {
      setSoundVolume(previous)
      onError(messageOf(reason))
    }
  }

  /** The Play sample button: same preview path, without saving the volume again. */
  const playSoundSample = async () => {
    await previewSoundVolume(soundVolume)
  }

  const saveDefaultMode = async (value: string, confirmed = false) => {
    const mode = parseGlobalMode(value)
    if (value !== mode) return
    if (mode === 'bypass' && !confirmed) { setConfirmFullDefault(true); return }
    setConfirmFullDefault(false)
    const failure = await guarded(async () => {
      await rpc('settings.set', { key: 'permissions.default_mode', value: mode, ...(mode === 'bypass' ? { confirm: true } : {}) })
      setDefaultMode(mode)
      setNotice(mode === 'auto' ? `${Nouns} without their own setting now auto-approve low-risk actions.` : mode === 'accept_edits' ? `${Nouns} without their own setting now accept file edits and ask about commands.` : mode === 'bypass' ? `${Nouns} without their own setting now have Full access.` : `${Nouns} without their own setting now ask first.`)
      onError(null)
    })
    if (failure) onError(failure)
  }

  const saveEditor = async (event: FormEvent) => {
    event.preventDefault()
    let args: unknown
    try { args = JSON.parse(editorArgs) } catch { setFormError('Editor arguments must be a JSON array of strings.'); return }
    if (!Array.isArray(args) || !args.every((argument) => typeof argument === 'string')) { setFormError('Editor arguments must be a JSON array of strings.'); return }
    const failure = await guarded(async () => {
      await rpc('settings.set', { key: 'editorExecutable', value: editorExecutable.trim() })
      await rpc('settings.set', { key: 'editorArgs', value: args })
      setNotice('Editor saved.')
      onError(null)
    })
    if (failure) onError(failure)
  }

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault()
    let args: unknown
    try { args = JSON.parse(profileArgs) } catch { setFormError('Fixed arguments must be a valid JSON array of strings.'); return }
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) { setFormError('Fixed arguments must be a valid JSON array of strings.'); return }
    const failure = await guarded(async () => {
      await rpc('runtime.profile.save', { profile: { name: profileName, provider: profileProvider, protocolFamily: profileProtocol, executablePath: profilePath, args, workingDirectoryPolicy: 'per_session' } })
      setProfileName('')
      setProfilePath('')
      setProfileArgs('[]')
      setLauncherFormOpen(false)
      setNotice('Launcher saved.')
      onError(null)
      await load()
    })
    if (failure) onError(failure)
  }

  const deleteProfile = async (profileId: string) => {
    await rpc('runtime.profile.delete', { profileId })
    setNotice('Launcher removed.')
    await load()
  }

  const runtimes = snapshot?.runtimes ?? EMPTY_RUNTIMES
  const agents = (snapshot?.agents ?? []).filter((agent) => !agent.archived)
  const orphanAgents = agents.filter((agent) => !agent.parentAgentId && !runtimes.some((runtime) => runtime.id === agent.runtimeId))
  const modeFor = (agent: Agent) => policy?.perAgent.find((row) => row.agentId === agent.id)?.effectiveMode ?? effectiveApprovalMode(agent) ?? defaultMode
  const switchPage = (next: SettingsPageId) => { setPage(next); setFormError(null); setNotice(null) }
  const [settingsQuery, setSettingsQuery] = useState('')
  const searchResults = searchSettings(settingsQuery)
  const openSearchResult = (entry: SettingsIndexEntry) => {
    switchPage(entry.page as SettingsPageId)
    setSettingsQuery('')
    flashGroup(entry.group)
  }

  const flashGroup = (group: string) => {
    window.setTimeout(() => {
      const heading = [...document.querySelectorAll('.settings-content .settings-group-head h3')].find((node) => node.textContent === group)
      const section = heading?.closest('.settings-group')
      if (!section) return
      section.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
      section.classList.add('settings-flash')
      window.setTimeout(() => section.classList.remove('settings-flash'), 1400)
    }, 80)
  }
  useEffect(() => { if (initialGroup && !loading) flashGroup(initialGroup) }, [initialGroup, loading])
  const tab = tabOf(page)
  const pageSwitch = (label: string, checked: boolean, key: string, apply: (next: boolean) => void) => <button type="button" className={`toggle ${checked ? 'on' : ''}`} role="switch" aria-label={label} aria-checked={checked} disabled={saving} onClick={() => { const next = !checked; void saveSetting(key, next).then((failure) => { if (!failure) apply(next) }) }}><i /></button>
  const featureRow = (name: ExperimentName) => {
    const feature = EXPERIMENTS.find((item) => item.name === name)!
    return <SettingsRow key={name} label={feature.label} hint={feature.help()}>{pageSwitch(feature.label, experiments[name], `experimental.${name}`, (next) => onExperimentChange?.(name, next))}</SettingsRow>
  }

  return <div className="sheet-backdrop settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
    <section ref={dialogRef} className="settings-sheet" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1}>
      <header className="settings-page-head">
        <h2 id="settings-title">{tab.label}</h2>
        <button type="button" className="icon-button" data-dialog-initial-focus aria-label="Close settings" onClick={close}><X size={17} aria-hidden="true" /></button>
        {tab.pages.length > 1 && <div className="blob-tabs settings-subtabs" role="tablist" aria-label={tab.label}>{tab.pages.map((item) => <button type="button" role="tab" key={item.id} aria-selected={page === item.id} onClick={() => switchPage(item.id)}>{item.label}</button>)}</div>}
      </header>
      <nav className="settings-nav" aria-label="Settings pages">
        <label className="settings-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="Search settings" placeholder="Search settings" value={settingsQuery} onChange={(event) => setSettingsQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && settingsQuery) { event.preventDefault(); event.stopPropagation(); setSettingsQuery('') } else if (event.key === 'Enter' && searchResults[0]) { event.preventDefault(); openSearchResult(searchResults[0]) } }} /></label>
        {settingsQuery.trim() ? <div className="settings-search-results" role="listbox" aria-label="Settings search results">
          {searchResults.map((entry) => <button type="button" role="option" aria-selected="false" key={entry.page + entry.group + entry.label} onClick={() => openSearchResult(entry)}><span>{entry.label}</span><small>{tabOf(entry.page as SettingsPageId).label} · {entry.group}</small></button>)}
          {!searchResults.length && <p className="settings-search-empty">No settings match.</p>}
        </div> : NAV.map((group) => <div className="settings-nav-group" key={group.label}>
          <span className="settings-nav-label">{group.label}</span>
          {group.tabs.filter((item) => platform.companion || item.label !== 'Companion').map((item) => <button type="button" className={tab === item ? 'selected' : ''} key={item.label} aria-current={tab === item ? 'page' : undefined} onClick={() => switchPage(item.pages[0]!.id)}><item.icon size={15} aria-hidden="true" />{item.label}</button>)}
        </div>)}
      </nav>
        <div className="settings-content">
          {formError && <div className="settings-banner error" role="alert"><ShieldAlert size={15} /><span>{formError}</span></div>}
          {notice && <div className="settings-banner" role="status"><Check size={14} /><span>{notice}</span></div>}
          {loading && <SettingsSkeleton />}

          {!loading && page === 'General' && <>
            {(platform.autostart || platform.tray) && <SettingsGroup title="Startup">
              {platform.autostart && <SettingsRow label="Start with Windows">
                <button type="button" className={`toggle ${startWithWindows ? 'on' : ''}`} role="switch" aria-label="Start with Windows" aria-checked={startWithWindows} onClick={() => void updateAutostart(!startWithWindows)} disabled={saving || !autostartLoaded}><i /></button>
              </SettingsRow>}
              {platform.tray && <SettingsRow label="Close to tray" hint="Closing the window keeps Bitbots running in the tray.">
                <button type="button" className={`toggle ${closeToTray ? 'on' : ''}`} role="switch" aria-label="Close to tray" aria-checked={closeToTray} onClick={() => void updateCloseToTray(!closeToTray)} disabled={saving}><i /></button>
              </SettingsRow>}
            </SettingsGroup>}
            <SettingsGroup title="Notifications">
              <SettingsRow label={`Notify when a ${noun} finishes or needs approval`}>
                <button type="button" className={`toggle ${notificationsEnabled ? 'on' : ''}`} role="switch" aria-label={`Notify when a ${noun} finishes or needs approval`} aria-checked={notificationsEnabled} onClick={() => void setNotifications(!notificationsEnabled)} disabled={saving}><i /></button>
              </SettingsRow>
              {featureRow('approvalBadge')}
            </SettingsGroup>
            <SettingsGroup title="Work">
              <SettingsRow label={`${Nouns} working at once`} hint={`Across every ${noun}. Extra work waits its turn and says so.`}>
                <Select ariaLabel={`${nouns} working at once`} variant="muted" value={String(botsAtOnce)} disabled={saving} onChange={(value) => { const next = Number(value); void saveSetting('concurrency.botsAtOnce', next).then((failure) => { if (!failure) setBotsAtOnce(next) }) }} options={Array.from({ length: 16 }, (_, index) => { const count = index + 1; return { value: String(count), label: String(count) } })} />
              </SettingsRow>
              <SettingsRow label={`Keep this computer awake while ${nouns} work`} hint="Stops Windows sleeping on its own. Closing the lid or choosing Sleep still works.">
                <button type="button" className={`toggle ${keepAwake ? 'on' : ''}`} role="switch" aria-label={`Keep this computer awake while ${nouns} work`} aria-checked={keepAwake} disabled={saving} onClick={() => { const next = !keepAwake; void saveSetting('power.keepAwake', next).then((failure) => { if (!failure) setKeepAwake(next) }) }}><i /></button>
              </SettingsRow>
              {featureRow('resumeAfterUsageLimits')}
              {featureRow('autoRetry')}
              {experiments.autoRetry && <SettingsRow label="Longest retry delay" hint="Stop retrying a temporary failure when its delay would be longer than this.">
                <Select ariaLabel="Longest retry delay" variant="muted" value={String(retryMaxWaitSecs)} disabled={saving} onChange={(value) => { const next = Number(value); void saveSetting('retry.maxWaitSecs', next).then((failure) => { if (!failure) setRetryMaxWaitSecs(next) }) }} options={[{ value: '0', label: 'Do not wait' }, { value: '3600', label: '1 hour' }, { value: '21600', label: '6 hours' }, { value: '86400', label: '24 hours' }]} />
              </SettingsRow>}
            </SettingsGroup>
            <SettingsGroup title="Usage">
              <SettingsRow label="Usage bar" hint="Each coding agent's plan limits along the bottom of the window.">{pageSwitch('Usage bar', usageBarEnabled, 'experimental.usageBar', (next) => onUsageBarChange?.(next))}</SettingsRow>
              <SettingsRow label="Usage tips" hint="A notice above the message box when a coding agent reports 75%, 90% or 100% of a limit.">{pageSwitch('Usage tips', usageTipsEnabled, 'experimental.usageTips', (next) => onUsageTipsChange?.(next))}</SettingsRow>
              <SettingsRow label="Read sign-ins for usage" hint="Lets Bitbots use Claude Code's and OpenCode's saved sign-ins to ask each one for your usage. They're never stored, logged or copied. Codex reports its own.">{pageSwitch('Read sign-ins for usage', readSignIns, 'usage.readCliSignIns', setReadSignIns)}</SettingsRow>
            </SettingsGroup>
            {platform.editor && <SettingsGroup title="Editor">
              <form className="settings-form" onSubmit={(event) => void saveEditor(event)}>
                <label className="settings-field"><span>Editor executable</span><input className="text-input" aria-label="Editor executable" value={editorExecutable} onChange={(event) => setEditorExecutable(event.target.value)} placeholder="Notepad is used when this is empty" /></label>
                <label className="settings-field"><span>Arguments <small>JSON array, {'{file}'} and {'{project}'} are replaced</small></span><input className="text-input mono" aria-label="Editor arguments" value={editorArgs} onChange={(event) => setEditorArgs(event.target.value)} spellCheck={false} /></label>
                <div className="settings-form-actions"><button className="primary-button small" disabled={saving}>Save editor</button></div>
              </form>
            </SettingsGroup>}
          </>}

          {!loading && page === 'Chat' && <>
            <SettingsGroup title="Sending">
              <SettingsRow label="Send a message with" hint={`The other Enter keys add a new line. ${oppositeKeys(sendShortcut)} sends the other way while a bot is working.`}>
                <Select ariaLabel="Send a message with" variant="muted" value={sendShortcut} disabled={saving} onChange={(value) => { const next = normalizeSendShortcut(value); void saveSetting('composer.sendShortcut', next).then((failure) => { if (!failure) { setSendShortcut(next); onSendShortcutChange?.(next) } }) }} options={SEND_SHORTCUTS.map((item) => ({ value: item.value, label: item.label }))} />
              </SettingsRow>
              <SettingsRow label="When you send while a bot is working" hint="Steer reaches the running turn where the coding agent allows it. Queue waits for it to end.">
                <Select ariaLabel="When you send while a bot is working" variant="muted" value={busyMode} disabled={saving} onChange={(value) => { const next = value === 'queue' ? 'queue' : 'steer'; void saveSetting('composer.busySendMode', next).then((failure) => { if (!failure) setBusyMode(next) }) }} options={[{ value: 'steer', label: 'Steer' }, { value: 'queue', label: 'Queue' }]} />
              </SettingsRow>
              <SettingsRow label="Steer a running Codex turn" hint="If the turn has ended, your message queues instead.">{pageSwitch('Steer a running Codex turn', steerGate, 'exec_gate.codex.steer', setSteerGate)}</SettingsRow>
            </SettingsGroup>
            <SettingsGroup title="Conversations">
              <SettingsRow label="Agent activity" hint="What the coding agent did during a reply, as one line you can open.">{pageSwitch('Agent activity', activityDetails, 'experimental.activityDetails', (next) => onActivityDetailsChange?.(next))}</SettingsRow>
              {featureRow('messageActions')}
              {featureRow('changeReview')}
              {featureRow('autoTitles')}
              {featureRow('search')}
              {featureRow('undo')}
            </SettingsGroup>
          </>}

          {!loading && page === 'Companion' && platform.companion && <>
            <SettingsGroup title="Window">
              <SettingsRow label="Show companion">
                <button type="button" className={`toggle ${companionVisible ? 'on' : ''}`} role="switch" aria-label="Show companion" aria-checked={companionVisible} onClick={() => void setCompanion(!companionVisible)} disabled={saving}><i /></button>
              </SettingsRow>
              <SettingsRow label="Open the companion when Bitbots starts">
                <button type="button" className={`toggle ${companionOpenAtStartup ? 'on' : ''}`} role="switch" aria-label="Open the companion when Bitbots starts" aria-checked={companionOpenAtStartup} onClick={() => void saveSetting('companion.openAtStartup', !companionOpenAtStartup).then((failure) => { if (!failure) setCompanionOpenAtStartup(!companionOpenAtStartup) })} disabled={saving}><i /></button>
              </SettingsRow>
              <SettingsRow label="Show/hide with Ctrl+Alt+B">
                <button type="button" className={`toggle ${companionHotkey ? 'on' : ''}`} role="switch" aria-label="Show/hide with Ctrl+Alt+B" aria-checked={companionHotkey} onClick={() => void setHotkey(!companionHotkey)} disabled={saving}><i /></button>
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup title="Position">
              <SettingsRow label="Display">
                <Select ariaLabel="Companion monitor" variant="muted" value={companionMonitor ?? ''} disabled={saving || monitors.length === 0} placeholder="No displays reported" onChange={(value) => void updateCompanionMonitor(value)} options={monitors.map((monitor) => ({ value: monitor, label: monitorLabel(monitor) }))} />
              </SettingsRow>
              <SettingsRow label="Start position">
                <Select ariaLabel="Companion start position" variant="muted" value={startPosition} disabled={saving} onChange={setStartPositionChoice} options={[{ value: 'launch', label: 'Centre, near the bottom' }, { value: 'last', label: 'Where I left it' }]} />
              </SettingsRow>
              <SettingsRow label="Reset position">
                <button type="button" className="secondary-button small" onClick={() => void resetCompanionPosition()} disabled={saving}>Reset</button>
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup title="Attention">
              <SettingsRow label="Sounds" hint={`Short cues when a ${noun} finishes, fails or needs approval.`}>
                <button type="button" className={`toggle ${soundsEnabled ? 'on' : ''}`} role="switch" aria-label="Companion sounds" aria-checked={soundsEnabled} onClick={() => void setSounds(!soundsEnabled)} disabled={saving}><i /></button>
              </SettingsRow>
              {soundsEnabled && <SettingsRow label="Volume">
                <SoundVolumeSlider value={soundVolume} onChange={setSoundVolume} onCommit={(volume) => void saveSoundVolume(volume)} onPlaySample={() => void playSoundSample()} label="Companion sound volume" />
              </SettingsRow>}
              <SettingsRow label="Focus mode" hint="No completion peeks or cues. Approvals and questions still show.">
                <button type="button" className={`toggle ${focusMode ? 'on' : ''}`} role="switch" aria-label="Focus mode" aria-checked={focusMode} onClick={() => void setFocus(!focusMode)} disabled={saving}><i /></button>
              </SettingsRow>
              <OutsideWatchSetting connected={inDesktop && !!snapshot} />
            </SettingsGroup>
          </>}

          {!loading && page === 'Appearance' && <>
            <AppearancePage />
            {style !== 'haze' && <SettingsGroup title="Bot list">
              <SettingsRow label="Coding agent logos" hint={`The logo of the coding agent each ${noun} runs on, beside its name.`}>{pageSwitch('Coding agent logos', runtimeLogos, 'experimental.runtimeLogos', (next) => onRuntimeLogosChange?.(next))}</SettingsRow>
              {featureRow('sidebarModel')}
            </SettingsGroup>}
          </>}

          {!loading && page === 'Keyboard' && <KeybindingEditor first={featureRow('shortcuts')} bindings={bindings} disabled={saving} onSave={async (next) => { const failure = await saveSetting('shortcuts.bindings', next); if (!failure) { setBindings(next); onShortcutBindingsChange?.(next) } return failure ? 'That shortcut could not be saved.' : null }} />}
          {!loading && page === 'Remote' && <RemoteSettings onOpenPower={() => switchPage('General')} />}
          {!loading && page === 'Machines' && <MachinesPage />}
          {!loading && page === 'Accounts' && <AccountsPage runtimes={snapshot?.runtimes ?? EMPTY_RUNTIMES} />}
          {!loading && page === 'Secrets' && <SecretsPage />}
          {!loading && page === 'Connections' && <ConnectionsPage connected={inDesktop && !!snapshot} />}

          {!loading && page === 'Agents' && <>
            <SettingsGroup title="Installed" action={<button type="button" className="ghost-button small" onClick={() => void onRefresh()} disabled={saving || scanStatus.scanning} aria-busy={scanStatus.scanning}><RefreshCw size={13} className={scanStatus.scanning ? 'spinning' : ''} />{scanStatus.scanning ? 'Scanning…' : 'Scan again'}</button>}>
              {(scanStatus.scanning || scanStatus.completedAt !== null) && <p className="settings-scan-status" role="status" data-failed={!!scanStatus.failure}>
                {scanStatus.scanning && <span>Scanning…{scanStatus.failure ? ' ' : ''}</span>}
                {scanStatus.failure ? <span>{scanStatus.failure.step}: {scanStatus.failure.message} <time dateTime={new Date(scanStatus.failure.at).toISOString()} title={new Date(scanStatus.failure.at).toLocaleString()}>{scanTime(scanStatus.failure.at)}</time>{scanStatus.retrying ? ' · Retrying automatically' : ''}</span> : !scanStatus.scanning && <span>{discoveryResultText(scanStatus)} · <time dateTime={new Date(scanStatus.completedAt!).toISOString()} title={new Date(scanStatus.completedAt!).toLocaleString()}>{scanTime(scanStatus.completedAt!)}</time></span>}
              </p>}
              {runtimes.length === 0 && !scanStatus.scanning && <ScanRecovery runtimes={runtimes} scanning={scanStatus.scanning} error={scanStatus.failure ? scanStatus.failure.message : null} onScan={() => void onRefresh()} />}
              {runtimes.map((runtime) => {
                const open = openRuntimes[runtime.id] === true
                const probe = runtimeProbeDetail(runtime)
                const owned = agents.filter((agent) => !agent.parentAgentId && agent.runtimeId === runtime.id)
                return <div className={`runtime-entry ${open ? 'open' : ''}`} key={runtime.id}>
                  <button type="button" className="settings-row runtime-entry-head" aria-expanded={open} onClick={() => setOpenRuntimes((current) => ({ ...current, [runtime.id]: !open }))}>
                    <ProviderLogo provider={runtime.provider} />
                    <span className="settings-row-copy"><strong>{providerDisplayName(runtime.provider)}</strong><small>{[runtime.version, runtimeAuthSummary(runtime).label].filter(Boolean).join(' · ') || 'Details unavailable'}</small>{probe && <small className="runtime-probe-error">{probe.step}: {probe.message}</small>}</span>
                    <span className="settings-value">{owned.length === 1 ? `1 ${noun}` : `${owned.length} ${nouns}`}</span>
                    {open ? <ChevronDown size={15} className="row-chevron" aria-hidden="true" /> : <ChevronRight size={15} className="row-chevron" aria-hidden="true" />}
                  </button>
                  {needsSignIn(runtime) && <div className="runtime-sign-in"><SignInHelp provider={runtime.provider} runtimeId={runtime.id} onChecked={() => void onRefresh()} /></div>}
                  {open && <div className="runtime-entry-body">
                    <dl className="settings-facts">
                      <div><dt>Status</dt><dd>{labelize(runtime.status, 'Unknown')}</dd></div>
                      <div><dt>Sign-in</dt><dd>{runtimeAuthSummary(runtime).label}</dd></div>
                      <div><dt>Protocol</dt><dd>{labelize(runtime.protocolFamily, 'Unknown')}</dd></div>
                      <div><dt>Executable</dt><dd className="mono">{runtime.executablePath ?? 'Unknown'}</dd></div>
                    </dl>
                    {probe && <p className="runtime-recovery-guidance" role="note">{runtime.probeStep === 'Sign-in check' ? <>Check this provider&apos;s CLI sign-in, then choose <strong>Scan again</strong> above. The protocol check passed.</> : <>Update or repair this CLI, then choose <strong>Scan again</strong> above.</>}</p>}
                    {owned.length === 0 ? <p className="settings-empty">No {nouns} use this agent yet.</p> : owned.map((agent) => <BlobLink key={agent.id} agent={agent} mode={modeFor(agent)} onOpen={() => onOpenAgent(agent.id)} />)}
                  </div>}
                </div>
              })}
              {orphanAgents.length > 0 && <div className="runtime-entry open">
                <div className="settings-row"><RowCopy label={`${Nouns} without a detected agent`} hint="Their command line tool was not found on this device." /></div>
                <div className="runtime-entry-body">{orphanAgents.map((agent) => <BlobLink key={agent.id} agent={agent} mode={modeFor(agent)} onOpen={() => onOpenAgent(agent.id)} />)}</div>
              </div>}
            </SettingsGroup>
            <HarnessUpdatesNotice runtimes={runtimes} onRefresh={onRefresh} />
            <SettingsGroup title="Claude Code">
              <SettingsRow label="Dynamic workflows and Ultracode" hint="New Claude Code sessions ask for workflows, which also makes the Ultracode effort available. Bitbots doesn't edit Claude's config.">{pageSwitch('Claude dynamic workflows', claudeWorkflowsEnabled, 'claude.enableWorkflows', (next) => onClaudeWorkflowsChange?.(next))}</SettingsRow>
            </SettingsGroup>
            <SettingsGroup title="Custom launchers">
              {profiles.map((profile, index) => <div className="settings-row" key={String(profile.id ?? index)}>
                <span className="settings-row-copy"><strong>{String(profile.name ?? profile.provider ?? 'Launcher')}</strong><small className="mono">{String(profile.executablePath ?? 'Executable unavailable')}</small></span>
                {typeof profile.id === 'string' && <button type="button" className="ghost-button small" onClick={() => setProfileDeleteTarget({ id: profile.id as string, name: String(profile.name ?? 'this launcher') })}>Remove</button>}
              </div>)}
              {!launcherFormOpen && <div className="settings-row">
                <RowCopy label={profiles.length === 0 ? 'No custom launchers' : 'Add another launcher'} hint="Run an agent from a specific executable with fixed arguments." />
                <button type="button" className="secondary-button small" onClick={() => setLauncherFormOpen(true)}><Plus size={13} />Add launcher</button>
              </div>}
              {launcherFormOpen && <form className="settings-form" onSubmit={(event) => void saveProfile(event)}>
                <label className="settings-field"><span>Name</span><input className="text-input" aria-label="Profile name" value={profileName} onChange={(event) => setProfileName(event.target.value)} required /></label>
                <div className="settings-field-pair">
                  <div className="settings-field"><span>Agent</span><Select ariaLabel="Profile provider" variant="field" align="left" value={profileProvider} onChange={(value) => { setProfileProvider(value); setProfileProtocol(value === 'claude' ? 'claude_stream' : value === 'opencode' ? 'acp' : 'codex_app_server') }} options={['claude', 'codex', 'opencode'].map((provider) => ({ value: provider, label: providerBrand(provider).name, provider }))} /></div>
                  <div className="settings-field"><span>Protocol</span><Select ariaLabel="Profile protocol" variant="field" align="left" value={profileProtocol} onChange={setProfileProtocol} options={[{ value: 'claude_stream', label: 'Claude stream' }, { value: 'codex_app_server', label: 'Codex app-server' }, { value: 'acp', label: 'ACP' }]} /></div>
                </div>
                <label className="settings-field"><span>Executable path</span><input className="text-input mono" aria-label="Profile executable" value={profilePath} onChange={(event) => setProfilePath(event.target.value)} required /></label>
                <label className="settings-field"><span>Fixed arguments <small>JSON array</small></span><input className="text-input mono" aria-label="Profile arguments" value={profileArgs} onChange={(event) => setProfileArgs(event.target.value)} spellCheck={false} /></label>
                <div className="settings-form-actions"><button type="button" className="ghost-button small" onClick={() => setLauncherFormOpen(false)}>Cancel</button><button className="primary-button small" disabled={saving}>Save launcher</button></div>
              </form>}
            </SettingsGroup>
          </>}

          {!loading && page === 'Manager' && <ManagerPage manager={managerOf(snapshot?.agents ?? [])} connected={!!snapshot} onOpenManager={onOpenAgent} agents={snapshot?.agents ?? []} onOpenSession={onOpenSession} />}

          {!loading && page === 'Approvals' && <>
            <SettingsGroup title="Defaults">
              <SettingsRow label="Default approval" hint="For bots without their own setting. Scheduled work always stays on safe actions.">
                {policyError
                  ? <span className="settings-unavailable"><span className="settings-value">Unavailable</span><Select ariaLabel="Default approval mode" variant="muted" value="ask" disabled onChange={() => undefined} options={[{ value: 'ask', label: 'Ask' }]} /></span>
                  : <Select ariaLabel="Default approval mode" variant="muted" value={defaultMode} disabled={saving} onChange={(value) => void saveDefaultMode(value)} options={[{ value: 'ask', label: 'Ask' }, { value: 'accept_edits', label: 'Auto-accept edits' }, { value: 'auto', label: 'Auto-approve' }, { value: 'bypass', label: 'Full access' }]} />}
              </SettingsRow>
              {featureRow('botLock')}
            </SettingsGroup>
            <ApprovalRulesPage agents={snapshot?.agents ?? []} projects={snapshot?.projects ?? []} />
          </>}
          {!loading && page === 'Health' && <>
            <HealthPage />
            <SettingsGroup title="Support">
              <SettingsRow label="Run setup again">
                <button type="button" className="secondary-button small" onClick={onRunSetup}>Run setup</button>
              </SettingsRow>
              <SettingsRow label="Export diagnostics" hint="A zip of recent logs, versions and settings, with message text and secrets removed. Nothing is uploaded.">
                <button type="button" className="secondary-button small" onClick={() => setDiagnosticsOpen(true)} disabled={saving}>Export</button>
              </SettingsRow>
            </SettingsGroup>
          </>}
          {!loading && page === 'Memory' && <MemoryPage
            agents={snapshot?.agents ?? []}
            projects={snapshot?.projects ?? []}
            enabled={experiments.memory}
            sharedWrites={sharedMemoryWrites}
            onSharedWritesChange={async (next) => { await rpc('settings.set', { key: 'memory.sharedAgentWrites', value: next }); setSharedMemoryWrites(next) }}
            about={profileAbout}
            connected={inDesktop}
            onEnabledChange={async (next) => { await rpc('settings.set', { key: 'experimental.memory', value: next }); onExperimentChange?.('memory', next) }}
            onAboutSave={async (text) => { await rpc('settings.set', { key: 'profile.about', value: text }); setProfileAbout(text) }} />}

          {!loading && page === 'Speech' && <>
            <SettingsGroup title="Microphone">
              <SettingsRow label="Dictation" hint="The microphone in the message box and the companion, and Ctrl+E.">
                <button type="button" className={`toggle ${speechEnabled ? 'on' : ''}`} role="switch" aria-label="Dictation" aria-checked={speechEnabled} disabled={saving} onClick={() => { const next = !speechEnabled; void saveSetting('speech.enabled', next).then((failure) => { if (!failure) onSpeechEnabledChange?.(next) }) }}><i /></button>
              </SettingsRow>
              <SettingsRow label="Keyboard shortcut" hint={speechEnabled ? 'Starts or stops dictation from any window.' : 'Free for other apps while dictation is off.'}><Keys keys="Ctrl+E" /></SettingsRow>
              <SettingsRow label="Transcription engine">
                <Select ariaLabel="Transcription engine" variant="muted" value={speechEngine === 'local' ? 'local' : 'automatic'} disabled={saving} onChange={(value) => chooseSpeechEngine(normalizeEngineChoice(value))} options={[
                  { value: 'local', label: 'On device' },
                  { value: 'automatic', label: 'Cloud' },
                ]} />
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup title="Speech model">
              {speechModels.length === 0 && <p className="settings-empty">No speech models reported.</p>}
              <div className={`speech-models ${speechEnabled ? '' : 'muted'}`} role="radiogroup" aria-label="Speech model for dictation">
              {speechModels.map((model) => {
                const ready = speechReady[model.id] === true
                const busy = speechBusy === model.id
                const percent = Math.round((speechProgress[model.id] ?? 0) * 100)
                const inUse = ready && (speechModel ? speechModel === model.id : model.recommended)
                return <div className={`settings-row speech-model-row ${inUse ? 'in-use' : ''}`} key={model.id}>
                  <RowCopy label={<>{model.label}{model.recommended && <span className="speech-model-tag">Recommended</span>}</>} hint={model.description} detail={formatBytes(model.sizeBytes)} />
                  <span className="settings-row-control">
                    {busy
                      ? <span className="speech-model-progress" role="progressbar" aria-label={`Downloading ${model.label}`} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${percent}%` }} /><b>{percent}%</b></span>
                      : ready
                        ? <button type="button" role="radio" aria-checked={inUse} className={`speech-model-use ${inUse ? 'on' : ''}`} disabled={saving || inUse} onClick={() => { void saveSetting('speech.model', model.id).then((failure) => { if (!failure) onSpeechModelChange?.(model.id) }) }}>{inUse ? <><Check size={13} aria-hidden="true" />In use</> : 'Use'}</button>
                        : <button type="button" className="secondary-button small" onClick={() => void downloadModel(model.id)} disabled={saving || speechBusy !== null}><Download size={13} />Download</button>}
                  </span>
                </div>
              })}
              </div>
            </SettingsGroup>
          </>}

          {consentFor && <ConfirmDialog title="Use cloud dictation?" body="Each recording is sent to OpenAI's ChatGPT transcription service using your signed-in Codex account, which Bitbots reads from Codex's own file on this computer. Recordings, text and the sign-in are not stored or logged by Bitbots. If the cloud is unavailable, dictation uses the on-device model when it is installed. Choose On device in Settings to stop." confirmLabel="Allow cloud" cancelLabel="Keep on device" onCancel={() => setConsentFor(null)} onConfirm={async () => { const engine = consentFor; setConsentFor(null); await applySpeechEngine(engine, true) }} />}
          {!loading && page === 'Skills' && <SkillsPage connected={inDesktop} />}

          {!loading && page === 'Backup' && <BackupPage connected={inDesktop} />}

          {!loading && page === 'Updates' && <>
            {platform.updater && <UpdatesPanel sessions={snapshot?.sessions ?? []} permissions={snapshot?.permissions ?? []} />}
          </>}

        </div>
      </section>
      {profileDeleteTarget && <ConfirmDialog title={`Remove ${profileDeleteTarget.name}?`} body="This removes the custom launcher profile from Bitbots. It does not uninstall the coding agent." confirmLabel="Remove" cancelLabel="Keep launcher" holdToConfirm successTitle="Launcher removed" successBody="The custom launcher profile was removed from Bitbots." onConfirm={async () => { await deleteProfile(profileDeleteTarget.id) }} onComplete={() => setProfileDeleteTarget(null)} onCancel={() => setProfileDeleteTarget(null)} />}
      {diagnosticsOpen && <DiagnosticsDialog onClose={() => setDiagnosticsOpen(false)} />}
      {confirmFullDefault && <ConfirmDialog title="Make Full access the default?" body={`Every ${noun} without its own setting will run commands and change files without asking you, in every project. Scheduled work still stays on safe actions. You can still set any ${noun} to ask.`} confirmLabel="Make it the default" cancelLabel="Keep the current default" tone="danger" onConfirm={() => void saveDefaultMode('bypass', true)} onCancel={() => setConfirmFullDefault(false)} />}
    </div>
}

function BlobLink({ agent, mode, onOpen }: { agent: Agent; mode: string; onOpen: () => void }) {
  return <div className="blob-link">
    <span className="blob-link-dot" style={{ background: agentColorHex(agent.color) }} aria-hidden="true" />
    <span className="settings-row-copy"><strong>{agent.name}</strong><small>{approvalLabel(mode)}</small></span>
    <button type="button" className="ghost-button small" aria-label={`Open ${agent.name}`} onClick={onOpen}>Open</button>
  </div>
}

function approvalLabel(mode: string) {
  if (mode === 'bypass') return 'Bypass approvals'
  if (mode === 'auto') return 'Auto-approve'
  if (mode === 'accept_edits') return 'Auto-accept edits'
  return 'Ask before acting'
}

function monitorLabel(monitor: string) {
  const match = /DISPLAY(\d+)$/i.exec(monitor)
  return match ? `Display ${match[1]}` : monitor
}

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

function messageOf(reason: unknown) {
  if (reason instanceof Error) return reason.message
  return typeof reason === 'string' ? reason : 'The local daemon request failed.'
}

function recordFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function listFrom(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
  const record = recordFrom(value)
  const list = Object.values(record).find((item) => Array.isArray(item))
  return Array.isArray(list) ? list.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : []
}
