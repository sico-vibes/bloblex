import { describe, expect, it } from 'vitest'
import { DEFAULT_EXPERIMENTS, EXPERIMENTS, filesUnderReply, shortcutRows, waitingBlobCount } from './experiments'
import type { Session, Snapshot } from '../types'

describe('experimental feature rules', () => {
  it('defaults usage recovery on and keeps unique setting keys', () => {
    const count = EXPERIMENTS.length
    expect(count).toBeGreaterThanOrEqual(11)
    expect(new Set(EXPERIMENTS.map((e) => e.name)).size).toBe(count)
    // Phase 1: these are on unless the owner turned them off; the rest stay opt-in.
    const on = ['autoRetry', 'autoTitles', 'changeReview', 'memory', 'messageActions', 'resumeAfterUsageLimits', 'search', 'undo']
    expect(Object.entries(DEFAULT_EXPERIMENTS).filter(([, value]) => value).map(([key]) => key).sort()).toEqual(on)
    expect(DEFAULT_EXPERIMENTS.resumeAfterUsageLimits).toBe(true)
  })
  it('attaches only a completed turn’s files under its last assistant reply', () => {
    const a = { id: 'a', role: 'assistant', turnId: 't' }
    const b = { id: 'b', role: 'assistant', turnId: 't' }
    const session: Session = { id: 's', runtimeId: 'r', state: 'idle', messages: [a, b], turns: [{ id: 't', state: 'completed' }], files: [{ id: 'f', turnId: 't' }, { id: 'other', turnId: 'other' }] }
    expect(filesUnderReply(session, a)).toEqual([])
    expect(filesUnderReply(session, b).map((f) => f.id)).toEqual(['f'])
    expect(filesUnderReply({ ...session, turns: [{ id: 't', state: 'working' }] }, b)).toEqual([])
    expect(filesUnderReply(session, { ...b, role: 'user' })).toEqual([])
  })
  it('counts waiting blobs once across questions and approvals and excludes archived blobs', () => {
    const snapshot = { agents: [{ id: 'a' }, { id: 'hidden', archived: true }], sessions: [{ id: 's', agentId: 'a', state: 'idle' }, { id: 'h', agentId: 'hidden', state: 'waiting_permission' }], permissions: [{ id: 'p', sessionId: 's', status: 'pending', kind: 'question' }, { id: 'p2', sessionId: 's', status: 'pending' }, { id: 'old', sessionId: 'h', status: 'pending' }] } as unknown as Snapshot
    expect(waitingBlobCount(snapshot, Date.now())).toBe(1)
    expect(waitingBlobCount({ ...snapshot, permissions: [] }, Date.now())).toBe(0)
    expect(waitingBlobCount(null, Date.now())).toBe(0)
  })
  it('shows dictation only when enabled and lists verified composer shortcuts', () => {
    expect(shortcutRows(false).flat()).not.toContain('Ctrl+E')
    expect(shortcutRows(true).flat()).toContain('Ctrl+E')
    for (const key of ['Ctrl+K / ⌘K', 'Ctrl+Alt+B', 'Enter', 'Shift+Enter', '@', '#', 'Esc']) expect(shortcutRows(false).flat()).toContain(key)
  })
})
