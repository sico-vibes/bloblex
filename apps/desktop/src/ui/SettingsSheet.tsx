import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { emit, listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { Bot, Check, ChevronDown, ChevronRight, Download, Mic, Plus, RefreshCw, ShieldAlert, SlidersHorizontal, X } from 'lucide-react'
import type { Agent, Snapshot } from '../types'
import { labelize } from '../types'
import { effectiveApprovalMode, parseGlobalMode, type PermissionsPolicy } from '../approvalContract'
import { companionMonitorOptions, currentCompanionMonitor, inDesktop, permissionsPolicyGet, rpc, setCloseToTray, setCompanionMonitor, setCompanionVisibility } from '../tauri'
import { agentColorHex } from './agentColor'
import { useDialogAccessibility } from './dialogFocus'
import { Select } from './Select'
import { UpdatesPanel } from './UpdatesPanel'
import { autostartEnabled, setAutostartEnabled } from '../desktopIntegrations'
import { applyAppearance } from './appearance'
import { ProviderLogo, providerBrand } from './providerBrand'
import { runtimeAuthSummary } from './launchChecks'
import { ConfirmDialog } from './BlobPage'

export type SettingsPageId = 'General' | 'Agents' | 'Speech' | 'Updates'

const PAGES: Array<{ id: SettingsPageId; label: string; icon: typeof SlidersHorizontal }> = [
  { id: 'General', label: 'General', icon: SlidersHorizontal },
  { id: 'Agents', label: 'Agents', icon: Bot },
  { id: 'Speech', label: 'Speech', icon: Mic },
  { id: 'Updates', label: 'Updates', icon: Download },
]

type SpeechModelRow = { id: string; label: string; description: string; language: string; streaming: boolean; recommended: boolean; sizeBytes: number }

export function providerDisplayName(provider: string | undefined) {
  return providerBrand(provider ?? '').name || labelize(provider, 'Coding agent')
}

export function SettingsSheet({ snapshot, initialPage, onClose, onRefresh, onError, onOpenAgent, onRunSetup = () => undefined, focusUpdates = false }: {
  snapshot: Snapshot | null
  initialPage: SettingsPageId
  onClose: () => void
  onRefresh: () => void
  onError: (error: string | null) => void
  onOpenAgent: (agentId: string) => void
  onRunSetup?: () => void
  focusUpdates?: boolean
}) {
  const { ref: dialogRef, close } = useDialogAccessibility(onClose)
  const [page, setPage] = useState<SettingsPageId>(focusUpdates ? 'Updates' : initialPage)
  const [loading, setLoading] = useState(false)
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
  const [startPosition, setStartPosition] = useState<'launch' | 'last'>('launch')
  const [companionHotkey, setCompanionHotkey] = useState(true)
  const [appearanceTheme, setAppearanceTheme] = useState<'system' | 'dark' | 'light'>('system')
  const [textSize, setTextSize] = useState<'small' | 'default' | 'large' | 'larger'>('default')
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
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
  const [defaultMode, setDefaultMode] = useState<'ask' | 'auto'>('ask')
  const [openRuntimes, setOpenRuntimes] = useState<Record<string, boolean>>({})
  const [speechModels, setSpeechModels] = useState<SpeechModelRow[]>([])
  const [speechReady, setSpeechReady] = useState<Record<string, boolean>>({})
  const [speechProgress, setSpeechProgress] = useState<Record<string, number>>({})
  const [speechBusy, setSpeechBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!inDesktop) return
    setLoading(true)
    setFormError(null)
    try {
      const [settingsResult, profileResult] = await Promise.all([
        rpc<Record<string, unknown>>('settings.get').catch((reason) => ({ loadError: messageOf(reason) })),
        rpc('runtime.profile.list').catch((reason) => ({ loadError: messageOf(reason) })),
      ])
      const preferences = recordFrom(settingsResult)
      const settings = recordFrom(preferences.settings ?? preferences)
      if (typeof settings['companion.openAtStartup'] === 'boolean') setCompanionOpenAtStartup(settings['companion.openAtStartup'])
      if (typeof settings.closeToTray === 'boolean') setCloseToTrayValue(settings.closeToTray)
      if (typeof settings['companion.soundsEnabled'] === 'boolean') setSoundsEnabled(settings['companion.soundsEnabled'])
      if (settings['companion.startPosition'] === 'last') setStartPosition('last')
      if (typeof settings['companion.hotkey'] === 'boolean') setCompanionHotkey(settings['companion.hotkey'])
      if (settings['companion.hotkey'] !== false) {
        try {
          const registered = await invoke<boolean>('companion_hotkey_registered')
          setCompanionHotkey(registered)
          if (!registered) {
            await rpc('settings.set', { key: 'companion.hotkey', value: false }).catch(() => undefined)
            setFormError('Ctrl+Alt+B is used by another app. The companion shortcut is off.')
          }
        } catch { /* Shortcut support may be unavailable on this platform. */ }
      }
      if (settings['appearance.theme'] === 'dark' || settings['appearance.theme'] === 'light' || settings['appearance.theme'] === 'system') setAppearanceTheme(settings['appearance.theme'])
      if (['small', 'default', 'large', 'larger'].includes(String(settings['appearance.textSize']))) setTextSize(settings['appearance.textSize'] as typeof textSize)
      setNotificationsEnabled(settings['notifications.enabled'] !== false)
      if (typeof settings.editorExecutable === 'string') setEditorExecutable(settings.editorExecutable)
      if (Array.isArray(settings.editorArgs) && settings.editorArgs.every((argument) => typeof argument === 'string')) setEditorArgs(JSON.stringify(settings.editorArgs))
      if (settings['permissions.default_mode'] === 'ask' || settings['permissions.default_mode'] === 'auto') setDefaultMode(settings['permissions.default_mode'])
      setProfiles(listFrom(profileResult))
      try {
        const next = await permissionsPolicyGet()
        setPolicy(next)
        setDefaultMode(next.defaultMode)
        setPolicyError(null)
      } catch (reason) {
        setPolicy(null)
        setPolicyError(messageOf(reason))
      }
    } finally { setLoading(false) }
    void Promise.all([companionMonitorOptions(), currentCompanionMonitor()]).then(([available, current]) => {
      setMonitors(available)
      setCompanionMonitorValue(current)
    }).catch(() => { setMonitors([]); setCompanionMonitorValue(null) })
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined
    if (inDesktop) {
      void listen<boolean>('bloblex-companion-visible-changed', ({ payload }) => {
        companionVisibilityRevision.current += 1
        setCompanionVisible(payload)
      }).then((stop) => {
        if (!active) { stop(); return }
        unlisten = stop
        const revisionAtRead = companionVisibilityRevision.current
        void invoke<boolean>('companion_visible').then((visible) => {
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
    if (!inDesktop) return
    try {
      const models = await invoke<SpeechModelRow[]>('speech_models')
      setSpeechModels(models)
      const entries = await Promise.all(models.map(async (model) => {
        try { return [model.id, (await invoke<{ ready: boolean }>('speech_model_status', { modelId: model.id })).ready] as const }
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
      unlisten = await listen<{ modelId: string; completed: number; total: number }>('bloblex-speech-download', ({ payload }) => {
        if (payload.modelId !== modelId) return
        setSpeechProgress((current) => ({ ...current, [modelId]: payload.total ? payload.completed / payload.total : 0 }))
      })
      await invoke('speech_model_download', { modelId })
      setSpeechReady((current) => ({ ...current, [modelId]: true }))
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
  const setStartPositionChoice = (value: string) => {
    if (value !== 'launch' && value !== 'last') return
    void saveSetting('companion.startPosition', value).then((failure) => { if (!failure) setStartPosition(value) })
  }
  const setHotkey = async (enabled: boolean) => {
    setNotice(null)
    const failure = await guarded(async () => {
      await invoke('set_companion_hotkey', { enabled })
      await rpc('settings.set', { key: 'companion.hotkey', value: enabled })
      setCompanionHotkey(enabled)
    })
    if (failure) {
      try { setCompanionHotkey(await invoke<boolean>('companion_hotkey_registered')) } catch { setCompanionHotkey(false) }
      setFormError(enabled && failure.includes('already in use')
        ? 'Ctrl+Alt+B is used by another app. The companion shortcut is off.'
        : failure)
    }
  }
  const updateAppearance = (theme: typeof appearanceTheme, size: typeof textSize) => guarded(async () => {
    await rpc('settings.set', { key: 'appearance.theme', value: theme })
    await rpc('settings.set', { key: 'appearance.textSize', value: size })
    try { localStorage.setItem('bloblex.appearance', JSON.stringify({ theme, textSize: size })) } catch { /* The daemon remains the persisted source. */ }
    document.documentElement.dataset.themeChoice = theme
    applyAppearance(document.documentElement, theme, size)
    setAppearanceTheme(theme)
    setTextSize(size)
    setNotice('Appearance updated.')
  })
  const updateCloseToTray = (enabled: boolean) => guarded(async () => { await setCloseToTray(enabled); setCloseToTrayValue(enabled) })
  const updateAutostart = (enabled: boolean) => guarded(async () => {
    await setAutostartEnabled(enabled)
    setStartWithWindows(await autostartEnabled())
  })
  const setNotifications = (enabled: boolean) => guarded(async () => {
    await rpc('settings.set', { key: 'notifications.enabled', value: enabled })
    setNotificationsEnabled(enabled)
    try { await emit('bloblex-notifications-enabled-changed', enabled) } catch { /* The main window refreshes the saved preference on reconnect. */ }
  })
  const updateCompanionMonitor = (monitorName: string) => guarded(async () => {
    await setCompanionMonitor(monitorName)
    setCompanionMonitorValue(monitorName)
    setNotice(`Companion moved to ${monitorName}.`)
  })

  const setSounds = async (enabled: boolean) => {
    setSoundsEnabled(enabled)
    const failure = await guarded(async () => {
      await rpc('settings.set', { key: 'companion.soundsEnabled', value: enabled })
      try { await emit('bloblex-sounds-changed', enabled) } catch { /* the companion hydrates the saved value on its next connection */ }
      setNotice(enabled ? 'Companion sounds enabled.' : 'Companion sounds muted.')
    })
    if (failure) { setSoundsEnabled(!enabled); onError(failure) }
  }

  const saveDefaultMode = async (value: string) => {
    const mode = parseGlobalMode(value)
    if (value !== 'ask' && value !== 'auto') return
    const failure = await guarded(async () => {
      await rpc('settings.set', { key: 'permissions.default_mode', value: mode })
      setDefaultMode(mode)
      setNotice(mode === 'auto' ? 'Blobs without their own setting now auto-approve low-risk actions.' : 'Blobs without their own setting now ask first.')
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

  const runtimes = snapshot?.runtimes ?? []
  const agents = (snapshot?.agents ?? []).filter((agent) => !agent.archived)
  const orphanAgents = agents.filter((agent) => !runtimes.some((runtime) => runtime.id === agent.runtimeId))
  const modeFor = (agent: Agent) => policy?.perAgent.find((row) => row.agentId === agent.id)?.effectiveMode ?? effectiveApprovalMode(agent) ?? defaultMode
  const switchPage = (next: SettingsPageId) => { setPage(next); setFormError(null); setNotice(null) }

  return <div className="sheet-backdrop settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
    <section ref={dialogRef} className="settings-sheet" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1}>
      <header className="settings-page-head">
        <h2 id="settings-title">{page}</h2>
        <button type="button" className="icon-button" data-dialog-initial-focus aria-label="Close settings" onClick={close}><X size={17} aria-hidden="true" /></button>
      </header>
      <nav className="settings-nav" aria-label="Settings pages">
        {PAGES.map((item) => <button type="button" className={page === item.id ? 'selected' : ''} key={item.id} aria-current={page === item.id ? 'page' : undefined} onClick={() => switchPage(item.id)}><item.icon size={16} aria-hidden="true" />{item.label}</button>)}
      </nav>
        <div className="settings-content">
          {formError && <div className="settings-banner error" role="alert"><ShieldAlert size={15} /><span>{formError}</span></div>}
          {notice && <div className="settings-banner" role="status"><Check size={14} /><span>{notice}</span></div>}
          {loading && <div className="settings-loading">Loading settings…</div>}

          {!loading && page === 'General' && <>
            <SettingsGroup title="System">
              <SettingsRow label="Run setup again" hint="Review the welcome steps and coding agent sign-in status.">
                <button type="button" className="secondary-button small" onClick={onRunSetup}>Run setup</button>
              </SettingsRow>
              <SettingsRow label="Start with Windows">
                <button type="button" className={`toggle ${startWithWindows ? 'on' : ''}`} role="switch" aria-label="Start with Windows" aria-checked={startWithWindows} onClick={() => void updateAutostart(!startWithWindows)} disabled={saving || !autostartLoaded}><i /></button>
              </SettingsRow>
              <SettingsRow label="Close to tray" hint="Closing the window keeps Bloblex running in the tray.">
                <button type="button" className={`toggle ${closeToTray ? 'on' : ''}`} role="switch" aria-label="Close to tray" aria-checked={closeToTray} onClick={() => void updateCloseToTray(!closeToTray)} disabled={saving}><i /></button>
              </SettingsRow>
              <SettingsRow label="Companion display" hint="The companion starts at the bottom center of this display.">
                <Select ariaLabel="Companion monitor" variant="muted" value={companionMonitor ?? ''} disabled={saving || monitors.length === 0} placeholder="No displays reported" onChange={(value) => void updateCompanionMonitor(value)} options={monitors.map((monitor) => ({ value: monitor, label: monitorLabel(monitor) }))} />
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup title="Companion">
              <SettingsRow label="Open the companion when Bloblex starts">
                <button type="button" className={`toggle ${companionOpenAtStartup ? 'on' : ''}`} role="switch" aria-label="Open the companion when Bloblex starts" aria-checked={companionOpenAtStartup} onClick={() => void saveSetting('companion.openAtStartup', !companionOpenAtStartup).then((failure) => { if (!failure) setCompanionOpenAtStartup(!companionOpenAtStartup) })} disabled={saving}><i /></button>
              </SettingsRow>
              <SettingsRow label="Start position">
                <Select ariaLabel="Companion start position" variant="muted" value={startPosition} disabled={saving} onChange={setStartPositionChoice} options={[{ value: 'launch', label: 'Centre, near the bottom' }, { value: 'last', label: 'Where I left it' }]} />
              </SettingsRow>
              <SettingsRow label="Show/hide with Ctrl+Alt+B">
                <button type="button" className={`toggle ${companionHotkey ? 'on' : ''}`} role="switch" aria-label="Show/hide with Ctrl+Alt+B" aria-checked={companionHotkey} onClick={() => void setHotkey(!companionHotkey)} disabled={saving}><i /></button>
              </SettingsRow>
              <SettingsRow label="Show companion">
                <button type="button" className={`toggle ${companionVisible ? 'on' : ''}`} role="switch" aria-label="Show companion" aria-checked={companionVisible} onClick={() => void setCompanion(!companionVisible)} disabled={saving}><i /></button>
              </SettingsRow>
              <SettingsRow label="Sounds" hint="Short cues when a blob finishes, fails or needs approval.">
                <button type="button" className={`toggle ${soundsEnabled ? 'on' : ''}`} role="switch" aria-label="Companion sounds" aria-checked={soundsEnabled} onClick={() => void setSounds(!soundsEnabled)} disabled={saving}><i /></button>
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup title="Appearance">
              <SettingsRow label="Theme">
                <Select ariaLabel="Theme" variant="muted" value={appearanceTheme} disabled={saving} onChange={(value) => { if (value === 'system' || value === 'dark' || value === 'light') void updateAppearance(value, textSize) }} options={[{ value: 'system', label: 'Follow system' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
              </SettingsRow>
              <SettingsRow label="Text size">
                <Select ariaLabel="Text size" variant="muted" value={textSize} disabled={saving} onChange={(value) => { if (['small', 'default', 'large', 'larger'].includes(value)) void updateAppearance(appearanceTheme, value as typeof textSize) }} options={[{ value: 'small', label: 'Small 13' }, { value: 'default', label: 'Default 14' }, { value: 'large', label: 'Large 15' }, { value: 'larger', label: 'Larger 16' }]} />
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup title="Editor">
              <form className="settings-form" onSubmit={(event) => void saveEditor(event)}>
                <label className="settings-field"><span>Editor executable</span><input className="text-input" aria-label="Editor executable" value={editorExecutable} onChange={(event) => setEditorExecutable(event.target.value)} placeholder="Notepad is used when this is empty" /></label>
                <label className="settings-field"><span>Arguments <small>JSON array, {'{file}'} and {'{project}'} are replaced</small></span><input className="text-input mono" aria-label="Editor arguments" value={editorArgs} onChange={(event) => setEditorArgs(event.target.value)} spellCheck={false} /></label>
                <div className="settings-form-actions"><button className="primary-button small" disabled={saving}>Save editor</button></div>
              </form>
            </SettingsGroup>
            <SettingsGroup title="Notifications">
              <SettingsRow label="Notify when a blob finishes or needs approval">
                <button type="button" className={`toggle ${notificationsEnabled ? 'on' : ''}`} role="switch" aria-label="Notify when a blob finishes or needs approval" aria-checked={notificationsEnabled} onClick={() => void setNotifications(!notificationsEnabled)} disabled={saving}><i /></button>
              </SettingsRow>
            </SettingsGroup>
          </>}

          {!loading && page === 'Agents' && <>
            <p className="settings-intro">Bloblex runs the coding agents installed on this device. Sign in with each agent's own command line tool; Bloblex never handles your provider login.</p>
            <SettingsGroup title="Approvals">
              <SettingsRow label="Default approval" hint="Ask waits for you. Auto-approve allows low-risk actions inside the project. Bypass can only be turned on for a single blob.">
                {policyError
                  ? <span className="settings-unavailable"><span className="settings-value">Unavailable</span><Select ariaLabel="Default approval mode" variant="muted" value="ask" disabled onChange={() => undefined} options={[{ value: 'ask', label: 'Ask' }]} /></span>
                  : <Select ariaLabel="Default approval mode" variant="muted" value={defaultMode} disabled={saving} onChange={(value) => void saveDefaultMode(value)} options={[{ value: 'ask', label: 'Ask' }, { value: 'auto', label: 'Auto-approve' }]} />}
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup title="Coding agents" action={<button type="button" className="ghost-button small" onClick={onRefresh} disabled={saving}><RefreshCw size={13} />Scan again</button>}>
              {runtimes.length === 0 && <p className="settings-empty">No coding agents found on this device.</p>}
              {runtimes.map((runtime) => {
                const open = openRuntimes[runtime.id] === true
                const owned = agents.filter((agent) => agent.runtimeId === runtime.id)
                return <div className={`runtime-entry ${open ? 'open' : ''}`} key={runtime.id}>
                  <button type="button" className="settings-row runtime-entry-head" aria-expanded={open} onClick={() => setOpenRuntimes((current) => ({ ...current, [runtime.id]: !open }))}>
                    <ProviderLogo provider={runtime.provider} />
                    <span className="settings-row-copy"><strong>{providerDisplayName(runtime.provider)}</strong><small>{[runtime.version, runtimeAuthSummary(runtime).label].filter(Boolean).join(' · ') || 'Details unavailable'}</small></span>
                    <span className="settings-value">{owned.length === 1 ? '1 blob' : `${owned.length} blobs`}</span>
                    {open ? <ChevronDown size={15} className="row-chevron" aria-hidden="true" /> : <ChevronRight size={15} className="row-chevron" aria-hidden="true" />}
                  </button>
                  {open && <div className="runtime-entry-body">
                    <dl className="settings-facts">
                      <div><dt>Status</dt><dd>{labelize(runtime.status, 'Unknown')}</dd></div>
                      <div><dt>Sign-in</dt><dd>{runtimeAuthSummary(runtime).label}</dd></div>
                      <div><dt>Protocol</dt><dd>{labelize(runtime.protocolFamily, 'Unknown')}</dd></div>
                      <div><dt>Executable</dt><dd className="mono">{runtime.executablePath ?? 'Unknown'}</dd></div>
                    </dl>
                    {owned.length === 0 ? <p className="settings-empty">No blobs use this agent yet.</p> : owned.map((agent) => <BlobLink key={agent.id} agent={agent} mode={modeFor(agent)} onOpen={() => onOpenAgent(agent.id)} />)}
                  </div>}
                </div>
              })}
              {orphanAgents.length > 0 && <div className="runtime-entry open">
                <div className="settings-row"><span className="settings-row-copy"><strong>Blobs without a detected agent</strong><small>Their command line tool was not found on this device.</small></span></div>
                <div className="runtime-entry-body">{orphanAgents.map((agent) => <BlobLink key={agent.id} agent={agent} mode={modeFor(agent)} onOpen={() => onOpenAgent(agent.id)} />)}</div>
              </div>}
            </SettingsGroup>
            <SettingsGroup title="Custom launchers">
              {profiles.map((profile, index) => <div className="settings-row" key={String(profile.id ?? index)}>
                <span className="settings-row-copy"><strong>{String(profile.name ?? profile.provider ?? 'Launcher')}</strong><small className="mono">{String(profile.executablePath ?? 'Executable unavailable')}</small></span>
                {typeof profile.id === 'string' && <button type="button" className="ghost-button small" onClick={() => setProfileDeleteTarget({ id: profile.id as string, name: String(profile.name ?? 'this launcher') })}>Remove</button>}
              </div>)}
              {!launcherFormOpen && <div className="settings-row">
                <span className="settings-row-copy"><strong>{profiles.length === 0 ? 'No custom launchers' : 'Add another launcher'}</strong><small>Run an agent from a specific executable with fixed arguments.</small></span>
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

          {!loading && page === 'Speech' && <>
            <p className="settings-intro">Dictation runs on this device with sherpa-onnx. Download a model once; your audio is never uploaded.</p>
            <SettingsGroup title="Speech models">
              {speechModels.length === 0 && <p className="settings-empty">No speech models reported.</p>}
              {speechModels.map((model) => {
                const ready = speechReady[model.id] === true
                const busy = speechBusy === model.id
                const percent = Math.round((speechProgress[model.id] ?? 0) * 100)
                return <div className="settings-row" key={model.id}>
                  <span className="settings-row-copy">
                    <strong>{model.label}{model.recommended ? ' · Recommended' : ''}</strong>
                    <small>{model.description} · {formatBytes(model.sizeBytes)}</small>
                  </span>
                  <span className="settings-row-control">
                    {busy
                      ? <span className="settings-value">{percent}%</span>
                      : ready
                        ? <span className="settings-value">Ready</span>
                        : <button type="button" className="secondary-button small" onClick={() => void downloadModel(model.id)} disabled={saving || speechBusy !== null}><Download size={13} />Download</button>}
                  </span>
                </div>
              })}
            </SettingsGroup>
            <SettingsGroup title="Dictation">
              <SettingsRow label="Keyboard shortcut" hint="Start or stop dictation from any window."><span className="settings-value">Ctrl+E</span></SettingsRow>
            </SettingsGroup>
          </>}

          {!loading && page === 'Updates' && <>
            <UpdatesPanel sessions={snapshot?.sessions ?? []} permissions={snapshot?.permissions ?? []} />
            <SettingsGroup title="About">
              <div data-settings-about>
                <SettingsRow label="Code signing" hint="Windows may warn the first time you run a new installer."><span className="settings-value">Not configured</span></SettingsRow>
              </div>
            </SettingsGroup>
          </>}

        </div>
      </section>
      {profileDeleteTarget && <ConfirmDialog title={`Remove ${profileDeleteTarget.name}?`} body="This removes the custom launcher profile from Bloblex. It does not uninstall the coding agent." confirmLabel="Remove" cancelLabel="Keep launcher" holdToConfirm successTitle="Launcher removed" successBody="The custom launcher profile was removed from Bloblex." onConfirm={async () => { await deleteProfile(profileDeleteTarget.id) }} onComplete={() => setProfileDeleteTarget(null)} onCancel={() => setProfileDeleteTarget(null)} />}
    </div>
}

function SettingsGroup({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="settings-group">
    <div className="settings-group-head"><h3>{title}</h3>{action}</div>
    <div className="settings-card">{children}</div>
  </section>
}

function SettingsRow({ label, hint, children }: { label: string; hint?: string; children?: ReactNode }) {
  return <div className="settings-row">
    <span className="settings-row-copy"><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
    {children && <span className="settings-row-control">{children}</span>}
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
