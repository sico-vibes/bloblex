import { describe, expect, it } from 'vitest'
import type { Agent, Project, Session } from '../types'
import { conversationPreview, groupAgentsByProject, leaderOf, mainSessionFor, mentionedAgents, mentionQuery, sideSessionsFor, splitMentions } from './teamSelectors'

const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({ id, name, description: '', instructions: '', color: 'mint', runtimeId: 'rt', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra })
const session = (id: string, extra: Partial<Session> = {}): Session => ({ id, runtimeId: 'rt', updatedAt: '2026-10-01T00:00:00Z', ...extra })

describe('team selectors', () => {
  it('keeps one main conversation per blob and lists side conversations for both sides', () => {
    const sessions = [
      session('old', { agentId: 'a', updatedAt: '2026-10-01T00:00:00Z' }),
      session('main', { agentId: 'a', updatedAt: '2026-10-02T00:00:00Z' }),
      session('archived', { agentId: 'a', updatedAt: '2026-10-03T00:00:00Z', archived: true }),
      session('side', { agentId: 'b', updatedAt: '2026-10-04T00:00:00Z', link: { kind: 'side', peerAgentId: 'a' } }),
    ]
    expect(mainSessionFor(sessions, 'a')?.id).toBe('main')
    expect(mainSessionFor(sessions, 'b')).toBeNull()
    expect(sideSessionsFor(sessions, 'a').map((item) => item.id)).toEqual(['side'])
    expect(sideSessionsFor(sessions, 'b').map((item) => item.id)).toEqual(['side'])
  })

  it('groups blobs by project in project order, keeps input order, and filters hidden blobs', () => {
    const projects: Project[] = [{ id: 'p2', name: 'Zeta', path: null, sortOrder: 1 }, { id: 'p1', name: 'Alpha', path: null, sortOrder: 0 }]
    const agents = [agent('a', 'Ann', { projectId: 'p2' }), agent('b', 'Bo', { projectId: 'p1', role: 'CTO' }), agent('c', 'Cy'), agent('d', 'Di', { hidden: true }), agent('e', 'Ed', { projectId: 'gone' }), agent('f', 'Fi', { archived: true })]
    expect(groupAgentsByProject(agents, projects).map((group) => [group.project?.name ?? 'Unassigned', group.agents.map((item) => item.name)])).toEqual([['Alpha', ['Bo']], ['Zeta', ['Ann']], ['Unassigned', ['Cy', 'Ed']]])
    expect(groupAgentsByProject(agents, projects, '', true).at(-1)?.agents.map((item) => item.name)).toEqual(['Cy', 'Di', 'Ed'])
    expect(groupAgentsByProject(agents, projects, 'cto').map((group) => group.project?.name)).toEqual(['Alpha'])
    expect(leaderOf([agent('x', 'X'), agent('y', 'Y', { leader: true })])?.id).toBe('y')
  })

  it('previews team activity in the sidebar', () => {
    expect(conversationPreview(session('s', { messages: [{ role: 'user', content: 'Hello **there**' }] }))).toBe('You: Hello there')
    expect(conversationPreview(session('s', { messages: [{ role: 'assistant', content: 'Done' }, { role: 'notice', content: 'x', meta: { kind: 'delegation', peerName: 'Codex' } }] }))).toBe('Messaged Codex')
    expect(conversationPreview(session('s', { messages: [{ role: 'user', content: '[Reply from Codex] ok', meta: { kind: 'blob_reply', fromName: 'Codex' } }] }))).toBe('Message from Codex')
    expect(conversationPreview(session('s', { messages: [{ role: 'thinking', content: 'hmm' }] }))).toBeNull()
  })

  it('finds the @mention being typed and the blobs a prompt mentions', () => {
    expect(mentionQuery('Ask @Po', 7)).toEqual({ start: 4, query: 'Po' })
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionQuery('mail@example', 12)).toBeNull()
    expect(mentionQuery('Ask Po', 6)).toBeNull()
    const team = [agent('a', 'Code'), agent('b', 'Codex'), agent('c', 'Claude Code')]
    expect(mentionedAgents('Ping @Codex and @Claude Code.', team).map((item) => item.name)).toEqual(['Claude Code', 'Codex'])
    expect(mentionedAgents('Ping @Codexy', team)).toEqual([])
  })

  it('splits a prompt into text and @mentions of the team, preferring the longest name', () => {
    const team = [agent('a', 'Code'), agent('b', 'Codex'), agent('c', 'Pololo')]
    const parts = splitMentions('Ask @codex and @Pololo, not mail@Codex or @Codexy.', team)
    expect(parts.map((part) => part.agent ? `[${part.agent.name}]` : part.text)).toEqual(['Ask ', '[Codex]', ' and ', '[Pololo]', ', not mail@Codex or @Codexy.'])
    expect(splitMentions('No mentions here', team)).toEqual([{ text: 'No mentions here' }])
  })
})
