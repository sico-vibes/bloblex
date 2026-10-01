import { describe, expect, it } from 'vitest'
import { sessionsForPauseRequest } from './trayActions'

describe('tray pause request candidates', () => {
  it('includes only active states and leaves terminal sessions untouched', () => {
    const sessions = [
      { id: 'start', state: 'starting' }, { id: 'work', state: 'working' },
      { id: 'permission', state: 'waiting_permission' }, { id: 'input', state: 'waiting_user' },
      { id: 'done', state: 'completed' }, { id: 'error', state: 'error' },
    ]
    expect(sessionsForPauseRequest(sessions as never).map((session) => session.id)).toEqual(['start', 'work', 'permission', 'input'])
  })
})
