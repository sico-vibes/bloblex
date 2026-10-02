import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { emit } from '@tauri-apps/api/event'
import { Bot, Check, Cpu, Plus, RefreshCw, Shield, ShieldAlert, SlidersHorizontal, X } from 'lucide-react'
import type { Agent, Runtime, Snapshot } from '../types'
import { labelize, providerColor } from '../types'
import { parseGlobalMode, type PermissionsPolicy } from '../approvalContract'
import { companionMonitorOptions, currentCompanionMonitor, inDesktop, permissionsPolicyGet, rpc, setCloseToTray, setCompanionMonitor, setCompanionVisibility } from '../tauri'
import { appVersion } from '../appRelease'
import { useDialogAccessibility } from './dialogFocus'

export type SettingsPageId = 'General' | 'Agents' | 'Runtimes' | 'Permissions'

const PAGES: Array<{ id: SettingsPageId; label: string; icon: typeof SlidersHorizontal }> = [
  { id: 'General', label: 'General', icon: SlidersHorizontal },
  { id: 'Agents', label: 'Agents', icon: Bot },
  { id: 'Runtimes', label: 'Runtimes', icon: Cpu },
  { id: 'Permissions', label: 'Permissions', icon: Shield },
]

export function SettingsSheet({ snapshot, initialPage, onClose, onRefresh, onError, onOpenAgent }: {
  snapshot: Snapshot | null
  initialPage: SettingsPageId
  onClose: () => void
  onRefresh: () => void
  onError: (error: string | null) => void
  onOpenAgent: (agentId: string) => void
}) {
  const dialogRef = useDialogAccessibility(onClose)
  const [page, setPage] = useState<SettingsPageId>(initialPage)
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
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [defaultMode, setDefaultMode] = useState<'ask' | 'auto'>('ask')

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

  const setCompanion = async (visible: boolean) => {
    setSaving(true)
    setFormError(null)
    try { await setCompanionVisibility(visible); setCompanionVisible(visible) }
    catch (reason) { setFormError(messageOf(reason)) }
    finally { setSaving(false) }
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
      try { await emit('bloblex-sounds-changed', enabled) } catch { /* the companion hydrates the saved value on its next connection */ }
      setNotice(enabled ? 'Companion sounds enabled.' : 'Companion sounds muted.')
    } catch (reason) {
      const message = messageOf(reason)
      setSoundsEnabled(!enabled)
      setFormError(message)
      onError(message)
    } finally { setSaving(false) }
  }

  const saveDefaultMode = async (value: string) => {
    const mode = parseGlobalMode(value)
    if (value !== 'ask' && value !== 'auto') return
    setSaving(true)
    setFormError(null)
    try {
      await rpc('settings.set', { key: 'permissions.default_mode', value: mode })
      setDefaultMode(mode)
      setNotice(mode === 'auto' ? 'New blobs inherit Auto-approve.' : 'New blobs inherit Ask.')
      onError(null)
    } catch (reason) {
      const message = messageOf(reason)
      setFormError(message)
      onError(message)
    } finally { setSaving(false) }
  }

  const saveEditor = async (event: FormEvent) => {
    event.preventDefault()
    let args: unknown
    try { args = JSON.parse(editorArgs) } catch { setFormError('Editor arguments must be a JSON array of strings.'); return }
    if (!Array.isArray(args) || !args.every((argument) => typeof argument === 'string')) { setFormError('Editor arguments must be a JSON array of strings.'); return }
    setSaving(true)
    setFormError(null)
    try {
      await rpc('settings.set', { key: 'editorExecutable', value: editorExecutable.trim() })
      await rpc('settings.set', { key: 'editorArgs', value: args })
      setNotice('Editor preference saved.')
      onError(null)
    } catch (reason) { const message = messageOf(reason); setFormError(message); onError(message) }
    finally { setSaving(false) }
  }

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault()
    let args: unknown
    try { args = JSON.parse(profileArgs) } catch { setFormError('Fixed arguments must be a valid JSON array of strings.'); return }
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) { setFormError('Fixed arguments must be a valid JSON array of strings.'); return }
    setSaving(true)
    setFormError(null)
    try {
      await rpc('runtime.profile.save', { profile: { name: profileName, provider: profileProvider, protocolFamily: profileProtocol, executablePath: profilePath, args, workingDirectoryPolicy: 'per_session' } })
      setProfileName('')
      setProfilePath('')
      setProfileArgs('[]')
      setNotice('Profile saved.')
      onError(null)
      await load()
    } catch (reason) { const message = messageOf(reason); setFormError(message); onError(message) }
    finally { setSaving(false) }
  }

  const deleteProfile = async (profileId: string) => {
    setSaving(true)
    try { await rpc('runtime.profile.delete', { profileId }); setNotice('Runtime profile removed.'); await load() }
    catch (reason) { setFormError(messageOf(reason)) }
    finally { setSaving(false) }
  }

  const agents = (snapshot?.agents ?? []).filter((agent) => !agent.archived)
  const exceptions = (policy?.perAgent ?? []).filter((row) => row.effectiveMode !== 'ask')

  return <div className="sheet-backdrop settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section ref={dialogRef} className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1}>
    <header className="settings-header"><div><p className="eyebrow">BLOBLEX</p><h2 id="settings-title">Settings</h2></div><button className="icon-button" data-dialog-initial-focus aria-label="Close settings" onClick={onClose}><X size={17} aria-hidden="true" /></button></header>
    <div className="settings-layout"><nav className="settings-nav" aria-label="Settings pages">{PAGES.map((item) => <button className={page === item.id ? 'selected' : ''} key={item.id} aria-current={page === item.id ? 'page' : undefined} onClick={() => { setPage(item.id); setFormError(null); setNotice(null) }}><item.icon size={15} aria-hidden="true" />{item.label}</button>)}</nav>
      <div className="settings-content">
        {formError && <div className="inline-error settings-error" role="alert"><ShieldAlert size={15} /><span>{formError}</span></div>}
        {notice && <div className="settings-success" role="status"><Check size={14} />{notice}</div>}
        {loading && <div className="settings-loading"><span>Loading saved settings…</span></div>}
        {!loading && page === 'General' && <>
          <SettingsGroup title="System">
            <CardRow label="Start with Windows">
              <span className="setting-value">Unavailable</span>
              <button type="button" className="toggle" role="switch" aria-label="Start with Windows" aria-checked={false} disabled><i /></button>
            </CardRow>
            <CardRow label="Close to tray" hint="Closing the main window hides Bloblex and keeps the tray controls.">
              <button className={`toggle ${closeToTray ? 'on' : ''}`} role="switch" aria-label="Close to tray" aria-checked={closeToTray} onClick={() => void updateCloseToTray(!closeToTray)} disabled={saving}><i /></button>
            </CardRow>
            <CardRow label="Companion monitor" hint="Moves the companion to the bottom center of a connected display.">
              <select className="pill-select" aria-label="Companion monitor" value={companionMonitor ?? ''} onChange={(event) => void updateCompanionMonitor(event.target.value)} disabled={saving || monitors.length === 0}>{monitors.length === 0 ? <option value="">No displays reported</option> : monitors.map((monitor) => <option key={monitor} value={monitor}>{monitor}</option>)}</select>
            </CardRow>
          </SettingsGroup>
          <SettingsGroup title="Companion">
            <CardRow label="Show companion">
              <button className={`toggle ${companionVisible ? 'on' : ''}`} role="switch" aria-label="Show companion" aria-checked={companionVisible} onClick={() => void setCompanion(!companionVisible)} disabled={saving}><i /></button>
            </CardRow>
            <CardRow label="Sounds" hint="Optional original cues. Muted until you enable them.">
              <button className={`toggle ${soundsEnabled ? 'on' : ''}`} role="switch" aria-label="Companion sounds" aria-checked={soundsEnabled} onClick={() => void setSounds(!soundsEnabled)} disabled={saving}><i /></button>
            </CardRow>
          </SettingsGroup>
          <SettingsGroup title="About">
            <div className="settings-about" data-settings-about>
              <p>Version: {appVersion || 'Unknown'}</p>
              <p>Channel: local build</p>
              <p>Updates: not configured</p>
              <p>Signing: not configured</p>
            </div>
          </SettingsGroup>
          <SettingsGroup title="Editor">
            <form className="settings-card-form" onSubmit={(event) => void saveEditor(event)}>
              <label>Editor executable<input aria-label="Editor executable" value={editorExecutable} onChange={(event) => setEditorExecutable(event.target.value)} placeholder="C:\\Program Files\\Microsoft VS Code\\Code.exe" /></label>
              <label>Arguments (JSON array; {'{file}'} and {'{project}'} placeholders)<input aria-label="Editor arguments" value={editorArgs} onChange={(event) => setEditorArgs(event.target.value)} spellCheck={false} /></label>
              <button className="primary-button" disabled={saving}><Check size={14} />Save editor</button>
            </form>
          </SettingsGroup>
        </>}
        {!loading && page === 'Agents' && <SettingsGroup title="Blobs">
          {agents.length === 0 ? <p className="settings-data-empty">No blobs yet.</p> : <div className="settings-card">{agents.map((agent) => <button type="button" className="settings-card-row settings-link-row" key={agent.id} onClick={() => onOpenAgent(agent.id)}><span><strong>{agent.name}</strong><small>{agentLabel(agent, snapshot?.runtimes ?? [])}</small></span><span>Open</span></button>)}</div>}
        </SettingsGroup>}
        {!loading && page === 'Runtimes' && <>
          <SettingsGroup title="Detected CLIs">
            <RuntimeSettingsList runtimes={snapshot?.runtimes ?? []} />
            <button className="secondary-button settings-action" onClick={onRefresh} disabled={saving}><RefreshCw size={14} />Refresh detected runtimes</button>
          </SettingsGroup>
          <SettingsGroup title="Launcher profiles">
            {profiles.length === 0 ? <p className="settings-data-empty">No custom profiles saved.</p> : <div className="settings-card">{profiles.map((profile, index) => <div className="settings-card-row" key={String(profile.id ?? index)}><span><strong>{String(profile.name ?? profile.provider ?? 'Runtime profile')}</strong><small>{labelize(profile.protocolFamily)} · {String(profile.executablePath ?? 'Executable unavailable')}</small></span>{typeof profile.id === 'string' && <button type="button" className="settings-row-action danger" onClick={() => void deleteProfile(profile.id as string)}>Remove</button>}</div>)}</div>}
            <form className="settings-card-form" onSubmit={(event) => void saveProfile(event)}>
              <label>Profile name<input aria-label="Profile name" value={profileName} onChange={(event) => setProfileName(event.target.value)} required /></label>
              <label>Provider<select aria-label="Profile provider" value={profileProvider} onChange={(event) => { setProfileProvider(event.target.value); setProfileProtocol(event.target.value === 'claude' ? 'claude_stream' : event.target.value === 'opencode' ? 'acp' : 'codex_app_server') }}><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="opencode">OpenCode</option></select></label>
              <label>Protocol<select aria-label="Profile protocol" value={profileProtocol} onChange={(event) => setProfileProtocol(event.target.value)}><option value="claude_stream">Claude stream</option><option value="codex_app_server">Codex app-server</option><option value="acp">ACP</option></select></label>
              <label>Executable path<input aria-label="Profile executable" value={profilePath} onChange={(event) => setProfilePath(event.target.value)} required /></label>
              <label>Fixed arguments, JSON array<input aria-label="Profile arguments" value={profileArgs} onChange={(event) => setProfileArgs(event.target.value)} spellCheck={false} /></label>
              <button className="primary-button" disabled={saving}><Plus size={14} />Save profile</button>
            </form>
          </SettingsGroup>
        </>}
        {!loading && page === 'Permissions' && <SettingsGroup title="Default approval">
          {policyError ? <CardRow label="Default approval"><span className="setting-value">Unavailable</span><select className="pill-select" aria-label="Default approval mode" disabled value="ask"><option value="ask">Ask</option></select></CardRow> : <CardRow label="Default approval" hint="Ask waits for you. Auto-approve allows low-risk actions inside the project. Bypass is per blob only and cannot be the default.">
            <select className="pill-select" aria-label="Default approval mode" value={defaultMode} disabled={saving} onChange={(event) => void saveDefaultMode(event.target.value)}>
              <option value="ask">Ask</option>
              <option value="auto">Auto-approve</option>
            </select>
          </CardRow>}
          <p className="settings-intro">Bypass is per blob only. It is never the default for every blob.</p>
          <h3>Blobs not using Ask</h3>
          {exceptions.length === 0 ? <p className="settings-data-empty">Every reported blob is using Ask.</p> : <div className="settings-card">{exceptions.map((row) => {
            const agent = agents.find((item) => item.id === row.agentId)
            return <button type="button" className="settings-card-row settings-link-row" key={row.agentId} onClick={() => onOpenAgent(row.agentId)}><span><strong>{agent?.name ?? row.agentId}</strong><small>{row.effectiveMode === 'bypass' ? 'Bypass' : 'Auto-approve'}</small></span><span>Open blob</span></button>
          })}</div>}
        </SettingsGroup>}
      </div>
    </div>
  </section></div>
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section className="settings-group"><h3>{title}</h3><div className="settings-card">{children}</div></section>
}

function CardRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="settings-card-row"><span><strong>{label}</strong>{hint && <small>{hint}</small>}</span><span className="settings-card-control">{children}</span></div>
}

function RuntimeSettingsList({ runtimes }: { runtimes: Runtime[] }) {
  if (!runtimes.length) return <p className="settings-data-empty">No installed runtime was reported.</p>
  return <div className="settings-card">{runtimes.map((item) => <article className="settings-card-row" key={item.id}><span className="settings-entity-dot" style={{ background: providerColor(item.provider) }} /><span><strong>{labelize(item.provider)}</strong><small>{labelize(item.status, 'Status unknown')} · Auth {labelize(item.authState, 'unknown')} · {item.version ?? 'Version unknown'}</small><small className="settings-entity-path">{item.executablePath ?? 'Executable path unavailable'}</small></span></article>)}</div>
}

function agentLabel(agent: Agent, runtimes: Runtime[]) {
  const runtime = runtimes.find((item) => item.id === agent.runtimeId)
  return labelize(runtime?.provider, 'Runtime')
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
