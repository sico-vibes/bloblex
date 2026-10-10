// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Project, Runtime, Session } from '../types'
import { CompanionChatItem, CompanionPeers, CompanionTeamPicker, pickPeers, teamLine } from './CompanionTeam'

vi.mock('../blob/BlobCanvas', () => ({ BlobCanvas: ({ label }: { label?: string }) => <span data-face={label} /> }))

const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({ id, name, description: '', instructions: '', color: 'mint', runtimeId: 'rt', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: 't', updatedAt: 't', ...extra })
const runtimes: Runtime[] = [{ id: 'rt', provider: 'codex', status: 'online' } as Runtime]
const projects: Project[] = [{ id: 'p', name: 'Board', path: null, sortOrder: 0 }]
const lead = agent('lead', 'Lead', { projectId: 'p', leader: true, role: 'CTO' })
const mate = agent('mate', 'Mate', { projectId: 'p' })
const casual = agent('casual', 'Casual')
const sessions: Session[] = [
  { id: 'main-lead', runtimeId: 'rt', agentId: 'lead', state: 'idle', updatedAt: '2026-10-01' },
  { id: 'main-mate', runtimeId: 'rt', agentId: 'mate', state: 'waiting_permission', updatedAt: '2026-10-01' },
  { id: 'side', runtimeId: 'rt', agentId: 'mate', state: 'working', updatedAt: '2026-10-02', link: { kind: 'side', peerAgentId: 'lead', peerName: 'Lead', originSessionId: 'main-lead' } },
]

const mounted: Array<{ root: Root; host: HTMLDivElement }> = []
function mount(node: React.ReactNode) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(node))
  mounted.push({ root, host })
  return host
}
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(() => { for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() } vi.unstubAllGlobals() })

describe('companion team overview', () => {
  it('keeps up to four teammates in sight, pinned first, each with the line it is working on', () => {
    const many = [lead, mate, casual, agent('d', 'Dot'), agent('e', 'Eve'), agent('f', 'Fox')]
    expect(pickPeers(many, sessions, runtimes, true, 'lead', []).map((item) => item.name)).toEqual(['Mate', 'Casual', 'Dot', 'Eve'])
    expect(pickPeers(many, sessions, runtimes, true, 'lead', ['f']).map((item) => item.name)[0]).toBe('Fox')
    const onSelect = vi.fn()
    const host = mount(<CompanionPeers agents={many} projects={projects} sessions={sessions} runtimes={runtimes} connected focusedId="lead" pinned={[]} onSelect={onSelect} onPinnedChange={vi.fn()} />)
    const peers = [...host.querySelectorAll<HTMLButtonElement>('.peer')]
    expect(peers).toHaveLength(4)
    expect(peers[0].getAttribute('aria-label')).toBe('Mate: Waiting for you')
    act(() => peers[0].click())
    expect(onSelect).toHaveBeenCalledWith(mate)
    expect(host.querySelector('.peers-all')?.getAttribute('aria-label')).toBe('All blobs (5)')
  })

  it('lists every blob by project and pins up to four to the island', () => {
    const onPinnedChange = vi.fn()
    const host = mount(<CompanionTeamPicker agents={[lead, mate, casual]} projects={projects} sessions={sessions} runtimes={runtimes} connected focusedId="lead" pinned={['mate']} onSelect={vi.fn()} onPinnedChange={onPinnedChange} onClose={vi.fn()} />)
    expect([...host.querySelectorAll('.team-picker-label')].map((label) => label.textContent)).toEqual(['Board', 'Casual'])
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Keep Casual on the island"]')!.click())
    expect(onPinnedChange).toHaveBeenCalledWith(['mate', 'casual'])
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Unpin Mate from the island"]')!.click())
    expect(onPinnedChange).toHaveBeenLastCalledWith([])
  })

  it('says who the focused blob is waiting on or helping', () => {
    expect(teamLine(lead, [lead, mate], sessions)).toEqual({ text: 'Waiting on Mate', peer: mate, sessionId: 'side' })
    expect(teamLine(mate, [lead, mate], sessions)?.text).toBe('Helping Lead')
    expect(teamLine(casual, [lead, mate, casual], sessions)).toBeNull()
  })

  it('renders delegation chips, mentions and plans in the companion chat', () => {
    const open = vi.fn()
    const host = mount(<>
      <CompanionChatItem message={{ role: 'user', content: 'Ask @Mate please' }} agents={[lead, mate]} onOpenSide={open} />
      <CompanionChatItem message={{ role: 'notice', content: 'brief', meta: { kind: 'delegation', peerAgentId: 'mate', peerName: 'Mate', sideSessionId: 'side' } }} agents={[lead, mate]} onOpenSide={open} />
      <CompanionChatItem message={{ role: 'plan', content: '1. Do **this**' }} agents={[lead, mate]} onOpenSide={open} />
      <CompanionChatItem message={{ role: 'thinking', content: 'hmm' }} agents={[lead, mate]} onOpenSide={open} />
    </>)
    expect(host.querySelector('.companion-mention')?.textContent).toBe('Mate')
    expect(host.querySelector('.companion-plan')?.textContent).toBe('Proposed plan 1. Do this')
    act(() => host.querySelector<HTMLButtonElement>('.companion-team-chip')!.click())
    expect(open).toHaveBeenCalledWith('side')
    expect(host.textContent).not.toContain('hmm')
  })
})
