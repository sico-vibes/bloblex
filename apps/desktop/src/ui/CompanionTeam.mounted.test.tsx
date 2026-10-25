// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Project, Runtime, Session } from '../types'
import { CompanionChatItem, CompanionTeamPicker, CompanionTeammatesSetting, pickPeers } from './CompanionTeam'

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
  it('keeps up to four teammates in sight, pinned first', () => {
    const many = [lead, mate, casual, agent('d', 'Dot'), agent('e', 'Eve'), agent('f', 'Fox')]
    expect(pickPeers(many, sessions, runtimes, true, 'lead', []).map((item) => item.name)).toEqual(['Mate', 'Casual', 'Dot', 'Eve'])
    expect(pickPeers(many, sessions, runtimes, true, 'lead', ['f']).map((item) => item.name)[0]).toBe('Fox')
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

  it('renders a context reset as a labelled divider and marks lost context', () => {
    const host = mount(<>
      <CompanionChatItem message={{ role: 'notice', content: 'Conversation compacted.', meta: { kind: 'context_reset', reason: 'compaction', contextLost: false } }} agents={[lead, mate]} onOpenSide={vi.fn()} />
      <CompanionChatItem message={{ role: 'notice', content: 'Started a fresh session.', meta: { kind: 'context_reset', reason: 'fresh_session', contextLost: true } }} agents={[lead, mate]} onOpenSide={vi.fn()} />
    </>)
    const dividers = [...host.querySelectorAll('[role="separator"]')]
    expect(dividers.map((node) => node.getAttribute('aria-label'))).toEqual(['Conversation compacted.', 'Started a fresh session.'])
    expect(dividers.map((node) => node.classList.contains('lost'))).toEqual([false, true])
    expect(host.querySelector('.companion-team-chip')).toBeNull()
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

  it('frames an assistant reply in the same bubble class the main chat uses', () => {
    const host = mount(<CompanionChatItem message={{ role: 'assistant', content: 'Done, **all** green.' }} agents={[lead]} onOpenSide={vi.fn()} />)
    const reply = host.querySelector('.reply')!
    expect(reply.classList.contains('message-bubble')).toBe(true)
    expect(reply.textContent).toBe('Done, all green.')
  })
})

describe('companion settings: teammates on the island', () => {
  const many = [lead, mate, casual, agent('d', 'Dot', { role: 'QA' }), agent('e', 'Eve'), agent('f', 'Fox')]
  const radio = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((item) => item.textContent === name)!
  const chips = (host: HTMLElement) => [...host.querySelectorAll('.cset-chip')].map((item) => item.textContent)
  const checks = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('.cset-check')]

  function setup(pinned: string[], extra: Partial<React.ComponentProps<typeof CompanionTeammatesSetting>> = {}) {
    const onPinnedChange = vi.fn()
    const host = mount(<CompanionTeammatesSetting agents={many} sessions={sessions} runtimes={runtimes} connected focusedId="lead" pinned={pinned} onPinnedChange={onPinnedChange} {...extra} />)
    return { host, onPinnedChange }
  }

  it('shows who the island picks as chips and offers no checklist while it picks for you', () => {
    const { host } = setup([])
    expect(radio(host, 'Picked for you').getAttribute('aria-checked')).toBe('true')
    expect(radio(host, 'Choose myself').getAttribute('aria-checked')).toBe('false')
    expect(chips(host)).toEqual(['Mate', 'Casual', 'Dot', 'Eve'])
    expect(host.querySelector('.cset-checklist')).toBeNull()
  })

  it('switches to choosing from what is shown now, and back to automatic with an empty list', () => {
    const { host, onPinnedChange } = setup([])
    act(() => radio(host, 'Choose myself').click())
    expect(onPinnedChange).toHaveBeenLastCalledWith(['mate', 'casual', 'd', 'e'])
    // Still the same list until the parent re-renders with the saved value; choosing is already on.
    expect(radio(host, 'Choose myself').getAttribute('aria-checked')).toBe('true')
    expect(host.querySelector('.cset-checklist')).not.toBeNull()
    act(() => radio(host, 'Picked for you').click())
    expect(onPinnedChange).toHaveBeenLastCalledWith([])
    expect(radio(host, 'Picked for you').getAttribute('aria-checked')).toBe('true')
  })

  it('shows the pinned teammates, checks them, and toggles one without leaving the panel', () => {
    const { host, onPinnedChange } = setup(['fox-missing', 'f', 'mate'])
    expect(radio(host, 'Choose myself').getAttribute('aria-checked')).toBe('true')
    expect(chips(host)).toEqual(['Fox', 'Mate'])
    const boxes = checks(host)
    // Every teammate except the focused blob, in the picker's order.
    expect(boxes.map((box) => box.querySelector('.cset-check-name')?.firstChild?.textContent)).toEqual(['Mate', 'Casual', 'Dot', 'Eve', 'Fox'])
    expect(boxes.map((box) => box.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false', 'true'])
    act(() => boxes[1].click())
    expect(onPinnedChange).toHaveBeenLastCalledWith(['fox-missing', 'f', 'mate', 'casual'])
    act(() => boxes[4].click())
    expect(onPinnedChange).toHaveBeenLastCalledWith(['fox-missing', 'mate'])
  })

  it('stops at the island maximum and explains the disabled rows', () => {
    const { host, onPinnedChange } = setup(['mate', 'casual', 'd', 'e'])
    expect(host.textContent).toContain('4 of 4')
    const unchecked = checks(host).filter((box) => box.getAttribute('aria-checked') === 'false')
    expect(unchecked).toHaveLength(1)
    expect(unchecked[0].disabled).toBe(true)
    expect(unchecked[0].getAttribute('title')).toBe('Up to 4 on the island')
    act(() => unchecked[0].click())
    expect(onPinnedChange).not.toHaveBeenCalled()
    // A pinned row can always be turned off, which frees a slot.
    act(() => checks(host)[0].click())
    expect(onPinnedChange).toHaveBeenLastCalledWith(['casual', 'd', 'e'])
  })

  it('leaves out archived and hidden blobs and says when there is nobody else', () => {
    const { host } = setup([], { agents: [lead, agent('gone', 'Gone', { archived: true }), agent('quiet', 'Quiet', { hidden: true })] })
    expect(host.querySelector('.cset-chips')).toBeNull()
    expect(host.textContent).toContain('No other bots yet.')
    act(() => radio(host, 'Choose myself').click())
    expect(host.querySelector('.cset-checklist')).toBeNull()
  })
})
