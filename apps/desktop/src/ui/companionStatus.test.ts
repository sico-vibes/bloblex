import { describe, expect, it } from 'vitest'
import { deriveCompanionStatus } from './companionStatus'
import { moodWithFileReference } from '../blob/characterState'

const runtime = { id: 'rt-1', provider: 'codex', status: 'online' }

describe('companion status from live app state', () => {
  it('keeps offline truth ahead of session success and online runtime state', () => {
    expect(deriveCompanionStatus({ connected: false, runtime, session: { id: 's-1', runtimeId: runtime.id, state: 'completed' } })).toEqual({ mood: 'offline', label: 'Daemon disconnected' })
    expect(deriveCompanionStatus({ connected: true, runtime: { ...runtime, status: 'offline' }, session: { id: 's-1', runtimeId: runtime.id, state: 'working' } }).mood).toBe('offline')
  })

  it('prioritizes a pending approval and active tool activity', () => {
    const session = { id: 's-1', runtimeId: runtime.id, state: 'working', tools: [{ id: 'tool-1', state: 'running', title: 'Run tests' }] }
    expect(deriveCompanionStatus({ connected: true, runtime, session, permissionPending: true }).mood).toBe('permission')
    expect(deriveCompanionStatus({ connected: true, runtime, session })).toEqual({ mood: 'tool_activity', label: 'Run tests' })
  })

  it('distinguishes thinking, visible typing, local composer, and file updates', () => {
    const session = { id: 's-1', runtimeId: runtime.id, state: 'working' }
    expect(deriveCompanionStatus({ connected: true, runtime, session: { ...session, messages: [{ role: 'thinking' }] } }).mood).toBe('thinking')
    expect(deriveCompanionStatus({ connected: true, runtime, session }).label).toBe('Typing…')
    expect(deriveCompanionStatus({ connected: true, runtime, session, composing: true }).mood).toBe('listening')
    expect(deriveCompanionStatus({ connected: true, runtime, session: { ...session, state: 'completed', files: [{ path: 'src/main.ts' }] } }).label).toBe('Done')
  })

  it('returns to listening when the user resumes interacting after a completed turn, but preserves active barriers and failures', () => {
    const completed = { id: 's-1', runtimeId: runtime.id, state: 'completed' }
    expect(deriveCompanionStatus({ connected: true, runtime, session: completed, composing: true })).toEqual({ mood: 'listening', label: 'Ready for your message' })
    expect(deriveCompanionStatus({ connected: true, runtime, session: { ...completed, state: 'failed' }, composing: true }).mood).toBe('error')
    expect(deriveCompanionStatus({ connected: true, runtime, session: completed, composing: true, permissionPending: true }).mood).toBe('permission')
  })

  it('composes completed-session interaction with local file cues while retaining safety and failure priority', () => {
    const completed = { id: 's-1', runtimeId: runtime.id, state: 'completed' }
    const listening = deriveCompanionStatus({ connected: true, runtime, session: completed, composing: true })
    expect(moodWithFileReference(listening.mood, 'drop')).toBe('file_drop')
    expect(moodWithFileReference(listening.mood, 'ready')).toBe('file_ready')
    expect(moodWithFileReference(deriveCompanionStatus({ connected: false, runtime, session: completed }).mood, 'drop')).toBe('offline')
    expect(moodWithFileReference(deriveCompanionStatus({ connected: true, runtime, session: completed, permissionPending: true }).mood, 'ready')).toBe('permission')
    expect(moodWithFileReference(deriveCompanionStatus({ connected: true, runtime, session: { ...completed, state: 'failed' } }).mood, 'ready')).toBe('error')
  })

  it('lets terminal state win over stale history and ignores old activity in a new turn', () => {
    expect(deriveCompanionStatus({ connected: true, runtime, session: {
      id: 's-1', runtimeId: runtime.id, state: 'completed',
      messages: [{ role: 'thinking' }], files: [{ path: 'src/old.ts' }], tools: [{ state: 'running', title: 'Old tool' }],
    } }).mood).toBe('success')
    expect(deriveCompanionStatus({ connected: true, runtime, session: {
      id: 's-1', runtimeId: runtime.id, state: 'working', turnId: 'turn-new',
      turns: [{ id: 'turn-new', state: 'working' }],
      files: [{ path: 'src/old.ts', turnId: 'turn-old' }],
    } }).mood).toBe('working')
  })

  it('shows a newer current-turn file update instead of the prior thinking delta', () => {
    expect(deriveCompanionStatus({ connected: true, runtime, session: {
      id: 's-1', runtimeId: runtime.id, state: 'working', turnId: 'turn-2',
      messages: [{ role: 'thinking', turnId: 'turn-2', sequence: 10 }],
      files: [{ path: 'src/App.tsx', turnId: 'turn-2', sequence: 11 }],
    } })).toEqual({ mood: 'file_activity', label: 'Updated App.tsx' })
  })
})

describe('blob moods settle over time', () => {
  const at = Date.parse('2026-10-02T12:00:00Z')
  const ago = (ms: number) => new Date(at - ms).toISOString()
  const base = { id: 's-1', runtimeId: runtime.id }

  it('shows the happy face right after a turn completes, then relaxes to idle and finally sleeps', () => {
    expect(deriveCompanionStatus({ connected: true, runtime, session: { ...base, state: 'completed', updatedAt: ago(2_000) }, now: at }).mood).toBe('success')
    expect(deriveCompanionStatus({ connected: true, runtime, session: { ...base, state: 'completed', updatedAt: ago(30_000) }, now: at })).toEqual({ mood: 'idle', label: 'Done' })
    expect(deriveCompanionStatus({ connected: true, runtime, session: { ...base, state: 'completed', updatedAt: ago(20 * 60_000) }, now: at })).toEqual({ mood: 'sleeping', label: 'Sleeping' })
  })

  it('reads online only briefly after activity, then idle, then asleep', () => {
    expect(deriveCompanionStatus({ connected: true, runtime, session: { ...base, state: 'idle', updatedAt: ago(30_000) }, now: at }).mood).toBe('online')
    expect(deriveCompanionStatus({ connected: true, runtime, session: { ...base, state: 'idle', updatedAt: ago(5 * 60_000) }, now: at })).toEqual({ mood: 'idle', label: 'Idle' })
    expect(deriveCompanionStatus({ connected: true, runtime, session: { ...base, state: 'idle', updatedAt: ago(60 * 60_000) }, now: at }).mood).toBe('sleeping')
  })

  it('never puts an active, failing or approval-waiting blob to sleep', () => {
    const old = ago(60 * 60_000)
    expect(deriveCompanionStatus({ connected: true, runtime, session: { ...base, state: 'working', updatedAt: old }, now: at }).mood).toBe('working')
    expect(deriveCompanionStatus({ connected: true, runtime, session: { ...base, state: 'failed', updatedAt: old }, now: at }).mood).toBe('error')
    expect(deriveCompanionStatus({ connected: true, runtime, session: { ...base, state: 'waiting_permission', updatedAt: old }, now: at }).mood).toBe('permission')
  })
})
