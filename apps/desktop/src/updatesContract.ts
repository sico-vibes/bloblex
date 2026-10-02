export type UpdateChannel = 'stable' | 'beta'

export type UpdateCheckStatus = 'up_to_date' | 'available' | 'no_stable_release' | 'error'

export type UpdateErrorCode = 'network' | 'signature' | 'manifest' | 'unavailable' | 'no_update'

export interface UpdateInfo {
  version: string
  notes: string | null
  pubDate: string | null
  channel: UpdateChannel
}

export interface UpdatesState {
  currentVersion: string
  channel: UpdateChannel
  autoCheck: boolean
  lastCheckedAt: string | null
  available: UpdateInfo | null
  devBuild: boolean
}

export interface UpdateCheckResult {
  status: UpdateCheckStatus
  checkedAt: string
  update?: UpdateInfo
  error?: UpdateErrorCode
}

export interface UpdateProgress {
  phase: 'downloading' | 'installing'
  downloadedBytes: number
  totalBytes: number | null
}

export interface UpdatePreferences {
  channel?: UpdateChannel
  autoCheck?: boolean
}

export const UPDATE_FAILED_MESSAGE = 'Update failed'

export const UPDATE_ERROR_MESSAGES: Record<UpdateErrorCode, string> = {
  network: 'Could not reach the update server.',
  signature: 'The update signature could not be verified.',
  manifest: 'The update manifest could not be read.',
  unavailable: 'Updates are unavailable right now.',
  no_update: 'No update is ready to install.',
}

export const DEV_BUILD_UPDATES_MESSAGE = 'Updates are unavailable in development builds'
export const NO_STABLE_RELEASE_MESSAGE = 'No stable release yet.'
export const UP_TO_DATE_MESSAGE = 'Bloblex is up to date.'
export const INSTALLING_RESTART_MESSAGE = 'Installing. Bloblex will restart.'
export const CHECKING_UPDATES_MESSAGE = 'Checking for updates.'

export const STABLE_CHANNEL_EXPLANATION = 'Finished releases only.'
export const BETA_CHANNEL_EXPLANATION = 'Includes pre-releases. Used by default until a finished release exists.'

