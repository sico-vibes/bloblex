import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { UsageAnalyticsRequest } from './analyticsTypes'
import { parsePermissionsPolicy, type PermissionsPolicy } from './approvalContract'
import { parseCapabilities, parseExecSnapshot, parseModelCatalog } from './executionContract'
import type { DaemonEvent, JsonRecord, Snapshot, WindowBackdrop } from './types'
import { normalizeAnalytics } from './ui/analyticsFormat'
import { settingsPageFromEvent, type SettingsPageName } from './ui/settingsIndex'
import {
  knownUpdateError, parseUpdateCheck, parseUpdateInfo, parseUpdatePhaseState, parseUpdatePreferences, parseUpdateProgress, parseUpdatesState, safeUpdateFailureMessage, updateFailureCode,
  type UpdateCheckResult, type UpdateInfo, type UpdatePhaseState, type UpdatePreferences, type UpdateProgress, type UpdatesState,
} from './updatesContract'

export { parseAutoResolved, parseBypassActive, parsePermissionsPolicy } from './approvalContract'
export type { AutoResolvedAction, BypassNotice, PermissionsPolicy } from './approvalContract'

export const inDesktop = isTauri()
/** True only in the browser preview build, which replaces this module with fixtures. */
export const previewMode = false

export async function rpc<T>(method: string, params: JsonRecord = {}): Promise<T> {
  if (!inDesktop) throw new Error('The local Bitbots daemon is available only in the desktop app.')
  return invoke<T>('daemon_rpc', { method, params })
}

/** Saves image bytes where the daemon can read them and returns the path. */
export async function stagePromptAttachment(bytes: Uint8Array): Promise<string> {
  if (!inDesktop) throw new Error('Attachments are available only in the desktop app.')
  return invoke<string>('stage_prompt_attachment', bytes)
}

/** Reads PNG bytes from the native clipboard after a user paste gesture. */
export async function readClipboardImage(): Promise<Uint8Array> {
  if (!inDesktop) throw new Error('Clipboard images are available only in the desktop app.')
  return new Uint8Array(await invoke<ArrayBuffer>('clipboard_image'))
}
export async function selectWallpaperImage(): Promise<string | null> {
  if (!inDesktop) return null
  return invoke<string | null>('select_wallpaper_image')
}
export async function importWallpaper(token: string): Promise<void> {
  if (!inDesktop) return
  await invoke('import_wallpaper', { selectionToken: token })
}
export async function readWallpaper(): Promise<Uint8Array> {
  if (!inDesktop) return new Uint8Array()
  const bytes = await invoke<ArrayBuffer>('read_wallpaper')
  return new Uint8Array(bytes)
}
export async function clearWallpaper(): Promise<void> { if (inDesktop) await invoke('clear_wallpaper') }

export async function openProjectFolder(): Promise<string | null> {
  if (!inDesktop) return null
  return invoke<string | null>('select_project_folder')
}

export async function selectLocalFile(): Promise<string | null> {
  if (!inDesktop) return null
  return invoke<string | null>('select_local_file')
}

export async function selectMarkdownExportPath(): Promise<string | null> {
  if (!inDesktop) return null
  return invoke<string | null>('select_markdown_export_path')
}

export async function writeMarkdownExport(selectionToken: string, text: string): Promise<void> {
  if (!inDesktop) throw new Error('Markdown export is available only in the desktop app.')
  await invoke('write_selected_export_text', { selectionToken, text })
}

export async function selectBlobExportPath(name: string): Promise<string | null> {
  if (!inDesktop) return null
  return invoke<string | null>('select_blob_export_path', { name })
}

export async function selectBlobImportPath(): Promise<string | null> {
  if (!inDesktop) return null
  return invoke<string | null>('select_blob_import_path')
}

export async function readBlobImport(selectionToken: string): Promise<string> {
  if (!inDesktop) throw new Error('Blob import is available only in the desktop app.')
  return invoke<string>('read_blob_import', { selectionToken })
}

export async function writeBlobExport(selectionToken: string, text: string): Promise<void> {
  await writeMarkdownExport(selectionToken, text)
}

