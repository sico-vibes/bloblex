/** Favourite blobs and pinned projects or conversations, kept on this device. */
export interface PinnedProject { agentId: string; key: string; path: string }
export interface SidebarPins { v: 1; favorites: string[]; projects: PinnedProject[]; sessions: string[]; order: string[] }

export function pointerDropPlacement(pointerY: number, rowTop: number, rowHeight: number): 'before' | 'after' {
  return pointerY < rowTop + rowHeight / 2 ? 'before' : 'after'
}

export const PINS_STORAGE_KEY = 'bloblex.sidebar.pins'

export function emptyPins(): SidebarPins {
  return { v: 1, favorites: [], projects: [], sessions: [], order: [] }
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
    const sessions = strings(value.sessions)
    const validOrder = new Set([...uniqueProjects.map((item) => `project:${item.agentId}:${item.key}`), ...sessions.map((id) => `session:${id}`)])
    const storedOrder = strings(value.order).filter((item) => validOrder.has(item))
    const order = [...storedOrder, ...[...uniqueProjects.map((item) => `project:${item.agentId}:${item.key}`), ...sessions.map((id) => `session:${id}`)].filter((item) => !storedOrder.includes(item))]
    return { v: 1, favorites: strings(value.favorites), projects: uniqueProjects, sessions, order }
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
  const id = `project:${project.agentId}:${project.key}`
  const exists = isProjectPinned(pins, project.agentId, project.key)
  const projects = exists
    ? pins.projects.filter((item) => !(item.agentId === project.agentId && item.key === project.key))
    : [...pins.projects, project]
  const order = exists ? pins.order.filter((item) => item !== id) : [...pins.order, id]
  return { ...pins, projects, order }
}

export function togglePinnedSession(pins: SidebarPins, sessionId: string): SidebarPins {
  const sessions = pins.sessions.includes(sessionId) ? pins.sessions.filter((id) => id !== sessionId) : [...pins.sessions, sessionId]
  const id = `session:${sessionId}`
  const order = pins.sessions.includes(sessionId) ? pins.order.filter((item) => item !== id) : [...pins.order, id]
  return { ...pins, sessions, order }
}

export function movePinnedItem(pins: SidebarPins, itemId: string, to: number): SidebarPins {
  const from = pins.order.indexOf(itemId)
  if (from < 0) return pins
  return { ...pins, order: move(pins.order, from, to) }
}

function move<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return [...items]
  const next = [...items]
  const [item] = next.splice(from, 1)
  if (item !== undefined) next.splice(to, 0, item)
  return next
}

function moveVisibleId(items: readonly string[], visibleIds: readonly string[], itemId: string, targetId: string, placement: 'before' | 'after') {
  const visible = visibleIds.filter((id) => items.includes(id))
  const fromVisible = visible.indexOf(itemId)
  const targetVisible = visible.indexOf(targetId)
  const from = items.indexOf(itemId)
  const target = items.indexOf(targetId)
  if (fromVisible < 0 || targetVisible < 0 || from < 0 || target < 0 || from === target) return [...items]
  const targetAfterRemoval = target - (from < target ? 1 : 0)
  const insertion = targetAfterRemoval + (placement === 'after' ? 1 : 0)
  const next = [...items]
  const [value] = next.splice(from, 1)
  if (value !== undefined) next.splice(insertion, 0, value)
  return next
}

export function moveFavoriteRelative(pins: SidebarPins, agentId: string, targetAgentId: string, placement: 'before' | 'after', visibleIds: readonly string[]) {
  return { ...pins, favorites: moveVisibleId(pins.favorites, visibleIds, agentId, targetAgentId, placement) }
}

export function movePinnedItemRelative(pins: SidebarPins, itemId: string, targetId: string, placement: 'before' | 'after', visibleIds: readonly string[]) {
  return { ...pins, order: moveVisibleId(pins.order, visibleIds, itemId, targetId, placement) }
}

export function moveFavorite(pins: SidebarPins, agentId: string, to: number): SidebarPins {
  const from = pins.favorites.indexOf(agentId)
  if (from < 0) return pins
  return { ...pins, favorites: move(pins.favorites, from, to) }
}

export function movePinnedProject(pins: SidebarPins, agentId: string, key: string, to: number): SidebarPins {
  const from = pins.projects.findIndex((item) => item.agentId === agentId && item.key === key)
  if (from < 0) return pins
  return { ...pins, projects: move(pins.projects, from, to) }
}

export function movePinnedSession(pins: SidebarPins, sessionId: string, to: number): SidebarPins {
  const from = pins.sessions.indexOf(sessionId)
  if (from < 0) return pins
  return { ...pins, sessions: move(pins.sessions, from, to) }
}

export function readPins(): SidebarPins {
  try { return parsePins(localStorage.getItem(PINS_STORAGE_KEY)) } catch { return emptyPins() }
}

export function writePins(pins: SidebarPins) {
  try { localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(pins)) } catch { /* A blocked Storage API keeps pins for this run only. */ }
}
