import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { UsageAnalytics, UsageAnalyticsRequest } from './analyticsTypes'
import { parsePermissionsPolicy, type PermissionsPolicy } from './approvalContract'
import type { DaemonEvent, JsonRecord, Snapshot } from './types'

export { parseAutoResolved, parseBypassActive, parsePermissionsPolicy } from './approvalContract'
export type { AutoResolvedAction, BypassNotice, PermissionsPolicy } from './approvalContract'

export const inDesktop = isTauri()

export async function rpc<T>(method: string, params: JsonRecord = {}): Promise<T> {
  if (!inDesktop) throw new Error('The local Bloblex daemon is available only in the desktop app.')
  return invoke<T>('daemon_rpc', { method, params })
}

export async function openProjectFolder(): Promise<string | null> {
  if (!inDesktop) return null
  return invoke<string | null>('select_project_folder')
}

export async function selectLocalFile(): Promise<string | null> {
  if (!inDesktop) return null
  return invoke<string | null>('select_local_file')
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

export async function setCompanionMode(mode: 'hidden' | 'petit' | 'home' | 'home-chat' | 'welcome', animate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches): Promise<void> {
  if (inDesktop) await invoke('set_companion_mode', { mode, animate })
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
  return rpc('runtime.capabilities', agentId ? { runtimeId, agentId } : { runtimeId })
}

export async function runtimeModels(runtimeId: string, refresh = false) {
  return rpc('runtime.models', refresh ? { runtimeId, refresh: true } : { runtimeId })
}

export async function execSnapshotLatest(sessionId: string) {
  return rpc('exec.snapshot.latest', { sessionId })
}

export async function fetchUsageAnalytics(request: UsageAnalyticsRequest): Promise<UsageAnalytics> {
  const params: JsonRecord = { from: request.from, to: request.to, bucket: request.bucket, tz: request.tz }
  if (request.projectPath) params.projectPath = request.projectPath
  if (request.agentId) params.agentId = request.agentId
  return rpc<UsageAnalytics>('usage.analytics', params)
}
