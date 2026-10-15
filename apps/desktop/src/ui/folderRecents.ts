// The last working folders chosen in this app (FIX22 B7). Local to this device;
// the daemon keeps nothing here. Valid strings only: an empty or non-string
// entry is never remembered.

/** How many recent folders the working-folder menu offers. */
export const RECENT_FOLDER_LIMIT = 6

const KEY = 'bitbots.recentFolders'

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

/** Recent folders, newest first, deduped, valid strings only. */
export function recentFolders(): string[] {
  const store = storage()
  if (!store) return []
  try {
    const raw = store.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .slice(0, RECENT_FOLDER_LIMIT)
  } catch { return [] }
}

/** Remembers a folder as the most recent choice, dropping any older copy. */
export function rememberFolder(path: string): void {
  const trimmed = typeof path === 'string' ? path.trim() : ''
  if (!trimmed) return
  const store = storage()
  if (!store) return
  const next = [trimmed, ...recentFolders().filter((item) => item !== trimmed)].slice(0, RECENT_FOLDER_LIMIT)
  try { store.setItem(KEY, JSON.stringify(next)) } catch { /* The menu is a convenience. */ }
}
