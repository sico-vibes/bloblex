// The remote (phone/browser) stand-in for `src/tauri.ts`, wired by the
// `../tauri` alias in `vite.remote.config.ts`. It exports every name the desktop
// module exports — `remoteTauri.parity.test.ts` fails when one goes missing — so
// a component written for the desktop still links on a device.
//
// Everything here is backed by `remoteTransport` (the host gateway) or is a
// deliberate "not on a phone" answer. No value in this module ever reaches one
// of the native Tauri npm packages, and none of them enters the remote bundle
// (the remote build fails if one does).
//
// Rule of thumb, applied consistently below and stated per call:
//   - read/chat calls → `rpc` through the gateway;
//   - native-only actions (dialogs, windows, tray, updates, dictation, backups)
//     → throw `Not available on a remote device.`;
//   - natives whose callers expect an empty value (an unlisten handle, a
//     cancelled dialog, a list) → a harmless empty value, documented inline.

import { parsePermissionsPolicy, type PermissionsPolicy } from '../approvalContract'
import type { UsageAnalyticsRequest } from '../analyticsTypes'
import { parseCapabilities, parseExecSnapshot, parseModelCatalog } from '../executionContract'
import type { DaemonEvent, JsonRecord, Snapshot } from '../types'
import { normalizeAnalytics } from '../ui/analyticsFormat'
import type { SettingsPageName } from '../ui/settingsIndex'
import type { UpdateCheckResult, UpdateInfo, UpdatePhaseState, UpdatePreferences, UpdateProgress, UpdatesState } from '../updatesContract'
import { createRemoteTransport, type RemoteConnectionStatus, type RemoteTransport } from './remoteTransport'
import type { RemoteDeviceApi } from './deviceApi'

/** The desktop module's unlisten type; duplicated so no `@tauri-apps` import is needed. */
export type UnlistenFn = () => void

/** Always false on a device: the native shell is not here. */
export const inDesktop = false
/** Always false on a device: this is the real remote build, not the fixture preview. */
export const previewMode = false

const NOT_AVAILABLE = 'Not available on a remote device.'
const notAvailable = () => new Error(NOT_AVAILABLE)

// ---------------------------------------------------------------------------
// The one transport, shared by every call below.

let client: RemoteTransport | null = null

async function resyncFromSnapshot(): Promise<void> {
  try {
    const snapshot = await rpc<Snapshot>('app.snapshot')
    if (typeof snapshot?.sequence === 'number') transport().setCursor(snapshot.sequence)
  } catch {
    // The socket reconnects and the next snapshot fetch retries.
  }
}

function transport(): RemoteTransport {
  if (!client) client = createRemoteTransport({ onResync: () => { void resyncFromSnapshot() } })
  return client
}

export async function rpc<T>(method: string, params: JsonRecord = {}): Promise<T> {
  return transport().rpc<T>(method, params)
}

export async function fetchSnapshot() {
  const snapshot = await rpc<Snapshot>('app.snapshot')
  // A fresh snapshot is the new floor for the event cursor (PROTOCOL §6).
  if (typeof snapshot?.sequence === 'number') transport().setCursor(snapshot.sequence)
  return snapshot
}

// ---------------------------------------------------------------------------
// Shared event fan-out: one socket, many listeners.

const eventHandlers = new Set<(event: DaemonEvent) => void>()
const connectionHandlers = new Set<(connected: boolean) => void>()
const statusHandlers = new Set<(status: RemoteConnectionStatus) => void>()
let unsubscribe: UnlistenFn | null = null
let lastStatus: RemoteConnectionStatus = 'connecting'

function publishConnection(status: RemoteConnectionStatus): void {
  if (status === lastStatus) return
  lastStatus = status
  for (const handler of [...statusHandlers]) handler(status)
  const connected = status === 'online'
  for (const handler of [...connectionHandlers]) handler(connected)
}