/** The parts of an export a caller may switch off; bots are always included. */
export type BackupInclude = {
  memory?: boolean
  skills?: boolean
  automations?: boolean
  settings?: boolean
}

export type BackupStats = { bots: number; memory: number; skills: number; automations: number; settings: number }

/** Save dialog for a `.bitbots-backup.json`; returns an opaque selection token. */
export async function selectBackupExportPath(): Promise<string | null> {
  if (!inDesktop) return null
  return invoke<string | null>('select_backup_export_path')
}

/** Open dialog for a `.bitbots-backup.json`; returns an opaque selection token. */
export async function selectBackupImportPath(): Promise<string | null> {
  if (!inDesktop) return null
  return invoke<string | null>('select_backup_import_path')
}

/** Asks the daemon for a document and writes it to the chosen path. */
export async function writeBackupExport(token: string, include?: BackupInclude): Promise<{ path: string; stats: BackupStats }> {
  if (!inDesktop) throw new Error('Backups are available only in the desktop app.')
  return invoke<{ path: string; stats: BackupStats }>('backup_export_write', { selectionToken: token, include: include ?? null })
}

/**
 * Reads and validates a chosen backup file through the daemon. The file text
 * never reaches the renderer; the returned preview carries only counts,
 * conflicts and warnings. Import is completed by calling `rpc('backup.import',
 * { previewId, resolutions })` directly.
 */
export async function previewBackupImport(token: string) {
  if (!inDesktop) throw new Error('Backups are available only in the desktop app.')
  return invoke<{
    previewId: string
    counts: BackupStats
    conflicts: {
      bots: { exportId: string; name: string; existingAgentId: string }[]
      skills: { name: string; same: boolean }[]
      memory: { id: string; identical: boolean }[]
      settings: { key: string; current: unknown; incoming: unknown }[]
    }
    warnings: string[]
  }>('backup_import_preview', { selectionToken: token })
}

/** Preview of the diagnostics export: what the zip would contain. */
export type DiagnosticsPreview = {
  generatedAt: string
  fileName: string
  files: { name: string; sizeBytes: number }[]
}

/** Save dialog for the diagnostics `.zip`; returns an opaque selection token. */
export async function selectDiagnosticsExportPath(): Promise<string | null> {
  if (!inDesktop) return null
  return invoke<string | null>('select_diagnostics_export_path')
}

/** Asks the daemon for the diagnostics zip and writes it to the chosen path. */
export async function writeDiagnosticsExport(token: string): Promise<{ path: string; sizeBytes: number; files: { name: string; sizeBytes: number }[] }> {
  if (!inDesktop) throw new Error('Diagnostics are available only in the desktop app.')
  return invoke<{ path: string; sizeBytes: number; files: { name: string; sizeBytes: number }[] }>('diagnostics_export_write', { selectionToken: token })
}

export async function inspectLocalFile(path: string): Promise<{ path: string; fileName: string; sizeBytes: number }> {
  if (!inDesktop) throw new Error('Local file validation is available only in the desktop app.')
  return invoke<{ path: string; fileName: string; sizeBytes: number }>('inspect_local_file', { path })
}

export async function openInEditor(path: string, projectRoot?: string | null): Promise<void> {
  if (!inDesktop) throw new Error('Open-in-editor is available only in the desktop app.')
  await invoke('open_in_editor', { path, projectRoot: projectRoot ?? null })
}

export async function revealInExplorer(path: string, projectRoot?: string | null): Promise<void> {
  if (!inDesktop) throw new Error('File Explorer is available only in the desktop app.')
  await invoke('reveal_in_explorer', { path, projectRoot: projectRoot ?? null })
}

export async function resolveProjectFile(path: string, projectRoot?: string | null): Promise<string> {
  if (!inDesktop) throw new Error('Path resolution is available only in the desktop app.')
  return invoke<string>('resolve_project_file', { path, projectRoot: projectRoot ?? null })
}

