import { describe, expect, it } from 'vitest'
import { notificationForTransition } from './notificationTransitions'

describe('conversation notification transitions', () => {
  it('notifies only when a session enters a completed, failed, or approval state', () => {
    expect(notificationForTransition('working', 'completed')?.body('Build')).toBe('Finished: Build')
    expect(notificationForTransition('working', 'error')?.body('Build')).toBe('Failed: Build')
    expect(notificationForTransition('working', 'waiting_permission')?.body('Build')).toBe('Needs your approval: Build')
    expect(notificationForTransition('completed', 'completed')).toBeNull()
    expect(notificationForTransition('idle', 'working')).toBeNull()
    expect(notificationForTransition(null, 'completed')).toBeNull()
    expect(notificationForTransition(undefined, 'waiting_permission')).toBeNull()
  })
})