function ensureSubscription(): void {
  if (unsubscribe) return
  unsubscribe = transport().events(
    (event) => { for (const handler of [...eventHandlers]) handler(event) },
    (status) => publishConnection(status),
  )
}

function releaseSubscription(): void {
  if (eventHandlers.size > 0 || connectionHandlers.size > 0 || statusHandlers.size > 0) return
  unsubscribe?.()
  unsubscribe = null
}

export async function listenForDaemonEvents(handler: (event: DaemonEvent) => void): Promise<UnlistenFn> {
  eventHandlers.add(handler)
  ensureSubscription()
  return () => { eventHandlers.delete(handler); releaseSubscription() }
}

export async function listenForDaemonConnection(handler: (connected: boolean) => void): Promise<UnlistenFn> {
  connectionHandlers.add(handler)
  ensureSubscription()
  handler(lastStatus === 'online')
  return () => { connectionHandlers.delete(handler); releaseSubscription() }
}

/** The phone client's view of its host: identity, pairing, sign-out, connection (see deviceApi.ts). */
export const remoteDevice: RemoteDeviceApi = {
  me: () => transport().me(),
  pair: (input) => transport().pair(input),
  pairStatus: () => transport().pairStatus(),
  login: (input) => transport().login(input),
  logout: () => transport().logout(),
  onConnection(handler) {
    statusHandlers.add(handler)
    ensureSubscription()
    handler(lastStatus)
    return () => { statusHandlers.delete(handler); releaseSubscription() }
  },
}

// ---------------------------------------------------------------------------
// Gateway reads (PROTOCOL §4.4).

export async function permissionsPolicyGet(): Promise<PermissionsPolicy> {
  return parsePermissionsPolicy(await rpc('permissions.policy.get'))
}

export async function runtimeCapabilities(runtimeId: string, agentId?: string) {
  return parseCapabilities(await rpc('runtime.capabilities', agentId ? { runtimeId, agentId } : { runtimeId }))
}

export async function runtimeModels(runtimeId: string, refresh = false) {
  // The gateway refuses `refresh: true` remotely (`invalid_params`); send it and
  // let the host decide, so the caller sees the same error a desktop would not.
  return parseModelCatalog(await rpc('runtime.models', refresh ? { runtimeId, refresh: true } : { runtimeId }))
}

export async function execSnapshotLatest(sessionId: string) {
  return parseExecSnapshot(await rpc('exec.snapshot.latest', { sessionId }))
}

export async function fetchUsageAnalytics(request: UsageAnalyticsRequest) {
  const params: JsonRecord = { from: request.from, to: request.to, bucket: request.bucket, tz: request.tz }
  if (request.projectPath) params.projectPath = request.projectPath
  if (request.agentId) params.agentId = request.agentId
  const parsed = normalizeAnalytics(await rpc('usage.analytics', params))
  if (!parsed) throw new Error('internal: Usage analytics could not be loaded.')
  return parsed
}

// ---------------------------------------------------------------------------
// Re-exported exactly as the desktop module does.

export { parseAutoResolved, parseBypassActive, parsePermissionsPolicy } from '../approvalContract'
export type { AutoResolvedAction, BypassNotice, PermissionsPolicy } from '../approvalContract'

// ---------------------------------------------------------------------------
// Window/session selection. Harmless in memory: a phone has one window, and the
// values only label which conversation the shell is showing.

let activeSession: string | null = null
let activeRuntime: string | null = null

export async function setActiveSession(sessionId: string | null): Promise<void> { activeSession = sessionId }
export async function getActiveSession(): Promise<string | null> { return activeSession }
export async function setActiveRuntime(runtimeId: string | null): Promise<void> { activeRuntime = runtimeId }
export async function getActiveRuntime(): Promise<string | null> { return activeRuntime }

