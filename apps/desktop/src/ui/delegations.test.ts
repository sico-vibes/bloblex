import { describe, expect, it } from 'vitest'
import { buildDelegationRows, type DelegationNotice, type DelegationRecord } from './delegations'

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
})