/** The providers and actions `runtimeTerminal` accepts; never a command string. */
export type RuntimeTerminalProvider = 'claude' | 'codex' | 'opencode'
export type RuntimeTerminalAction = 'login' | 'install'
export type RuntimeTerminalResult = { launched: boolean; terminal: 'wt' | 'powershell' }

/**
 * Opens a visible terminal window running the provider's fixed login or install
 * command, so an expired CLI sign-in can be fixed without leaving the app. The
 * command text lives in the native table; only these two values cross.
 */
export async function runtimeTerminal(provider: RuntimeTerminalProvider, action: RuntimeTerminalAction): Promise<RuntimeTerminalResult> {
  if (!inDesktop) throw new Error('Sign-in terminals are available only in the desktop app.')
  return invoke<RuntimeTerminalResult>('runtime_terminal', { provider, action })
}

export type HarnessUpdateResult = { provider: string; version: string }

export async function harnessLatestVersion(provider: string): Promise<string> {
  if (!inDesktop) throw new Error('Harness updates are available only in the desktop app.')
  return invoke<string>('harness_latest_version', { provider })
}

export async function harnessUpdate(provider: string, currentVersion: string): Promise<HarnessUpdateResult> {
  if (!inDesktop) throw new Error('Harness updates are available only in the desktop app.')
  return invoke<HarnessUpdateResult>('harness_update', { provider, currentVersion })
}

export async function showMainWindow(sessionId?: string | null): Promise<void> {
  if (!inDesktop) return
  await invoke('show_main_window', { sessionId: sessionId ?? await getActiveSession() })
}

export async function showMainSettings(sessionId?: string | null, page?: SettingsPageName): Promise<void> {
  if (!inDesktop) return
  await invoke('show_main_settings', { sessionId: sessionId ?? await getActiveSession(), page: page ?? null })
}

export async function setActiveSession(sessionId: string | null): Promise<void> {
  if (inDesktop) await invoke('set_active_session', { sessionId })
}

export async function getActiveSession(): Promise<string | null> {
  if (!inDesktop) return null
  return invoke<string | null>('get_active_session')
}

export async function setActiveRuntime(runtimeId: string | null): Promise<void> {
  if (inDesktop) await invoke('set_active_runtime', { runtimeId })
}

export async function getActiveRuntime(): Promise<string | null> {
  if (!inDesktop) return null
  return invoke<string | null>('get_active_runtime')
}

export async function setCompanionVisibility(visible: boolean): Promise<void> {
  if (inDesktop) await invoke('set_companion_visible', { visible })
}

export async function setCloseToTray(enabled: boolean): Promise<void> {
  if (inDesktop) await invoke('set_close_to_tray', { enabled })
}

export async function companionMonitorOptions(): Promise<string[]> {
  if (!inDesktop) return []
  return invoke<string[]>('companion_monitor_options')
}

export async function currentCompanionMonitor(): Promise<string | null> {
  if (!inDesktop) return null
  return invoke<string | null>('current_companion_monitor')
}

export async function setCompanionMonitor(monitorName: string): Promise<void> {
  if (inDesktop) await invoke('set_companion_monitor', { monitorName })
}

export async function refreshTrayMenu(): Promise<void> {
  if (inDesktop) await invoke('refresh_tray_menu')
}

export async function setCompanionMode(mode: 'hidden' | 'petit' | 'home' | 'home-chat' | 'welcome', animate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches): Promise<void> {
  if (inDesktop) await invoke('set_companion_mode', { mode, animate })
}

/** The companion window is frameless, so the page draws its own resize handles and the shell resizes it from the real cursor position. */
export type CompanionEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
export async function companionResizeBegin(edge: CompanionEdge): Promise<void> {
  if (inDesktop) await invoke('companion_resize_begin', { edge })
}
export async function companionResizeStep(): Promise<void> {
  if (inDesktop) await invoke('companion_resize_step')
}
/** Ends a drag; the shell remembers the size. Returns it in logical pixels, or null outside the desktop app. */
export async function companionResizeEnd(): Promise<[number, number] | null> {
  return inDesktop ? invoke<[number, number]>('companion_resize_end') : null
}
/** `large` grows the expanded companion, `normal` returns to the remembered size, `default` forgets it. Resolves to whether it is now large. */
export async function setCompanionSizePreset(preset: 'large' | 'normal' | 'default'): Promise<boolean> {
  return inDesktop ? invoke<boolean>('set_companion_size_preset', { preset }) : preset === 'large'
}