/** Harmless no-op: there is one window and no settings sheet to open. */
export async function showMainWindow(sessionId?: string | null): Promise<void> { void sessionId }
export async function showMainSettings(sessionId?: string | null, page?: SettingsPageName): Promise<void> { void sessionId; void page }
export async function setCompanionVisibility(visible: boolean): Promise<void> { void visible }
export async function setCloseToTray(enabled: boolean): Promise<void> { void enabled }
export async function refreshTrayMenu(): Promise<void> { /* no tray on a device */ }
export async function setCompanionMode(mode: 'hidden' | 'petit' | 'home' | 'home-chat' | 'welcome', animate = true, chatHeight?: number): Promise<void> { void mode; void animate; void chatHeight }
export async function quitBloblex(): Promise<void> { /* a device cannot quit the host */ }
export async function startDaemonEventStream(): Promise<void> { /* the socket opens with the first listener */ }
export async function ensureDaemon(): Promise<void> { /* the host runs the daemon */ }
export async function setApprovalBadge(count: number): Promise<void> { void count }

/** Empty values where a caller expects a list or a nullable display name. */
export async function companionMonitorOptions(): Promise<string[]> { return [] }
export async function currentCompanionMonitor(): Promise<string | null> { return null }
export async function setCompanionMonitor(monitorName: string): Promise<void> { void monitorName }

export async function listenForActiveSession(handler: (sessionId: string | null) => void): Promise<UnlistenFn> {
  void handler
  return () => undefined
}
export async function listenForActiveRuntime(handler: (runtimeId: string | null) => void): Promise<UnlistenFn> {
  void handler
  return () => undefined
}
export async function listenForOpenSettings(handler: (page: SettingsPageName | null) => void): Promise<UnlistenFn> {
  void handler
  return () => undefined
}

// ---------------------------------------------------------------------------
// File dialogs and local-file work. A dialog that cannot open returns `null`,
// which every caller already reads as "cancelled"; anything that would hand
// back host file contents throws.

export async function openProjectFolder(): Promise<string | null> { return null }
export async function selectLocalFile(): Promise<string | null> { return null }
/** Empty values: a remote device cannot open or store a host wallpaper file. */
export async function selectWallpaperImage(): Promise<string | null> { return null }
export async function importWallpaper(token: string): Promise<void> { void token }
export async function readWallpaper(): Promise<Uint8Array> { return new Uint8Array() }
export async function clearWallpaper(): Promise<void> { /* The host owns its wallpaper file. */ }
export async function selectMarkdownExportPath(): Promise<string | null> { return null }
export async function selectBlobExportPath(name: string): Promise<string | null> { void name; return null }
export async function selectBlobImportPath(): Promise<string | null> { return null }
export async function selectBackupExportPath(): Promise<string | null> { return null }
export async function selectBackupImportPath(): Promise<string | null> { return null }
export async function selectDiagnosticsExportPath(): Promise<string | null> { return null }

export async function stagePromptAttachment(bytes: Uint8Array): Promise<string> { void bytes; throw notAvailable() }
export async function writeDiagnosticsExport(selectionToken: string): Promise<{ path: string; sizeBytes: number; files: { name: string; sizeBytes: number }[] }> { void selectionToken; throw notAvailable() }
export async function writeMarkdownExport(selectionToken: string, text: string): Promise<void> { void selectionToken; void text; throw notAvailable() }
export async function readBlobImport(selectionToken: string): Promise<string> { void selectionToken; throw notAvailable() }
export async function writeBlobExport(selectionToken: string, text: string): Promise<void> { void selectionToken; void text; throw notAvailable() }

/** The parts of an export a caller may switch off; bots are always included. */
export type BackupInclude = {
  memory?: boolean
  skills?: boolean
  automations?: boolean
  settings?: boolean
}

export type BackupStats = { bots: number; memory: number; skills: number; automations: number; settings: number }

/** Preview of the diagnostics export: what the zip would contain. */
export type DiagnosticsPreview = {
  generatedAt: string
  fileName: string
  files: { name: string; sizeBytes: number }[]
}

export async function writeBackupExport(token: string, include?: BackupInclude): Promise<{ path: string; stats: BackupStats }> {
  void token
  void include
  throw notAvailable()
}

