import { describe, expect, it } from 'vitest'
import { buildDelegationRows, normalizeDelegation, type DelegationNotice, type DelegationRecord } from './delegations'

const notice: DelegationNotice = { id: 'n1', delegationId: 'd1', originTurnId: 't1', peerAgentId: 'a1', peerName: 'Codex', topic: 'Check the build', sideSessionId: 's1', failed: false, text: 'Check the build', createdAt: null }
const record = (extra: Partial<DelegationRecord>): DelegationRecord => ({
  id: 'd1', originSessionId: 'm1', originTurnId: 't1', sideSessionId: 's1', sideTurnId: null, fromAgentId: 'boss', targetAgentId: 'a1', topic: 'Check the build',
  briefPreview: '', status: 'completed', error: null, workspacePath: null, worktree: null, createdAt: null, startedAt: null, finishedAt: null, updatedAt: null, queueReason: null, ...extra,
})
const rows = (extra: Partial<DelegationRecord>) => buildDelegationRows([notice], new Map([['d1', record(extra)]]), [], [], new Set(), new Map(), Date.now())

describe('assignment rows', () => {
  // A teammate that replied `(pass)` finished with nothing to report (wave 12).
  it('says a quietly finished assignment had nothing to report', () => {
    expect(rows({ silent: true })[0]!.label).toBe('Done, nothing to report')
    expect(rows({})[0]!.label).toBe('Done')
  })

  // Wave 13: a working assignment says what its teammate is doing right now.
  it('shows what a working teammate is doing', () => {
    const side = { id: 's1', runtimeId: 'rt', state: 'working', tools: [{ id: 't1', kind: 'execute', title: 'Bash', state: 'running', detail: { label: 'Ran npm test' } }] }
    const working = buildDelegationRows([notice], new Map([['d1', record({ status: 'running' })]]), [side], [], new Set(), new Map(), Date.now())
    expect(working[0]!.label).toBe('Running npm test')
    const idle = buildDelegationRows([notice], new Map([['d1', record({ status: 'running' })]]), [{ ...side, tools: [] }], [], new Set(), new Map(), Date.now())
    expect(idle[0]!.label).toBe('Working')
  })
})

describe('daemon records', () => {
  // The quiet flag and the goal must survive the trip from the daemon (wave 12 shipped without them).
  it('keeps the quiet flag and the done goal', () => {
    const raw = { id: 'd1', originSessionId: 'm1', sideSessionId: 's1', status: 'completed', silent: true, doneGoal: 'Tests pass', workspace: { path: 'C:/work/site', worktree: null } }
    expect(normalizeDelegation(raw)).toMatchObject({ silent: true, doneGoal: 'Tests pass', workspacePath: 'C:/work/site' })
    expect(normalizeDelegation({ ...raw, silent: 'yes', doneGoal: 4 })).toMatchObject({ silent: false, doneGoal: null })
  })
})
