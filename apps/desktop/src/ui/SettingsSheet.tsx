import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { emit } from '@tauri-apps/api/event'
import { Bot, Check, ChevronDown, ChevronRight, Download, Plus, RefreshCw, ShieldAlert, SlidersHorizontal, X } from 'lucide-react'
import type { Agent, Snapshot } from '../types'
import { labelize } from '../types'
import { effectiveApprovalMode, parseGlobalMode, type PermissionsPolicy } from '../approvalContract'
import { companionMonitorOptions, currentCompanionMonitor, inDesktop, permissionsPolicyGet, rpc, setCloseToTray, setCompanionMonitor, setCompanionVisibility } from '../tauri'
import { agentColorHex } from './agentColor'
import { useDialogAccessibility } from './dialogFocus'
import { Select } from './Select'
import { UpdatesPanel } from './UpdatesPanel'

export type SettingsPageId = 'General' | 'Agents' | 'Updates'

const PAGES: Array<{ id: SettingsPageId; label: string; icon: typeof SlidersHorizontal }> = [
  { id: 'General', label: 'General', icon: SlidersHorizontal },
  { id: 'Agents', label: 'Agents', icon: Bot },
  { id: 'Updates', label: 'Updates', icon: Download },
]

const PROVIDER_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' }

export function providerDisplayName(provider: string | undefined) {
  return PROVIDER_NAMES[(provider ?? '').toLowerCase()] ?? labelize(provider, 'Coding agent')
}

