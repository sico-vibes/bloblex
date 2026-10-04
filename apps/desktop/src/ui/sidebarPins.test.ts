import { describe, expect, it } from 'vitest'
import { emptyPins, isProjectPinned, moveFavorite, moveFavoriteRelative, movePinnedItem, movePinnedItemRelative, parsePins, pointerDropPlacement, toggleFavorite, togglePinnedProject, togglePinnedSession } from './sidebarPins'

describe('sidebar favourites and pins', () => {
  it('toggles favourites, projects and conversations independently', () => {
    let pins = emptyPins()
    pins = toggleFavorite(pins, 'agent-a')
    pins = togglePinnedProject(pins, { agentId: 'agent-a', key: 'c:/work/site', path: 'C:\\work\\site' })
    pins = togglePinnedSession(pins, 'session-1')
    expect(pins).toEqual({ v: 1, favorites: ['agent-a'], projects: [{ agentId: 'agent-a', key: 'c:/work/site', path: 'C:\\work\\site' }], sessions: ['session-1'], order: ['project:agent-a:c:/work/site', 'session:session-1'] })
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
    }))).toEqual({ v: 1, favorites: ['a'], projects: [{ agentId: 'a', key: 'k', path: 'p' }], sessions: [], order: ['project:a:k'] })
  })

  it('moves favourites and pins in their own stored order', () => {
    const pins = {
      v: 1 as const,
      favorites: ['a', 'b', 'c'],
      projects: [{ agentId: 'a', key: 'one', path: 'one' }, { agentId: 'b', key: 'two', path: 'two' }],
      sessions: ['s1', 's2', 's3'], order: ['project:a:one', 'project:b:two', 'session:s1', 'session:s2', 'session:s3'],
    }
    const reordered = movePinnedItem(moveFavorite(pins, 'c', 0), 'session:s3', 0)
    expect(reordered.favorites).toEqual(['c', 'a', 'b'])
    expect(reordered.projects.map((item) => item.key)).toEqual(['one', 'two'])
    expect(reordered.sessions).toEqual(['s1', 's2', 's3'])
    expect(reordered.order[0]).toBe('session:s3')
    expect(reordered.favorites).toEqual(moveFavorite(reordered, 'missing', 0).favorites)
  })

  it('drops above or below a target, supports the last slot, and skips hidden ids', () => {
    expect(pointerDropPlacement(24, 10, 30)).toBe('before')
    expect(pointerDropPlacement(26, 10, 30)).toBe('after')
    const pins = {
      ...emptyPins(),
      favorites: ['a', 'hidden', 'b', 'c'],
      order: ['session:a', 'session:hidden', 'project:x:p', 'session:b', 'session:c'],
      sessions: ['a', 'hidden', 'b', 'c'],
      projects: [{ agentId: 'x', key: 'p', path: 'p' }],
    }
    const visibleFavorites = ['a', 'b', 'c']
    const visiblePins = ['session:a', 'project:x:p', 'session:b', 'session:c']
    const fav = moveFavoriteRelative(pins, 'a', 'c', 'before', visibleFavorites)
    const favLast = moveFavoriteRelative(pins, 'a', 'c', 'after', visibleFavorites)
    const favFirst = moveFavoriteRelative(pins, 'c', 'a', 'before', visibleFavorites)
    const reorderedPins = movePinnedItemRelative(pins, 'session:a', 'session:b', 'after', visiblePins)
    const pinnedLast = movePinnedItemRelative(pins, 'session:a', 'session:c', 'after', visiblePins)
    expect(fav.favorites.filter((id) => visibleFavorites.includes(id))).toEqual(['b', 'a', 'c'])
    expect(favLast.favorites.filter((id) => visibleFavorites.includes(id))).toEqual(['b', 'c', 'a'])
    expect(favFirst.favorites.filter((id) => visibleFavorites.includes(id))).toEqual(['c', 'a', 'b'])
    expect(reorderedPins.order.filter((id) => visiblePins.includes(id))).toEqual(['project:x:p', 'session:b', 'session:a', 'session:c'])
    expect(pinnedLast.order.filter((id) => visiblePins.includes(id))).toEqual(['project:x:p', 'session:b', 'session:c', 'session:a'])
  })
})
