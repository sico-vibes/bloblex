// One undo path for every destructive action. Toasts live in a small in-window
// store so any component can raise one, and the existing `.undo-toast` surface
// (ExperimentalFeatures.UndoToasts) renders them. `useUndoable` runs the action
// and then offers Undo for the shared window.

import { useCallback, useSyncExternalStore } from 'react'
import type { UndoToast } from './ExperimentalFeatures'

/** Matches the daemon's queued-delete window. */
export const UNDO_WINDOW_MS = 8000

type Listener = () => void
let toasts: UndoToast[] = []
const listeners = new Set<Listener>()

function emit() { for (const listener of listeners) listener() }

export function subscribeUndoToasts(listener: Listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function currentUndoToasts(): UndoToast[] { return toasts }

export function pushUndoToast(toast: UndoToast) {
  toasts = [...toasts, toast]
  emit()
}

export function removeUndoToast(id: string) {
  const next = toasts.filter((toast) => toast.id !== id)
  if (next.length === toasts.length) return
  toasts = next
  emit()
}

/** Test helper: drop every queued toast without running it. */
export function resetUndoToasts() {
  if (!toasts.length) return
  toasts = []
  emit()
}

let undoSeq = 0

/**
 * Runs `action(...args)`, then shows an undo toast whose text comes from `label`
 * and whose Undo runs `undo(...args)`. The undo window is `UNDO_WINDOW_MS`.
 */
export function useUndoable<Args extends unknown[]>(
  action: (...args: Args) => Promise<unknown> | unknown,
  undo: (...args: Args) => Promise<unknown> | unknown,
  label: string | ((...args: Args) => string),
): (...args: Args) => Promise<void> {
  return useCallback(async (...args: Args) => {
    await action(...args)
    const text = typeof label === 'function' ? label(...args) : label
    undoSeq += 1
    pushUndoToast({
      id: `undo:${Date.now()}:${undoSeq}`,
      text,
      deadline: Date.now() + UNDO_WINDOW_MS,
      undo: async () => { await undo(...args) },
    })
  }, [action, undo, label])
}

/** Subscribes a component to the shared toast list. */
export function useUndoToasts(): UndoToast[] {
  return useSyncExternalStore(subscribeUndoToasts, currentUndoToasts, currentUndoToasts)
}