export async function quitBloblex(): Promise<void> {
  if (inDesktop) await invoke('quit_bloblex')
}

export async function startDaemonEventStream(): Promise<void> {
  if (inDesktop) await invoke('daemon_events_start')
}

export async function ensureDaemon(): Promise<void> {
  if (inDesktop) await invoke('ensure_daemon')
}

export async function listenForActiveSession(handler: (sessionId: string | null) => void): Promise<UnlistenFn> {
  if (!inDesktop) return () => undefined
  return listen<string | null>('active-session', (event) => handler(event.payload))
}

export async function listenForActiveRuntime(handler: (runtimeId: string | null) => void): Promise<UnlistenFn> {
  if (!inDesktop) return () => undefined
  return listen<string | null>('active-runtime', (event) => handler(event.payload))
}

export async function listenForOpenSettings(handler: (page: SettingsPageName | null) => void): Promise<UnlistenFn> {
  if (!inDesktop) return () => undefined
  return listen('bloblex-open-settings', (event) => handler(settingsPageFromEvent(event.payload)))
}

export async function listenForDaemonEvents(handler: (event: DaemonEvent) => void): Promise<UnlistenFn> {
  if (!inDesktop) return () => undefined
  return listen<DaemonEvent>('daemon-event', (event) => handler(event.payload))
}

export async function listenForDaemonConnection(handler: (connected: boolean) => void): Promise<UnlistenFn> {
  if (!inDesktop) return () => undefined
  return listen<boolean>('daemon-connection', (event) => handler(event.payload))
}

export async function fetchSnapshot() {
  return rpc<Snapshot>('app.snapshot')
}

export async function permissionsPolicyGet(): Promise<PermissionsPolicy> {
  return parsePermissionsPolicy(await rpc('permissions.policy.get'))
}

export async function runtimeCapabilities(runtimeId: string, agentId?: string) {
  return parseCapabilities(await rpc('runtime.capabilities', agentId ? { runtimeId, agentId } : { runtimeId }))
}

export async function runtimeModels(runtimeId: string, refresh = false) {
  return parseModelCatalog(await rpc('runtime.models', refresh ? { runtimeId, refresh: true } : { runtimeId }))
}

export async function execSnapshotLatest(sessionId: string) {
  return parseExecSnapshot(await rpc('exec.snapshot.latest', { sessionId }))
}

export async function updatesGetState(): Promise<UpdatesState | null> {
  if (!inDesktop) return null
  try { return parseUpdatesState(await invoke('updates_get_state')) } catch { return null }
}

export async function updatesSetPreferences(preferences: UpdatePreferences): Promise<UpdatesState> {
  if (!inDesktop) throw new Error(safeUpdateFailureMessage('unavailable'))
  const args = parseUpdatePreferences(preferences)
  const preferencesArgs: Record<string, unknown> = {}
  if (args.channel) preferencesArgs.channel = args.channel
  if (typeof args.autoCheck === 'boolean') preferencesArgs.autoCheck = args.autoCheck
  try {
    const parsed = parseUpdatesState(await invoke('updates_set_preferences', preferencesArgs))
    if (!parsed) throw new Error(safeUpdateFailureMessage(null))
    return parsed
  } catch (reason) {
    throw new Error(safeUpdateFailureMessage(reason))
  }
}

export async function updatesCheck(): Promise<UpdateCheckResult> {
  if (!inDesktop) return { status: 'error', checkedAt: '', error: 'unavailable' }
  try {
    return parseUpdateCheck(await invoke('updates_check')) ?? { status: 'error', checkedAt: '' }
  } catch (reason) {
    const code = knownUpdateError(updateFailureCode(reason))
    return { status: 'error', checkedAt: '', ...(code ? { error: code } : {}) }
  }
}

