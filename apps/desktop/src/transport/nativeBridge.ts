// The one seam over the Tauri API for UI code. Apart from `src/tauri.ts` and
// `src/desktopIntegrations.ts`, no other module outside `src/transport/` may
// import `@tauri-apps/*`: everything goes through the thin wrappers here, so a
// browser build can swap the whole transport. The wrappers keep the exact
// semantics the call sites used before (including rejections and the raw event
// shape for window drag-and-drop / per-webview listeners).
import { invoke, isTauri } from '@tauri-apps/api/core'
import { emit as emitTauri, listen as listenTauri } from '@tauri-apps/api/event'
import { getCurrentWindow, type Window as TauriWindow } from '@tauri-apps/api/window'
import { getCurrentWebviewWindow, type WebviewWindow as TauriWebviewWindow } from '@tauri-apps/api/webviewWindow'

/** True inside a Tauri host. */
export const isNative = (): boolean => isTauri()

/** `invoke`, unchanged: rejects exactly as the raw command does. */
export function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args)
}

/** `listen`, with the handler receiving the payload rather than the envelope. */
export function listenNative<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  return listenTauri<T>(event, (message) => handler(message.payload))
}

/** `emit`, unchanged. */
export function emitNative(event: string, payload?: unknown): Promise<void> {
  return emitTauri(event, payload)
}

/** The current window, narrowed to what the UI uses. */
export function currentWindow(): Pick<TauriWindow, 'onDragDropEvent' | 'startDragging'> {
  return getCurrentWindow()
}

/** The current webview window, narrowed to what the UI uses. */
export function currentWebviewWindow(): Pick<TauriWebviewWindow, 'listen'> {
  return getCurrentWebviewWindow()
}
