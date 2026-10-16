import { describe, expect, it } from 'vitest'
import type { Agent, Project, Session } from '../types'
import { ancestorIds, conversationPlaceName, conversationPreview, conversationTree, groupAgentsByProject, leaderOf, mainSessionFor, mentionedAgents, mentionQuery, hashQuery, sideSessionsFor, splitMentions, splitReferences } from './teamSelectors'

const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({ id, name, description: '', instructions: '', color: 'mint', runtimeId: 'rt', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra })
const session = (id: string, extra: Partial<Session> = {}): Session => ({ id, runtimeId: 'rt', updatedAt: '2026-10-01T00:00:00Z', ...extra })

describe('team selectors', () => {
  it('finds the #conversation being typed and splits sent references back out', () => {
    expect(hashQuery('Ask Fluffy about #Model', 23)).toEqual({ start: 17, query: 'Model' })
    expect(hashQuery('#', 1)).toEqual({ start: 0, query: '' })
    expect(hashQuery('issue#4', 7)).toBeNull()
    const refs = [{ id: 'c1', title: 'Model check' }, { id: 'c2', title: 'Model' }]
    expect(splitReferences('See #Model check and #Model, not #other', refs)).toEqual([
      { text: 'See ' }, { text: '#Model check', reference: refs[0] }, { text: ' and ' }, { text: '#Model', reference: refs[1] }, { text: ', not #other' },
    ])
    expect(splitReferences('plain', null)).toEqual([{ text: 'plain' }])
  })

  it('never treats a scheduled run as the main conversation of a blob', () => {
    const sessions = [
      session('main', { agentId: 'a', updatedAt: '2026-10-01T00:00:00Z' }),
      session('run', { agentId: 'a', updatedAt: '2026-10-05T00:00:00Z', link: { kind: 'automation', automationId: 'x', runId: 'r' } }),
    ]
    expect(mainSessionFor(sessions, 'a')?.id).toBe('main')
    expect(mainSessionFor([sessions[1]], 'a')).toBeNull()
  })

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

describe('conversationPlaceName', () => {
  const projects: Project[] = [{ id: 'p1', name: 'crewspan', path: null, sortOrder: 0 }]
  it('names the project, never the per-bot workspace id', () => {
    const veve = agent('a1', 'Veve', { projectId: 'p1' })
    const casual = agent('a2', 'Dodo')
    const workspace = String.raw`C:\Users\me\AppData\Local\Bitbots\workspaces\4cb94b29-dcd1-4196-b7f8-f717274b892f`
    expect(conversationPlaceName(session('s1', { agentId: 'a1', projectPath: workspace }), [veve], projects)).toBe('crewspan')
    expect(conversationPlaceName(session('s2', { agentId: 'a2', projectPath: workspace }), [casual], projects)).toBeNull()
    expect(conversationPlaceName(session('s3', { agentId: 'a2', projectPath: String.raw`D:\code\bloblex` }), [casual], projects)).toBe('bloblex')
    expect(conversationPlaceName(session('s4', { agentId: 'a2', workspaceLabel: 'Casual' }), [casual], projects)).toBe('Casual')
    expect(conversationPlaceName(null, [], projects)).toBeNull()
  })
})

describe('conversationTree', () => {
  const sessions: Session[] = [
    session('main-1', { agentId: 'a', title: 'Fix login', updatedAt: '2026-10-16T10:00:00Z' }),
    session('main-2', { agentId: 'a', title: 'Docs', updatedAt: '2026-10-16T12:00:00Z' }),
    // a asked b, started from main-1; the reply route moved, the spawn link did not.
    session('side-asked', { agentId: 'b', link: { kind: 'side', peerAgentId: 'a', spawnedFromSessionId: 'main-1', originSessionId: 'main-2' }, updatedAt: '2026-10-16T11:00:00Z' }),
    // b asked a from b's own conversation, which is not in a's list: a root.
    session('side-received', { agentId: 'a', link: { kind: 'side', peerAgentId: 'b', originSessionId: 'b-main' }, updatedAt: '2026-10-16T09:00:00Z' }),
    session('auto', { agentId: 'a', link: { kind: 'automation' } }),
    session('old', { agentId: 'a', archived: true }),
    session('elsewhere', { agentId: 'a', projectId: 'p2' }),
  ]
  it('nests bot-to-bot conversations under the one that started them', () => {
    const tree = conversationTree(sessions, 'a', 'p1')
    expect(tree.map((node) => node.session.id)).toEqual(['main-2', 'main-1', 'side-received'])
    const main1 = tree.find((node) => node.session.id === 'main-1')!
    expect(main1.children.map((node) => [node.session.id, node.kind, node.role])).toEqual([['side-asked', 'side', 'sender']])
    expect(tree.find((node) => node.session.id === 'side-received')?.role).toBe('receiver')
    expect(ancestorIds(tree, 'side-asked')).toEqual(['main-1'])
  })
})
