// C12: the companion drop zone. Dragging a file over the island opens the chat
// once and keeps it open until the drag is gone for a short grace period, so a
// drag that dips out and back in does not collapse and re-expand. Pure phase
// machine; the component owns the timer and the view.

/** How long after a drag leaves the island waits before collapsing. */
export const DROP_LEAVE_GRACE_MS = 250

export type DropPhase = 'idle' | 'over' | 'pending'
export type DropEvent = 'enter' | 'leave' | 'drop'

/**
 * Advance the zone. `over` is a drag on the island; `pending` is a drag that
 * just left and may return within the grace period. Returning while pending
 * goes straight back to `over` (no collapse), and a drop always ends at `idle`.
 */
export function advanceDropZone(phase: DropPhase, event: DropEvent): DropPhase {
  if (event === 'drop') return 'idle'
  if (event === 'enter') return 'over'
  // leave
  return phase === 'over' ? 'pending' : phase
}

/** True while the island should show the drop card (a drag is on it, or may return). */
export function dropZoneActive(phase: DropPhase): boolean {
  return phase !== 'idle'
}

/** The file-name chip texts: name, upper-case extension, and the readable size. */
export function dropChips(path: string, sizeBytes: number | null | undefined): { name: string; type: string; size: string } {
  const name = path.split(/[\\/]/).pop() || path
  const match = /\.([a-z0-9]{1,12})$/i.exec(name)
  return {
    name,
    type: match ? match[1]!.toUpperCase() : 'File',
    size: typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) ? formatDropSize(sizeBytes) : '—',
  }
}

function formatDropSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
