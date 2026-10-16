import { describe, expect, it } from 'vitest'
import type { Session } from '../types'
import { lastTurnChanges } from './ChangeBanner'

const base = (extra: Partial<Session>): Session => ({ id: 's', runtimeId: 'rt', state: 'completed', ...extra })

describe('change banner', () => {
  const turns = [{ id: 't1', state: 'completed' }, { id: 't2', state: 'completed' }]
  const files = [
    { id: 'f1', turnId: 't1', path: 'old.ts', detail: { diff: '@@ -1 +1 @@\n-a\n+b' } },
    { id: 'f2', turnId: 't2', path: 'src/a.ts', detail: { diff: '@@ -1 +1,2 @@\n+x\n+y' } },
    { id: 'f3', turnId: 't2', path: 'src/a.ts', detail: { diff: '@@ -1 +1 @@\n-x\n+z' } },
    { id: 'f4', turnId: 't2', path: 'gone.ts', detail: { reverted: true } },
  ]

  it('shows only the latest finished turn, one row per path, without reverted files', () => {
    expect(lastTurnChanges(base({ turns, files })).map((file) => file.id)).toEqual(['f3'])
  })

  it('stays quiet while a turn is running', () => {
    expect(lastTurnChanges(base({ turns, files, state: 'working' }))).toEqual([])
    expect(lastTurnChanges(base({ turns: [...turns.slice(0, 1), { id: 't2', state: 'working' }], files }))).toEqual([])
    expect(lastTurnChanges(null)).toEqual([])
  })
})