export function SettingsSheet({ snapshot, initialPage, onClose, onRefresh, onError, onOpenAgent, focusUpdates = false }: {
  snapshot: Snapshot | null
  initialPage: SettingsPageId
  onClose: () => void
  onRefresh: () => void
  onError: (error: string | null) => void
  onOpenAgent: (agentId: string) => void
  focusUpdates?: boolean
}) {
  const dialogRef = useDialogAccessibility(onClose)
  const [page, setPage] = useState<SettingsPageId>(focusUpdates ? 'Updates' : initialPage)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [profiles, setProfiles] = useState<Record<string, unknown>[]>([])
  const [policy, setPolicy] = useState<PermissionsPolicy | null>(null)
  const [policyError, setPolicyError] = useState<string | null>(null)
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
  const [launcherFormOpen, setLauncherFormOpen] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [defaultMode, setDefaultMode] = useState<'ask' | 'auto'>('ask')
  const [openRuntimes, setOpenRuntimes] = useState<Record<string, boolean>>({})

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
      if (typeof settings.showCompanion === 'boolean') setCompanionVisible(settings.showCompanion)
      if (typeof settings.closeToTray === 'boolean') setCloseToTrayValue(settings.closeToTray)
      if (typeof settings['companion.soundsEnabled'] === 'boolean') setSoundsEnabled(settings['companion.soundsEnabled'])
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

  const setCompanion = (visible: boolean) => guarded(async () => { await setCompanionVisibility(visible); setCompanionVisible(visible) })
  const updateCloseToTray = (enabled: boolean) => guarded(async () => { await setCloseToTray(enabled); setCloseToTrayValue(enabled) })
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

  const deleteProfile = (profileId: string) => guarded(async () => {
    await rpc('runtime.profile.delete', { profileId })
    setNotice('Launcher removed.')
    await load()
  })

  const runtimes = snapshot?.runtimes ?? []
  const agents = (snapshot?.agents ?? []).filter((agent) => !agent.archived)
  const orphanAgents = agents.filter((agent) => !runtimes.some((runtime) => runtime.id === agent.runtimeId))
  const modeFor = (agent: Agent) => policy?.perAgent.find((row) => row.agentId === agent.id)?.effectiveMode ?? effectiveApprovalMode(agent) ?? defaultMode
  const switchPage = (next: SettingsPageId) => { setPage(next); setFormError(null); setNotice(null) }

  return <div className="sheet-backdrop settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialogRef} className="settings-sheet" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1}>
      <header className="settings-page-head">
        <h2 id="settings-title">{page}</h2>
        <button type="button" className="icon-button" data-dialog-initial-focus aria-label="Close settings" onClick={onClose}><X size={17} aria-hidden="true" /></button>
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
              <SettingsRow label="Start with Windows" hint="Not available yet.">
                <button type="button" className="toggle" role="switch" aria-label="Start with Windows" aria-checked={false} disabled><i /></button>
              </SettingsRow>
              <SettingsRow label="Close to tray" hint="Closing the window keeps Bloblex running in the tray.">
                <button type="button" className={`toggle ${closeToTray ? 'on' : ''}`} role="switch" aria-label="Close to tray" aria-checked={closeToTray} onClick={() => void updateCloseToTray(!closeToTray)} disabled={saving}><i /></button>
              </SettingsRow>
              <SettingsRow label="Companion display" hint="The companion starts at the bottom center of this display.">
                <Select ariaLabel="Companion monitor" variant="muted" value={companionMonitor ?? ''} disabled={saving || monitors.length === 0} placeholder="No displays reported" onChange={(value) => void updateCompanionMonitor(value)} options={monitors.map((monitor) => ({ value: monitor, label: monitorLabel(monitor) }))} />
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup title="Companion">
              <SettingsRow label="Show companion">
                <button type="button" className={`toggle ${companionVisible ? 'on' : ''}`} role="switch" aria-label="Show companion" aria-checked={companionVisible} onClick={() => void setCompanion(!companionVisible)} disabled={saving}><i /></button>
              </SettingsRow>
              <SettingsRow label="Sounds" hint="Short cues when a blob finishes, fails or needs approval.">
                <button type="button" className={`toggle ${soundsEnabled ? 'on' : ''}`} role="switch" aria-label="Companion sounds" aria-checked={soundsEnabled} onClick={() => void setSounds(!soundsEnabled)} disabled={saving}><i /></button>
              </SettingsRow>
            </SettingsGroup>
            <SettingsGroup title="Editor">
              <form className="settings-form" onSubmit={(event) => void saveEditor(event)}>
                <label className="settings-field"><span>Editor executable</span><input className="text-input" aria-label="Editor executable" value={editorExecutable} onChange={(event) => setEditorExecutable(event.target.value)} placeholder="Notepad is used when this is empty" /></label>
                <label className="settings-field"><span>Arguments <small>JSON array, {'{file}'} and {'{project}'} are replaced</small></span><input className="text-input mono" aria-label="Editor arguments" value={editorArgs} onChange={(event) => setEditorArgs(event.target.value)} spellCheck={false} /></label>
                <div className="settings-form-actions"><button className="primary-button small" disabled={saving}>Save editor</button></div>
              </form>
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
                    <span className="runtime-mark" aria-hidden="true">{providerDisplayName(runtime.provider).slice(0, 1)}</span>
                    <span className="settings-row-copy"><strong>{providerDisplayName(runtime.provider)}</strong><small>{[runtime.version, signInLabel(runtime.authState)].filter(Boolean).join(' · ') || 'Details unavailable'}</small></span>
                    <span className="settings-value">{owned.length === 1 ? '1 blob' : `${owned.length} blobs`}</span>
                    {open ? <ChevronDown size={15} className="row-chevron" aria-hidden="true" /> : <ChevronRight size={15} className="row-chevron" aria-hidden="true" />}
                  </button>
                  {open && <div className="runtime-entry-body">
                    <dl className="settings-facts">
                      <div><dt>Status</dt><dd>{labelize(runtime.status, 'Unknown')}</dd></div>
                      <div><dt>Sign-in</dt><dd>{labelize(runtime.authState, 'Unknown')}</dd></div>
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
                {typeof profile.id === 'string' && <button type="button" className="ghost-button small" onClick={() => void deleteProfile(profile.id as string)}>Remove</button>}
              </div>)}
              {!launcherFormOpen && <div className="settings-row">
                <span className="settings-row-copy"><strong>{profiles.length === 0 ? 'No custom launchers' : 'Add another launcher'}</strong><small>Run an agent from a specific executable with fixed arguments.</small></span>
                <button type="button" className="secondary-button small" onClick={() => setLauncherFormOpen(true)}><Plus size={13} />Add launcher</button>
              </div>}
              {launcherFormOpen && <form className="settings-form" onSubmit={(event) => void saveProfile(event)}>
                <label className="settings-field"><span>Name</span><input className="text-input" aria-label="Profile name" value={profileName} onChange={(event) => setProfileName(event.target.value)} required /></label>
                <div className="settings-field-pair">
                  <div className="settings-field"><span>Agent</span><Select ariaLabel="Profile provider" variant="field" align="left" value={profileProvider} onChange={(value) => { setProfileProvider(value); setProfileProtocol(value === 'claude' ? 'claude_stream' : value === 'opencode' ? 'acp' : 'codex_app_server') }} options={[{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }, { value: 'opencode', label: 'OpenCode' }]} /></div>
                  <div className="settings-field"><span>Protocol</span><Select ariaLabel="Profile protocol" variant="field" align="left" value={profileProtocol} onChange={setProfileProtocol} options={[{ value: 'claude_stream', label: 'Claude stream' }, { value: 'codex_app_server', label: 'Codex app-server' }, { value: 'acp', label: 'ACP' }]} /></div>
                </div>
                <label className="settings-field"><span>Executable path</span><input className="text-input mono" aria-label="Profile executable" value={profilePath} onChange={(event) => setProfilePath(event.target.value)} required /></label>
                <label className="settings-field"><span>Fixed arguments <small>JSON array</small></span><input className="text-input mono" aria-label="Profile arguments" value={profileArgs} onChange={(event) => setProfileArgs(event.target.value)} spellCheck={false} /></label>
                <div className="settings-form-actions"><button type="button" className="ghost-button small" onClick={() => setLauncherFormOpen(false)}>Cancel</button><button className="primary-button small" disabled={saving}>Save launcher</button></div>
              </form>}
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

function signInLabel(state?: string) {
  const value = (state ?? '').toLowerCase()
  if (!value) return ''
  if (['signed_in', 'authenticated', 'logged_in'].includes(value)) return 'Signed in'
  if (['signed_out', 'unauthenticated', 'logged_out'].includes(value)) return 'Signed out'
  return labelize(state)
}

function monitorLabel(monitor: string) {
  const match = /DISPLAY(\d+)$/i.exec(monitor)
  return match ? `Display ${match[1]}` : monitor
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

