import { describe, expect, it } from 'vitest'
import type { Agent, Session } from '../types'
import { activeAgents, duplicateAgentName, garbageCollectExpanded, nextAgentAfterArchive, parseExpandedState, projectGroups, projectKey, recentProjects, rosterGroups, rosterRows, scalarLength, sessionDotClass, sessionNewParams, sessionSelectionTarget, treeModel } from './rosterSelectors'

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

describe('phase 4 project tree selectors', () => {
  const agents = [invoice, retired, opencode, claude, codex]

  it('groups normalised paths and orders projects and sessions by recency, not alphabetically', () => {
    const sessions = [
      session({ id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Landing page copy', projectPath: 'C:/work/site', updatedAt: '2026-10-02T01:00:00.000Z' }),
      session({ id: 'session-claude-2', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Hero follow-up', projectPath: 'c:\\work\\site\\', updatedAt: '2026-10-02T02:00:00.000Z' }),
      session({ id: 'session-claude-web', runtimeId: 'runtime-claude', agentId: 'agent-claude', title: 'Pricing page', projectPath: 'C:\\work\\web', updatedAt: '2026-10-01T00:00:00.000Z' }),
    ]
    const groups = projectGroups(sessions, 'agent-claude')
    expect(groups.map((group) => group.key)).toEqual(['c:\\work\\site', 'c:\\work\\web'])
    expect(groups[0]?.sessions.map((item) => item.id)).toEqual(['session-claude-2', 'session-claude'])
    expect(groups[0]?.path).toBe('c:\\work\\site\\')
    expect(groups[0]?.path).not.toBe('c:\\work\\site')
  })

  it('disambiguates colliding folder names with the next ancestor', () => {
    const sessions = [
      session({ id: 'session-invoice-a', runtimeId: 'runtime-codex', agentId: 'agent-invoice', title: 'North site', projectPath: 'C:\\client\\site', updatedAt: '2026-10-02T02:00:00.000Z' }),
      session({ id: 'session-invoice-b', runtimeId: 'runtime-codex', agentId: 'agent-invoice', title: 'South site', projectPath: 'D:\\other\\site', updatedAt: '2026-10-02T01:00:00.000Z' }),
    ]
    expect(projectGroups(sessions, 'agent-invoice').map((group) => group.label).sort()).toEqual(['site · client', 'site · other'])
  })

  it('keeps walking ancestors until a three-way site collision is unique', () => {
    const sessions = [
      session({ id: 'a', runtimeId: 'runtime-claude', agentId: 'agent-claude', projectPath: 'C:\\client\\work\\site', updatedAt: '2026-10-02T03:00:00.000Z' }),
      session({ id: 'b', runtimeId: 'runtime-claude', agentId: 'agent-claude', projectPath: 'D:\\client\\work\\site', updatedAt: '2026-10-02T02:00:00.000Z' }),
      session({ id: 'c', runtimeId: 'runtime-claude', agentId: 'agent-claude', projectPath: 'E:\\other\\work\\site', updatedAt: '2026-10-02T01:00:00.000Z' }),
    ]
    expect(projectGroups(sessions, 'agent-claude').map((group) => group.label)).toEqual([
      'site · work · client · C:',
      'site · work · client · D:',
      'site · work · other',
    ])
  })

  it('normalises separators without resolving dot segments or stripping the \\\\?\\ prefix', () => {
    const same = ['C:/work/site', 'c:\\work\\site\\', 'C:\\work\\site', 'c:/work//site']
    expect(new Set(same.map((path) => projectKey(path))).size).toBe(1)
    expect(projectKey('C:/work/site')).toBe('c:\\work\\site')
    expect(projectKey('C:\\work\\site\\..\\site')).toBe('c:\\work\\site\\..\\site')
    expect(projectKey('C:\\work\\site\\.')).toBe('c:\\work\\site\\.')
    expect(projectKey('\\\\?\\C:\\work\\site')).toBe('\\\\?\\c:\\work\\site')
    expect(projectKey('C:\\')).toBe('c:\\')
    expect(projectKey('C:')).toBe('c:')
    expect(projectKey('C:\\')).not.toBe(projectKey('C:'))
    expect(projectKey('//server/share/site')).toBe('\\\\server\\share\\site')
    expect(projectKey('\\\\server\\share\\site')).toBe('\\\\server\\share\\site')
    expect(projectKey('   ')).toBeNull()
    expect(projectKey(null)).toBeNull()
  })

  it('parses only v1 expansion and garbage-collects archived ids without dropping an open blob', () => {
    const raw = JSON.stringify({ v: 1, blobs: { 'agent-claude': { open: true, projects: { 'c:\\work\\site': true, ignored: 'no' }, other: false } } })
    expect(parseExpandedState(raw).blobs['agent-claude']?.open).toBe(true)
    expect(parseExpandedState('{"v":2,"blobs":{"agent-claude":{"open":true}}}').blobs).toEqual({})
    expect(parseExpandedState('{')).toEqual({ v: 1, blobs: {} })
    const state = {
      v: 1 as const,
      blobs: {
        'agent-old': { open: true, projects: {}, other: false },
        'agent-claude': { open: true, projects: { 'c:\\gone': true, 'c:\\work\\site': false }, other: true },
      },
    }
    const live = [session({ id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', projectPath: 'C:/work/site' })]
    const collected = garbageCollectExpanded(state, agents, live)
    expect(collected.blobs['agent-old']).toBeUndefined()
    expect(collected.blobs['agent-claude']?.projects['c:\\gone']).toBeUndefined()
    expect(collected.blobs['agent-claude']?.projects['c:\\work\\site']).toBe(false)
    const emptied = garbageCollectExpanded({ v: 1, blobs: { 'agent-claude': { open: true, projects: { 'c:\\gone': true }, other: false } } }, agents, live)
    expect(emptied.blobs['agent-claude']).toEqual({ open: true, projects: {}, other: false })
  })

  it('pins the trimmed default project inside the limit and keeps the stored path', () => {
    const sessions = [
      session({ id: 'session-claude-2', runtimeId: 'runtime-claude', agentId: 'agent-claude', projectPath: 'c:\\work\\site\\', updatedAt: '2026-10-02T03:00:00.000Z' }),
      session({ id: 'session-claude', runtimeId: 'runtime-claude', agentId: 'agent-claude', projectPath: 'C:/work/site', updatedAt: '2026-10-02T02:00:00.000Z' }),
    ]
    const pinned = recentProjects(sessions, { id: 'agent-claude', defaultProject: '  C:/work/site  ' }, 8)
    expect(pinned).toHaveLength(1)
    expect(pinned[0]?.path).toBe('c:\\work\\site\\')
    expect(pinned[0]?.label.endsWith(' · Default')).toBe(true)
    const many = Array.from({ length: 8 }, (_, index) => session({
      id: `p-${index}`, runtimeId: 'runtime-claude', agentId: 'agent-claude', projectPath: `C:\\work\\p${index}`, updatedAt: `2026-10-0${index === 0 ? 1 : 2}T0${index}:00:00.000Z`,
    }))
    const limited = recentProjects(many, { id: 'agent-claude', defaultProject: 'D:\\fresh\\default' }, 8)
    expect(limited).toHaveLength(8)
    expect(limited[0]?.path).toBe('D:\\fresh\\default')
    expect(limited.map((row) => row.path)).not.toContain('C:\\work\\p0')
  })

  it('maps failed and both canceled spellings away from the busy and good dots', () => {
    expect(sessionDotClass('working')).toBe('busy')
    expect(sessionDotClass('idle')).toBe('muted')
    expect(sessionDotClass('error')).toBe('bad')
    expect(sessionDotClass('completed')).toBe('good')
    expect(sessionDotClass('failed')).toBe('bad')
    expect(sessionDotClass('canceled')).toBe('muted')
    expect(sessionDotClass('cancelled')).toBe('muted')
  })

  it('puts a legacy title hit only on the host and never matches a project path', () => {
    const sessions = [
      session({ id: 'session-codex', runtimeId: 'runtime-codex', agentId: 'agent-codex', title: 'Invoice parser tests', projectPath: 'C:/work/korus', updatedAt: '2026-10-02T03:00:00.000Z' }),
      session({ id: 'session-legacy', runtimeId: 'runtime-codex', agentId: null, title: 'Untied notes', projectPath: 'C:/work/notes' }),
      session({ id: 'session-invoice-a', runtimeId: 'runtime-codex', agentId: 'agent-invoice', title: 'North site', projectPath: 'C:\\client\\site' }),
    ]
    const untied = treeModel(agents, sessions, 'untied')
    expect(untied.groups.flatMap((group) => group.rows).map((row) => row.agent.id)).toEqual(['agent-codex'])
    expect(untied.groups[0]?.rows[0]?.forceOpen.other).toBe(true)
    const open = treeModel(agents, sessions, '')
    const codexRow = open.groups.flatMap((group) => group.rows).find((row) => row.agent.id === 'agent-codex')
    const invoiceRow = open.groups.flatMap((group) => group.rows).find((row) => row.agent.id === 'agent-invoice')
    expect(codexRow?.other?.map((item) => item.title)).toEqual(['Untied notes'])
    expect(invoiceRow?.other).toBeNull()
    const archived = agents.map((item) => item.id === 'agent-codex' ? { ...item, archived: true } : item)
    const moved = treeModel(archived, sessions, '')
    expect(moved.groups.flatMap((group) => group.rows).find((row) => row.agent.id === 'agent-invoice')?.other?.map((item) => item.title)).toEqual(['Untied notes'])
    expect(treeModel(agents, sessions, 'C:/work/korus').groups).toEqual([])
    const parser = treeModel(agents, sessions, 'parser')
    expect(parser.groups[0]?.rows[0]?.agent.id).toBe('agent-codex')
    expect(parser.groups[0]?.rows[0]?.forceOpen.blob).toBe(true)
    expect(parser.groups[0]?.rows[0]?.forceOpen.projects['c:\\work\\korus']).toBe(true)
    expect(treeModel(agents, sessions, 'Invoice').groups.flatMap((group) => group.rows).find((row) => row.agent.id === 'agent-invoice')?.forceOpen.blob).toBe(false)
  })

  it('returns null when a legacy session has no active agent on its runtime', () => {
    const ghost = session({ id: 'ghost', runtimeId: 'runtime-ghost', agentId: null, title: 'Nowhere' })
    expect(sessionSelectionTarget(agents, claude, ghost)).toBeNull()
    expect(sessionSelectionTarget(agents, claude, session({ id: 'blank', runtimeId: 'runtime-claude', agentId: '', title: 'Blank' }))).toBeNull()
  })
})
