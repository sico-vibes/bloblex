/** Favourite blobs and pinned projects or conversations, kept on this device. */
export interface PinnedProject { agentId: string; key: string; path: string }
export interface SidebarPins { v: 1; favorites: string[]; projects: PinnedProject[]; sessions: string[] }

export const PINS_STORAGE_KEY = 'bloblex.sidebar.pins'

export function emptyPins(): SidebarPins {
  return { v: 1, favorites: [], projects: [], sessions: [] }
}

const strings = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))] : []

export function parsePins(raw: string | null): SidebarPins {
  if (!raw) return emptyPins()
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value || typeof value !== 'object' || value.v !== 1) return emptyPins()
    const projects = Array.isArray(value.projects)
      ? value.projects.filter((item): item is PinnedProject => !!item && typeof item === 'object'
        && typeof (item as PinnedProject).agentId === 'string' && typeof (item as PinnedProject).key === 'string' && typeof (item as PinnedProject).path === 'string')
        .map((item) => ({ agentId: item.agentId, key: item.key, path: item.path }))
      : []
    const uniqueProjects = projects.filter((item, index) => projects.findIndex((other) => other.agentId === item.agentId && other.key === item.key) === index)
    return { v: 1, favorites: strings(value.favorites), projects: uniqueProjects, sessions: strings(value.sessions) }
  } catch {
    return emptyPins()
  }
}

export function toggleFavorite(pins: SidebarPins, agentId: string): SidebarPins {
  const favorites = pins.favorites.includes(agentId) ? pins.favorites.filter((id) => id !== agentId) : [...pins.favorites, agentId]
  return { ...pins, favorites }
}

export function isProjectPinned(pins: SidebarPins, agentId: string, key: string) {
  return pins.projects.some((item) => item.agentId === agentId && item.key === key)
}

export function togglePinnedProject(pins: SidebarPins, project: PinnedProject): SidebarPins {
  const projects = isProjectPinned(pins, project.agentId, project.key)
    ? pins.projects.filter((item) => !(item.agentId === project.agentId && item.key === project.key))
    : [...pins.projects, project]
  return { ...pins, projects }
}

export function togglePinnedSession(pins: SidebarPins, sessionId: string): SidebarPins {
  const sessions = pins.sessions.includes(sessionId) ? pins.sessions.filter((id) => id !== sessionId) : [...pins.sessions, sessionId]
  return { ...pins, sessions }
}

export function readPins(): SidebarPins {
  try { return parsePins(localStorage.getItem(PINS_STORAGE_KEY)) } catch { return emptyPins() }
}

export function writePins(pins: SidebarPins) {
  try { localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(pins)) } catch { /* A blocked Storage API keeps pins for this run only. */ }
}
