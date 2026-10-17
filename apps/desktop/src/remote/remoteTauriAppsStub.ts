// The remote build's stand-in for every native Tauri npm module the UI can
// reach. `vite.remote.config.ts` aliases all of them here, so no native Tauri
// code and no `__TAURI` global can enter the phone bundle.
//
// Nothing in this file talks to a native shell. `invoke` (the only call that
// would reach the host's own daemon) throws rather than silently returning a
// wrong shape; the event helpers keep an in-memory emitter so a stray listener
// does not crash the shell.

const NOT_AVAILABLE = 'Not available on a remote device.'

/** The desktop `daemon_rpc` path; a device talks to the gateway instead. */
export function invoke<T>(_command: string, _args?: unknown): Promise<T> {
  return Promise.reject(new Error(NOT_AVAILABLE))
}

export function isTauri(): boolean { return false }

type EventHandler = (event: { payload: unknown }) => void
const listeners = new Map<string, Set<EventHandler>>()

export async function listen<T>(name: string, handler: (event: { payload: T }) => void): Promise<() => void> {
  const set = listeners.get(name) ?? new Set<EventHandler>()
  const wrapped = handler as EventHandler
  set.add(wrapped)
  listeners.set(name, set)
  return () => { set.delete(wrapped) }
}

export async function emit(name: string, payload?: unknown): Promise<void> {
  for (const handler of listeners.get(name) ?? []) handler({ payload })
}

export type UnlistenFn = () => void

/** Mirrors the enum's shape; no window ever requests attention here. */
export const UserAttentionType = { Critical: 1, Informational: 2 } as const

export function getCurrentWindow() {
  return {
    onDragDropEvent: async () => () => undefined,
    requestUserAttention: async () => undefined,
  }
}

export function getCurrentWebviewWindow() {
  return getCurrentWindow()
}

// Stand-in for the autostart plugin.
export async function isEnabled(): Promise<boolean> { return false }
export async function enable(): Promise<void> { /* no-op */ }
export async function disable(): Promise<void> { /* no-op */ }

// Stand-in for the notification plugin.
export async function isPermissionGranted(): Promise<boolean> { return false }
export async function requestPermission(): Promise<'granted' | 'denied' | 'default'> { return 'denied' }
export function sendNotification(_options: unknown): void { /* no-op */ }
