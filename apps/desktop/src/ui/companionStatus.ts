import type { BlobMood } from '../blob/BlobCanvas'
import type { Runtime, Session } from '../types'

/** A finished turn shows the happy face this long, then the blob relaxes. */
export const SUCCESS_HOLD_MS = 6_000
/** A blob reads as online for this long after its last activity. */
export const ONLINE_HOLD_MS = 2 * 60_000
/** After this long without activity the blob falls asleep. */
export const SLEEP_AFTER_MS = 10 * 60_000

/** Milliseconds since the session last changed, or null when the time is unknown. */
export function sessionIdleMs(session: Session | null | undefined, now: number) {
  const stamp = Date.parse(String(session?.updatedAt ?? ''))
  return Number.isFinite(stamp) ? Math.max(0, now - stamp) : null
}

function restingStatus(idleMs: number, label: string): { mood: BlobMood; label: string } {
  return idleMs >= SLEEP_AFTER_MS ? { mood: 'sleeping', label: 'Sleeping' } : { mood: 'idle', label }
}

export function deriveCompanionStatus(input: { connected: boolean; runtime?: Runtime | null; session?: Session | null; permissionPending?: boolean; budgetWarning?: boolean; composing?: boolean; now?: number }): { mood: BlobMood; label: string } {
  const { connected, runtime, session } = input
  const idleMs = sessionIdleMs(session, input.now ?? Date.now())
  if (!connected) return { mood: 'offline', label: 'Daemon disconnected' }
  if (!runtime || ['offline', 'error', 'disconnected'].includes((runtime.status ?? '').toLowerCase())) return { mood: 'offline', label: runtime ? 'Runtime offline' : 'No runtime selected' }
  if (input.permissionPending || session?.state === 'waiting_permission') return { mood: 'permission', label: 'Approval needed' }
  if (input.budgetWarning) return { mood: 'budget_warning', label: 'Budget warning' }
  if (session?.state === 'rate_limited') return { mood: 'rate_limited', label: 'Rate limited' }
  if (session?.state === 'sleeping') return { mood: 'sleeping', label: 'Sleeping' }
  if (session?.state === 'error' || session?.state === 'failed') return { mood: 'error', label: 'Needs attention' }
  if (input.composing) return { mood: 'listening', label: 'Ready for your message' }
  if (session?.state === 'completed') return idleMs === null || idleMs < SUCCESS_HOLD_MS ? { mood: 'success', label: 'Done' } : restingStatus(idleMs, 'Done')
  if (session?.state === 'cancelled' || session?.state === 'canceled') return idleMs === null ? { mood: 'idle', label: 'Cancelled' } : restingStatus(idleMs, 'Cancelled')

  const activeTurn = [...(session?.turns ?? [])].reverse().find((turn) => ['working', 'running', 'starting', 'pending'].includes(String(turn.state ?? '').toLowerCase()))
  const activeTurnId = activeTurn?.id ?? session?.turnId
  const belongsToActiveTurn = (item: Record<string, unknown>) => !activeTurnId || item.turnId === activeTurnId
  const latestTool = [...(session?.tools ?? [])].reverse().find((item) => belongsToActiveTurn(item) && ['running', 'pending', 'started'].includes(String(item.state ?? '').toLowerCase()))
  if (latestTool) {
    return { mood: 'tool_activity', label: typeof latestTool.title === 'string' ? latestTool.title : 'Tool activity' }
  }
  const latestMessage = session?.messages?.at(-1)
  const latestFile = [...(session?.files ?? [])].reverse().find(belongsToActiveTurn)
  if (session?.state === 'working' && latestFile && belongsToActiveTurn(latestFile) && isNewerThanMessage(latestFile, latestMessage)) {
    return { mood: 'file_activity', label: `Updated ${String(latestFile.path ?? 'a file').split(/[\\/]/).pop()}` }
  }
  if (session?.state === 'working' && latestMessage?.role === 'thinking' && belongsToActiveTurn(latestMessage)) return { mood: 'thinking', label: 'Thinking' }
  if (['working', 'starting', 'cancelling'].includes(session?.state ?? '')) return { mood: 'working', label: 'Typing…' }
  const restLabel = session?.state ? session.state.replaceAll('_', ' ') : 'Idle'
  if (['online', 'ready', 'available', 'connected'].includes((runtime.status ?? '').toLowerCase())) {
    if (idleMs === null || idleMs < ONLINE_HOLD_MS) return { mood: 'online', label: 'Online' }
    return restingStatus(idleMs, 'Idle')
  }
  return idleMs === null ? { mood: 'idle', label: restLabel } : restingStatus(idleMs, restLabel)
}

function isNewerThanMessage(file: Record<string, unknown>, message?: Record<string, unknown>) {
  if (!message) return true
  if (typeof file.sequence === 'number' && typeof message.sequence === 'number') return file.sequence > message.sequence
  const fileTime = Date.parse(String(file.createdAt ?? file.updatedAt ?? file.timestamp ?? ''))
  const messageTime = Date.parse(String(message.createdAt ?? message.timestamp ?? ''))
  return Number.isFinite(fileTime) && Number.isFinite(messageTime) ? fileTime > messageTime : false
}
