import { afterEach, describe, expect, it } from 'vitest'
import { doingNowLabel } from './doingNow'
import { SILENT_AFTER_MS, deriveCompanionStatus } from './companionStatus'
import { eventSessionId, noteSessionActivity, resetSessionActivity } from './sessionActivity'
import type { Runtime, Session } from '../types'

describe('doing-now line', () => {
  it('says what the running tool does, in plain words', () => {
    expect(doingNowLabel({ kind: 'exec', title: 'Bash', detail: { label: 'Ran npm test' } })).toBe('Running npm test')
    expect(doingNowLabel({ kind: 'edit', title: 'Edit', detail: { path: 'C:/repo/src/ui/App.tsx' } })).toBe('Editing App.tsx')
    expect(doingNowLabel({ kind: 'edit', title: 'Edit', detail: { path: 'a.ts', fileCount: 3 } })).toBe('Editing 3 files')
    expect(doingNowLabel({ kind: 'read', title: 'Read', detail: { path: '/repo/README.md' } })).toBe('Reading README.md')
    expect(doingNowLabel({ kind: 'search', title: 'Grep', detail: { pattern: 'retry' } })).toBe('Searching for “retry”')
    expect(doingNowLabel({ kind: 'fetch', title: 'WebFetch', detail: { url: 'https://example.com/docs' } })).toBe('Opening example.com')
    expect(doingNowLabel({ kind: 'other', title: 'mcp · list_blobs' })).toBe('mcp · list_blobs')
    expect(doingNowLabel({ kind: 'other' })).toBe('Working')
  })

  it('keeps long commands short', () => {
    const label = doingNowLabel({ kind: 'exec', detail: { label: `Ran ${'x'.repeat(200)}` } })
    expect(label.length).toBeLessThanOrEqual(48)
    expect(label.endsWith('…')).toBe(true)
  })
})

describe('silent waits', () => {
  afterEach(() => resetSessionActivity())
  const runtime = { id: 'rt', provider: 'claude', status: 'online' } as Runtime
  const session = (extra: Partial<Session> = {}) => ({ id: 's1', runtimeId: 'rt', state: 'working', updatedAt: '2026-10-27T10:00:00.000Z', ...extra }) as Session
  const start = Date.parse('2026-10-27T10:00:00.000Z')

  it('names the coding agent after a minute with nothing heard', () => {
    noteSessionActivity('s1', start)
    expect(deriveCompanionStatus({ connected: true, runtime, session: session(), now: start + SILENT_AFTER_MS - 1 }).label).toBe('Typing…')
    expect(deriveCompanionStatus({ connected: true, runtime, session: session(), now: start + SILENT_AFTER_MS }).label).toBe('Waiting for Claude Code…')
  })

  it('counts any event as activity, and a running tool is not a silent wait', () => {
    noteSessionActivity('s1', start + 50_000)
    expect(deriveCompanionStatus({ connected: true, runtime, session: session(), now: start + SILENT_AFTER_MS + 1 }).label).toBe('Typing…')
    const tool = { id: 't', state: 'running', kind: 'exec', detail: { label: 'Ran npm test' } }
    expect(deriveCompanionStatus({ connected: true, runtime, session: session({ tools: [tool] }), now: start + 10 * SILENT_AFTER_MS }).label).toBe('Running npm test')
  })

  it('reads the conversation from either event shape', () => {
    expect(eventSessionId({ sessionId: 'a' })).toBe('a')
    expect(eventSessionId({ session: { id: 'b' } })).toBe('b')
    expect(eventSessionId({ id: 'c' })).toBeNull()
    expect(eventSessionId(null)).toBeNull()
  })
})