export async function previewBackupImport(token: string): Promise<never> { void token; throw notAvailable() }

export async function inspectLocalFile(path: string): Promise<{ path: string; fileName: string; sizeBytes: number }> { void path; throw notAvailable() }
export async function openInEditor(path: string, projectRoot?: string | null): Promise<void> { void path; void projectRoot; throw notAvailable() }
export async function revealInExplorer(path: string, projectRoot?: string | null): Promise<void> { void path; void projectRoot; throw notAvailable() }
export async function resolveProjectFile(path: string, projectRoot?: string | null): Promise<string> { void path; void projectRoot; throw notAvailable() }
export type RuntimeTerminalProvider = 'claude' | 'codex' | 'opencode'
export type RuntimeTerminalAction = 'login' | 'install'
export type RuntimeTerminalResult = { launched: boolean; terminal: 'wt' | 'powershell' }
/** Sign-in terminals run on the host, never on a device. */
export async function runtimeTerminal(provider: RuntimeTerminalProvider, action: RuntimeTerminalAction): Promise<never> { void provider; void action; throw notAvailable() }

// ---------------------------------------------------------------------------
// Updates belong to the host install, not to a device.
//   `updatesGetState` → null (callers treat it as "no state to show").
//   `updatesCheck`    → the same error result the desktop returns off-shell.

export async function updatesGetState(): Promise<UpdatesState | null> { return null }
export async function updatesSetPreferences(preferences: UpdatePreferences): Promise<never> { void preferences; throw notAvailable() }
export async function updatesCheck(): Promise<UpdateCheckResult> { return { status: 'error', checkedAt: '', error: 'unavailable' } }
export async function updatesInstall(): Promise<void> { throw notAvailable() }
// A phone never runs the desktop updater: no phase to report, no events to hear.
export async function updatesPhase(): Promise<UpdatePhaseState | null> { return null }
export async function listenForUpdateState(handler: (state: UpdatePhaseState) => void): Promise<UnlistenFn> { void handler; return () => undefined }
export async function listenForUpdateAvailable(handler: (info: UpdateInfo) => void): Promise<UnlistenFn> {
  void handler
  return () => undefined
}
export async function listenForUpdateProgress(handler: (progress: UpdateProgress) => void): Promise<UnlistenFn> {
  void handler
  return () => undefined
}

// ---------------------------------------------------------------------------
// Speech and dictation are native features on the host.

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

/** Empty values: no models on a device, and dictation is never ready here. */
export async function speechModels(): Promise<SpeechModelSummary[]> { return [] }
export async function dictationModelStatus(modelId: string): Promise<{ modelId: string; ready: boolean; sizeBytes: number }> {
  return { modelId, ready: false, sizeBytes: 0 }
}
export async function dictationCloudWarm(): Promise<{ clientReady: boolean; signedIn: boolean; dnsOk: boolean }> {
  return { clientReady: false, signedIn: false, dnsOk: false }
}

export async function downloadSpeechModel(modelId: string): Promise<{ modelId: string; directory: string }> { void modelId; throw notAvailable() }
export async function startDictation(modelId: string, owner = 'desktop'): Promise<void> { void modelId; void owner; throw notAvailable() }
/** Stopping is a no-op: a device never started dictation. */
export async function stopDictation(owner = 'desktop'): Promise<void> { void owner }
export async function cancelDictation(owner = 'desktop'): Promise<void> { void owner }

export async function listenForDictation(handler: (event: DictationEventPayload) => void): Promise<UnlistenFn> {
  void handler
  return () => undefined
}
export async function listenForDictationToggle(handler: () => void): Promise<UnlistenFn> {
  void handler
  return () => undefined
}
export async function listenForSpeechDownload(handler: (progress: { modelId: string; completed: number; total: number }) => void): Promise<UnlistenFn> {
  void handler
  return () => undefined
}

// The remote client's own surface, for a phone shell that needs it.
export { createRemoteTransport }
export type { RemoteTransport, RemoteConnectionStatus }
