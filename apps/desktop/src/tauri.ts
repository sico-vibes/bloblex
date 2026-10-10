import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { UsageAnalyticsRequest } from './analyticsTypes'
import { parsePermissionsPolicy, type PermissionsPolicy } from './approvalContract'
import { parseCapabilities, parseExecSnapshot, parseModelCatalog } from './executionContract'
import type { DaemonEvent, JsonRecord, Snapshot } from './types'
import { normalizeAnalytics } from './ui/analyticsFormat'
import {
  knownUpdateError, parseUpdateCheck, parseUpdateInfo, parseUpdatePreferences, parseUpdateProgress, parseUpdatesState, safeUpdateFailureMessage, updateFailureCode,
  type UpdateCheckResult, type UpdateInfo, type UpdatePreferences, type UpdateProgress, type UpdatesState,
} from './updatesContract'

export { parseAutoResolved, parseBypassActive, parsePermissionsPolicy } from './approvalContract'
export type { AutoResolvedAction, BypassNotice, PermissionsPolicy } from './approvalContract'

export const inDesktop = isTauri()
/** True only in the browser preview build, which replaces this module with fixtures. */
export const previewMode = false

export async function rpc<T>(method: string, params: JsonRecord = {}): Promise<T> {
  if (!inDesktop) throw new Error('The local Bloblex daemon is available only in the desktop app.')
  return invoke<T>('daemon_rpc', { method, params })
}

/** Saves image bytes where the daemon can read them and returns the path. */
export async function stagePromptAttachment(bytes: Uint8Array): Promise<string> {
  if (!inDesktop) throw new Error('Attachments are available only in the desktop app.')
  return invoke<string>('stage_prompt_attachment', bytes)
}

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

export async function showMainWindow(sessionId?: string | null): Promise<void> {
  if (!inDesktop) return
  await invoke('show_main_window', { sessionId: sessionId ?? await getActiveSession() })
}

export async function showMainSettings(sessionId?: string | null): Promise<void> {
  if (inDesktop) await invoke('show_main_settings', { sessionId: sessionId ?? await getActiveSession() })
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

export async function setCompanionMode(mode: 'hidden' | 'petit' | 'home' | 'home-chat' | 'welcome', animate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches, chatHeight?: number): Promise<void> {
  if (inDesktop) await invoke('set_companion_mode', { mode, animate, chatHeight: chatHeight ?? null })
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

export async function listenForOpenSettings(handler: () => void): Promise<UnlistenFn> {
  if (!inDesktop) return () => undefined
  return listen('bloblex-open-settings', () => handler())
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