export async function updatesInstall(): Promise<void> {
  if (!inDesktop) throw new Error(safeUpdateFailureMessage('unavailable'))
  try { await invoke('updates_install') } catch (reason) { throw new Error(safeUpdateFailureMessage(reason)) }
}

export async function listenForUpdateAvailable(handler: (info: UpdateInfo) => void): Promise<UnlistenFn> {
  if (!inDesktop) return () => undefined
  return listen('bloblex-update-available', (event) => {
    const info = parseUpdateInfo(event.payload)
    if (info) handler(info)
  })
}

export async function listenForUpdateState(handler: (state: UpdatePhaseState) => void): Promise<UnlistenFn> {
  if (!inDesktop) return () => undefined
  return listen('updates-state', (event) => {
    const state = parseUpdatePhaseState(event.payload)
    if (state) handler(state)
  })
}

export async function updatesPhase(): Promise<UpdatePhaseState | null> {
  if (!inDesktop) return null
  try { return parseUpdatePhaseState(await invoke('updates_phase')) } catch { return null }
}

export async function listenForUpdateProgress(handler: (progress: UpdateProgress) => void): Promise<UnlistenFn> {
  if (!inDesktop) return () => undefined
  return listen('bloblex-update-progress', (event) => {
    const progress = parseUpdateProgress(event.payload)
    if (progress) handler(progress)
  })
}

export async function fetchUsageAnalytics(request: UsageAnalyticsRequest) {
  const params: JsonRecord = { from: request.from, to: request.to, bucket: request.bucket, tz: request.tz }
  if (request.projectPath) params.projectPath = request.projectPath
  if (request.agentId) params.agentId = request.agentId
  const parsed = normalizeAnalytics(await rpc('usage.analytics', params))
  if (!parsed) throw new Error('internal: Usage analytics could not be loaded.')
  return parsed
}

export type SpeechModelSummary = {
  id: string
  label: string
  description: string
  language: string
  streaming: boolean
  recommended: boolean
  sizeBytes: number
}

export type DictationEventPayload = { type: string; owner?: string; text?: string }

export async function speechModels(): Promise<SpeechModelSummary[]> {
  if (!inDesktop) return []
  return invoke<SpeechModelSummary[]>('speech_models')
}

export async function dictationModelStatus(modelId: string): Promise<{ modelId: string; ready: boolean; sizeBytes: number }> {
  if (!inDesktop) return { modelId, ready: false, sizeBytes: 0 }
  return invoke<{ modelId: string; ready: boolean; sizeBytes: number }>('speech_model_status', { modelId })
}

/** Warm the cloud dictation path (client, sign-in, DNS) without sending a request. */
export async function dictationCloudWarm(): Promise<{ clientReady: boolean; signedIn: boolean; dnsOk: boolean }> {
  if (!inDesktop) return { clientReady: false, signedIn: false, dnsOk: false }
  return invoke<{ clientReady: boolean; signedIn: boolean; dnsOk: boolean }>('dictation_cloud_warm')
}

export async function downloadSpeechModel(modelId: string): Promise<{ modelId: string; directory: string }> {
  if (!inDesktop) throw new Error('Speech models are available only in the desktop app.')
  return invoke<{ modelId: string; directory: string }>('speech_model_download', { modelId })
}

export async function startDictation(modelId: string, owner = 'desktop'): Promise<void> {
  if (!inDesktop) throw new Error('Dictation is available only in the desktop app.')
  await invoke('dictation_start', { modelId, owner })
}

export async function stopDictation(owner = 'desktop'): Promise<void> {
  if (!inDesktop) return
  await invoke('dictation_stop', { owner })
}

export async function cancelDictation(owner = 'desktop'): Promise<void> {
  if (!inDesktop) return
  await invoke('dictation_cancel', { owner })
}

export async function listenForDictation(handler: (event: DictationEventPayload) => void): Promise<UnlistenFn> {
  if (!inDesktop) return () => undefined
  return listen<DictationEventPayload>('bloblex-dictation', (event) => handler(event.payload))
}

