import { describe, expect, it } from 'vitest'
import type { Agent, Session } from '../types'
import { activeAgents, duplicateAgentName, nextAgentAfterArchive, rosterGroups, rosterRows, scalarLength, sessionNewParams } from './rosterSelectors'

function agent(partial: Pick<Agent, 'id' | 'name' | 'runtimeId' | 'sortOrder'> & Partial<Agent>): Agent {
  return {
    description: '', instructions: '', color: 'mint', model: null, thinking: null, serviceTier: null,
    customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, archived: false,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...partial,
  }
}

const claude = agent({ id: 'agent-claude', name: 'Claude', runtimeId: 'runtime-claude', sortOrder: 0, color: '#f38c6f', createdAt: '2026-10-01T00:00:00.000Z' })
const codex = agent({ id: 'agent-codex', name: 'Codex', runtimeId: 'runtime-codex', sortOrder: 0, color: '#82aaff', createdAt: '2026-10-01T00:00:01.000Z' })
const invoice = agent({ id: 'agent-invoice', name: 'Invoice helper', runtimeId: 'runtime-codex', sortOrder: 1, color: 'lemon', createdAt: '2026-10-01T00:00:02.000Z' })
const opencode = agent({ id: 'agent-opencode', name: 'OpenCode', runtimeId: 'runtime-opencode', sortOrder: 0, color: 'violet', createdAt: '2026-10-01T00:00:03.000Z' })
const retired = agent({ id: 'agent-old', name: 'Retired', runtimeId: 'runtime-codex', sortOrder: 2, color: 'pink', archived: true })

function session(partial: Pick<Session, 'id' | 'runtimeId'> & Partial<Session>): Session {
  return { title: '', projectPath: 'C:/unrelated/parser-path', state: 'idle', updatedAt: '2026-10-02T00:00:00.000Z', ...partial }
}

describe('agent roster selectors', () => {
  const agents = [invoice, retired, opencode, claude, codex]

  it('orders active agents by runtime, then sort order, and hides archived rows', () => {
    expect(activeAgents(agents).map((item) => item.id)).toEqual(['agent-claude', 'agent-codex', 'agent-invoice', 'agent-opencode'])
  })

  it('matches names and session titles, ignores project paths, and drops empty groups', () => {
    const sessions = [
      session({ id: 'session-codex', runtimeId: 'runtime-codex', agentId: 'agent-codex', title: 'Invoice parser tests', projectPath: 'C:/work/korus', updatedAt: '2026-10-02T01:00:00.000Z' }),
      session({ id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Landing page copy', projectPath: 'C:/parser/should-not-match' }),
    ]
    expect(rosterRows(agents, sessions, 'claude').map((row) => row.agent.id)).toEqual(['agent-claude'])
    const titleHit = rosterRows(agents, sessions, 'parser')
    expect(titleHit.map((row) => row.agent.id)).toEqual(['agent-codex'])
    expect(titleHit[0]?.matchedTitle).toBe('Invoice parser tests')
    expect(rosterRows(agents, sessions, 'C:/parser').map((row) => row.agent.id)).toEqual([])
    expect(rosterGroups(titleHit).map((group) => group.runtimeId)).toEqual(['runtime-codex'])
    expect(rosterRows(agents, sessions, 'Claude')[0]?.matchedTitle).toBeNull()
  })

  it('builds copy names, truncates to 60 scalars, and counts emoji as one scalar', () => {
    expect(duplicateAgentName('Claude', [])).toBe('Copy of Claude')
    expect(duplicateAgentName('Claude', ['Copy of Claude'])).toBe('Copy of Claude (2)')
    const long = 'N'.repeat(60)
    const truncated = duplicateAgentName(long, [])
    expect(truncated).toBe(`Copy of ${'N'.repeat(52)}`)
    expect(scalarLength(truncated)).toBe(60)
    const withSuffix = duplicateAgentName(long, [truncated])
    expect(scalarLength(withSuffix)).toBe(60)
    expect(withSuffix.endsWith(' (2)')).toBe(true)
    expect(scalarLength('👋')).toBe(1)
  })

  it('picks the following active agent, wraps from the last, and yields null when none remain', () => {
    const order = activeAgents(agents)
    expect(nextAgentAfterArchive(order, 'agent-codex')?.id).toBe('agent-invoice')
    expect(nextAgentAfterArchive(order, 'agent-opencode')?.id).toBe('agent-claude')
    expect(nextAgentAfterArchive([claude], 'agent-claude')).toBeNull()
  })

  it('sends session.new with agentId and projectPath only', () => {
    expect(sessionNewParams('agent-claude', 'C:/work/site')).toEqual({ agentId: 'agent-claude', projectPath: 'C:/work/site' })
    expect(Object.keys(sessionNewParams('agent-claude', 'C:/work/site'))).toEqual(['agentId', 'projectPath'])
  })
})
