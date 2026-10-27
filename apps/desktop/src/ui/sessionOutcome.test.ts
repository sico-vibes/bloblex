import { describe, expect, it } from 'vitest'
import type { Session } from '../types'
import { applyEvent, type Snapshot } from '../types'
import { deriveCompanionStatus } from './companionStatus'
import { presentedSessionState } from './sessionOutcome'
import { taskStatus } from './WorkingBotsPanel'

const runtime = { id: 'rt', provider: 'codex', status: 'online' }
const session = (extra: Partial<Session>): Session => ({ id: 's1', runtimeId: 'rt', ...extra })
const failedTool = { id: 'tool-1', turnId: 't1', state: 'failed', kind: 'command', title: 'npm test' }

describe('a recovered failure does not make a finished conversation Failed', () => {
  it('shows a stale error state as completed once the newest turn completed, and keeps the failed tool in the history', () => {
    const recovered = session({ state: 'error', tools: [failedTool], turns: [{ id: 't0', state: 'error' }, { id: 't1', state: 'completed' }] })
    expect(presentedSessionState(recovered)).toBe('completed')
    expect(recovered.tools).toHaveLength(1)
    expect(deriveCompanionStatus({ connected: true, runtime, session: recovered }).mood).not.toBe('error')
    expect(deriveCompanionStatus({ connected: true, runtime, session: recovered }).label).toBe('Done')
    expect(taskStatus(recovered)).toBe('Done')
  })

  it('keeps a genuine terminal error as Failed', () => {
    const failed = session({ state: 'error', turns: [{ id: 't1', state: 'completed' }, { id: 't2', state: 'error' }] })
    expect(presentedSessionState(failed)).toBe('error')
    expect(deriveCompanionStatus({ connected: true, runtime, session: failed })).toEqual({ mood: 'error', label: 'Needs attention' })
    expect(taskStatus(failed)).toBe('Failed')
    // A list row with no turns recorded cannot be judged, so the daemon's state stands.
    expect(presentedSessionState(session({ state: 'error' }))).toBe('error')
    expect(presentedSessionState(session({ state: 'error', turns: [] }))).toBe('error')
  })

  it('leaves every other state alone', () => {
    for (const state of ['working', 'completed', 'cancelled', 'limited', 'waiting_permission']) expect(presentedSessionState(session({ state, turns: [{ id: 't', state: 'completed' }] }))).toBe(state)
    expect(presentedSessionState(null)).toBeUndefined()
  })

  it('follows a live turn that errors and then completes, and the same session after a reload', () => {
    const live: Snapshot = { sequence: 1, runtimes: [{ id: 'rt', provider: 'codex' }], sessions: [session({ state: 'working', turns: [{ id: 't1', state: 'working' }], tools: [failedTool] })], permissions: [], usage: [] }
    const errored = applyEvent(live, { v: 1, type: 'turn.error', sequence: 2, payload: { sessionId: 's1', turnId: 't1', failureClass: 'tool' } })
    expect(deriveCompanionStatus({ connected: true, runtime, session: errored.sessions![0] }).mood).toBe('error')
    const completed = applyEvent(errored, { v: 1, type: 'turn.completed', sequence: 3, payload: { sessionId: 's1', turnId: 't1', state: 'completed' } })
    const after = completed.sessions![0]
    expect(after.state).toBe('completed')
    expect(after.turns?.[0]).toMatchObject({ id: 't1', state: 'completed' })
    expect(after.turns?.[0].recoveryHandled).toBeUndefined()
    expect(after.tools).toEqual([failedTool])
    expect(taskStatus(after)).toBe('Done')
    // The reload (a snapshot from the daemon) can still carry the old session state; the completed turn wins.
    const reloaded = session({ state: 'error', turns: [{ id: 't1', state: 'completed' }], tools: [failedTool] })
    expect(deriveCompanionStatus({ connected: true, runtime, session: reloaded }).label).toBe('Done')
  })

  it('keeps an error that arrives for a newer turn', () => {
    const live: Snapshot = { sequence: 1, runtimes: [{ id: 'rt', provider: 'codex' }], sessions: [session({ state: 'completed', turns: [{ id: 't1', state: 'completed' }, { id: 't2', state: 'working' }] })], permissions: [], usage: [] }
    const next = applyEvent(live, { v: 1, type: 'turn.error', sequence: 2, payload: { sessionId: 's1', turnId: 't2' } })
    expect(presentedSessionState(next.sessions![0])).toBe('error')
  })
})