export async function listenForDictationToggle(handler: () => void): Promise<UnlistenFn> {
  if (!inDesktop) return () => undefined
  return listen('bloblex-dictation-toggle', () => handler())
}

export async function listenForSpeechDownload(handler: (progress: { modelId: string; completed: number; total: number }) => void): Promise<UnlistenFn> {
  if (!inDesktop) return () => undefined
  return listen<{ modelId: string; completed: number; total: number }>('bloblex-speech-download', (event) => handler(event.payload))
}

/** Main-window owned waiting badge; non-Windows platforms keep the tray tooltip. */
export async function setApprovalBadge(count: number): Promise<void> {
  if (inDesktop) await invoke('set_approval_badge', { count: Math.max(0, Math.floor(count)) })
}

/** A real shell in a pseudo-terminal, owned by the desktop shell (never the daemon, never remote). */
export type TerminalShell = 'powershell' | 'pwsh' | 'cmd'
export type TerminalOpened = { id: string; pid: number | null; shell: string; cwd: string }
export type TerminalInfo = TerminalOpened & { running: boolean; exitCode: number | null }
export type TerminalOutput = { id: string; seq: number; data: string }
export type TerminalExit = { id: string; exitCode: number | null }

export async function terminalOpen(projectPath: string, options: { cwd?: string | null; shell?: TerminalShell; cols?: number; rows?: number } = {}): Promise<TerminalOpened> {
  if (!inDesktop) throw new Error('Terminals are available only in the desktop app.')
  return invoke<TerminalOpened>('terminal_open', { projectPath, cwd: options.cwd ?? null, shell: options.shell ?? null, cols: options.cols ?? null, rows: options.rows ?? null })
}
export async function terminalWrite(id: string, data: string): Promise<void> {
  if (!inDesktop) return
  await invoke('terminal_write', { id, data })
}
export async function terminalResize(id: string, cols: number, rows: number): Promise<void> {
  if (!inDesktop) return
  await invoke('terminal_resize', { id, cols, rows })
}
export async function terminalClose(id: string): Promise<void> {
  if (!inDesktop) return
  await invoke('terminal_close', { id })
}
export async function terminalList(): Promise<TerminalInfo[]> {
  if (!inDesktop) return []
  return invoke<TerminalInfo[]>('terminal_list')
}
export async function listenForTerminalOutput(handler: (output: TerminalOutput) => void): Promise<UnlistenFn> {
  if (!inDesktop) return () => undefined
  return listen<TerminalOutput>('terminal://output', (event) => handler(event.payload))
}
export async function listenForTerminalExit(handler: (exit: TerminalExit) => void): Promise<UnlistenFn> {
  if (!inDesktop) return () => undefined
  return listen<TerminalExit>('terminal://exit', (event) => handler(event.payload))
}

/** What the UI may show when the native backdrop is not what was asked for. */
const NO_DESKTOP_BACKDROP: WindowBackdrop = { effect: 'none', active: false, transparencyOff: false, reason: 'Not running in the desktop app.' }

/**
 * Applies or clears the native frosted-glass backdrop of the main window.
 *
 * The blur is the OS compositor's, not CSS, so it is a native request; it
 * resolves to an honest report even when Windows will not draw it, and never
 * throws into the UI.
 */
export async function applyWindowBackdrop(enabled: boolean, dark: boolean): Promise<WindowBackdrop> {
  if (!inDesktop) return NO_DESKTOP_BACKDROP
  try {
    return await invoke<WindowBackdrop>('window_backdrop_apply', { enabled, dark })
  } catch {
    return NO_DESKTOP_BACKDROP
  }
}

/** The backdrop in force now, with the Windows transparency setting read again. */
export async function windowBackdropState(): Promise<WindowBackdrop> {
  if (!inDesktop) return NO_DESKTOP_BACKDROP
  try {
    return await invoke<WindowBackdrop>('window_backdrop_state')
  } catch {
    return NO_DESKTOP_BACKDROP
  }
}