const RUNNING_SESSION_STATES = new Set(['starting', 'working', 'cancelling', 'waiting_permission', 'waiting_user'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function parseUpdateChannel(value: unknown): UpdateChannel | null {
  return value === 'stable' || value === 'beta' ? value : null
}

export function knownUpdateError(value: unknown): UpdateErrorCode | null {
  if (value === 'network' || value === 'signature' || value === 'manifest' || value === 'unavailable' || value === 'no_update') return value
  return null
}

export function updateErrorMessage(value: unknown): string {
  const code = knownUpdateError(value)
  return code ? UPDATE_ERROR_MESSAGES[code] : UPDATE_FAILED_MESSAGE
}

/** Pulls a fixed error code off a rejected command. Raw message text is never returned. */
export function updateFailureCode(reason: unknown): unknown {
  if (isRecord(reason)) {
    if ('code' in reason) return reason.code
    if ('error' in reason) return reason.error
  }
  if (typeof reason === 'string') return reason
  if (reason instanceof Error) return reason.message
  return null
}

export function safeUpdateFailureMessage(reason: unknown): string {
  return updateErrorMessage(updateFailureCode(reason))
}

const SAFE_UPDATE_MESSAGES = new Set<string>([UPDATE_FAILED_MESSAGE, ...Object.values(UPDATE_ERROR_MESSAGES)])

/** Shows a fixed sentence. A message that is not one of those sentences becomes the generic failure. */
export function displayUpdateFailure(reason: unknown): string {
  if (reason instanceof Error && SAFE_UPDATE_MESSAGES.has(reason.message)) return reason.message
  return safeUpdateFailureMessage(reason)
}

export function parseUpdateInfo(value: unknown): UpdateInfo | null {
  if (!isRecord(value) || typeof value.version !== 'string' || !value.version.trim()) return null
  return {
    version: value.version.trim(),
    notes: typeof value.notes === 'string' ? value.notes : null,
    pubDate: typeof value.pubDate === 'string' && value.pubDate.trim() ? value.pubDate : null,
    channel: parseUpdateChannel(value.channel) ?? 'beta',
  }
}

export function parseUpdatesState(value: unknown): UpdatesState | null {
  if (!isRecord(value)) return null
  const available = value.available == null ? null : parseUpdateInfo(value.available)
  return {
    currentVersion: typeof value.currentVersion === 'string' ? value.currentVersion : '',
    channel: parseUpdateChannel(value.channel) ?? 'beta',
    autoCheck: typeof value.autoCheck === 'boolean' ? value.autoCheck : true,
    lastCheckedAt: typeof value.lastCheckedAt === 'string' && value.lastCheckedAt.trim() ? value.lastCheckedAt : null,
    available: value.available == null ? null : available,
    devBuild: value.devBuild === true,
  }
}

export function parseUpdateCheck(value: unknown): UpdateCheckResult | null {
  if (!isRecord(value)) return null
  const status = value.status
  if (status !== 'up_to_date' && status !== 'available' && status !== 'no_stable_release' && status !== 'error') return null
  const checkedAt = typeof value.checkedAt === 'string' ? value.checkedAt : ''
  const update = value.update == null ? undefined : parseUpdateInfo(value.update) ?? undefined
  const error = status === 'error' ? knownUpdateError(value.error) ?? undefined : undefined
  return {
    status,
    checkedAt,
    ...(update ? { update } : {}),
    ...(status === 'error' && error ? { error } : {}),
  }
}

export function parseUpdateProgress(value: unknown): UpdateProgress | null {
  if (!isRecord(value)) return null
  if (value.phase !== 'downloading' && value.phase !== 'installing') return null
  const downloaded = typeof value.downloadedBytes === 'number' && Number.isFinite(value.downloadedBytes) ? Math.max(0, value.downloadedBytes) : 0
  const total = typeof value.totalBytes === 'number' && Number.isFinite(value.totalBytes) && value.totalBytes > 0 ? value.totalBytes : null
  return { phase: value.phase, downloadedBytes: downloaded, totalBytes: total }
}

export function parseUpdatePreferences(value: unknown): UpdatePreferences {
  if (!isRecord(value)) return {}
  const channel = parseUpdateChannel(value.channel)
  const preferences: UpdatePreferences = {}
  if (channel) preferences.channel = channel
  if (typeof value.autoCheck === 'boolean') preferences.autoCheck = value.autoCheck
  return preferences
}

export function formatByteCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  const shown = unit === 0 || size >= 10 ? String(Math.round(size)) : size.toFixed(1)
  return `${shown} ${units[unit]}`
}

export function updatePercent(downloadedBytes: number, totalBytes: number | null): number | null {
  if (totalBytes == null || !Number.isFinite(totalBytes) || totalBytes <= 0) return null
  if (!Number.isFinite(downloadedBytes) || downloadedBytes <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((downloadedBytes / totalBytes) * 100)))
}

export function describeUpdateProgress(progress: UpdateProgress): { label: string; percent: number | null } {
  const percent = updatePercent(progress.downloadedBytes, progress.totalBytes)
  if (progress.phase === 'installing') return { label: INSTALLING_RESTART_MESSAGE, percent }
  if (percent == null) return { label: `Downloaded ${formatByteCount(progress.downloadedBytes)}.`, percent: null }
  return {
    label: `Downloaded ${formatByteCount(progress.downloadedBytes)} of ${formatByteCount(progress.totalBytes ?? 0)} (${percent}%).`,
    percent,
  }
}

export function formatUpdateTimestamp(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return null
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

export function installImpactCopy(count: number): string {
  const noun = count === 1 ? 'session is' : 'sessions are'
  return `${count} ${noun} running or waiting for approval. They will end when Bloblex restarts.`
}

export function countInstallAffectedSessions(
  sessions: readonly { id?: string; state?: string | null }[] | null | undefined,
  permissions: readonly { sessionId?: string; status?: unknown }[] | null | undefined,
): number {
  const ids = new Set<string>()
  let anonymous = 0
  for (const session of sessions ?? []) {
    if (!session || typeof session.state !== 'string' || !RUNNING_SESSION_STATES.has(session.state)) continue
    if (session.id) ids.add(session.id)
    else anonymous += 1
  }
  for (const permission of permissions ?? []) {
    if (!permission || (permission.status != null && permission.status !== 'pending')) continue
    if (permission.sessionId) {
      if (!ids.has(permission.sessionId)) ids.add(permission.sessionId)
    } else anonymous += 1
  }
  return ids.size + anonymous
}
