import { describe, expect, it } from 'vitest'
import { emptyPins, isProjectPinned, parsePins, toggleFavorite, togglePinnedProject, togglePinnedSession } from './sidebarPins'

describe('sidebar favourites and pins', () => {
  it('toggles favourites, projects and conversations independently', () => {
    let pins = emptyPins()
    pins = toggleFavorite(pins, 'agent-a')
    pins = togglePinnedProject(pins, { agentId: 'agent-a', key: 'c:/work/site', path: 'C:\\work\\site' })
    pins = togglePinnedSession(pins, 'session-1')
    expect(pins).toEqual({ v: 1, favorites: ['agent-a'], projects: [{ agentId: 'agent-a', key: 'c:/work/site', path: 'C:\\work\\site' }], sessions: ['session-1'] })
    expect(isProjectPinned(pins, 'agent-a', 'c:/work/site')).toBe(true)
    expect(isProjectPinned(pins, 'agent-b', 'c:/work/site')).toBe(false)
    pins = toggleFavorite(pins, 'agent-a')
    pins = togglePinnedProject(pins, { agentId: 'agent-a', key: 'c:/work/site', path: 'ignored' })
    pins = togglePinnedSession(pins, 'session-1')
    expect(pins).toEqual(emptyPins())
  })

  it('reads stored pins defensively', () => {
    expect(parsePins(null)).toEqual(emptyPins())
    expect(parsePins('not json')).toEqual(emptyPins())
    expect(parsePins(JSON.stringify({ v: 2, favorites: ['a'] }))).toEqual(emptyPins())
    expect(parsePins(JSON.stringify({
      v: 1,
      favorites: ['a', 'a', 3, ''],
      projects: [{ agentId: 'a', key: 'k', path: 'p' }, { agentId: 'a', key: 'k', path: 'dupe' }, { agentId: 'a' }],
      sessions: 'nope',
    }))).toEqual({ v: 1, favorites: ['a'], projects: [{ agentId: 'a', key: 'k', path: 'p' }], sessions: [] })
  })
})
