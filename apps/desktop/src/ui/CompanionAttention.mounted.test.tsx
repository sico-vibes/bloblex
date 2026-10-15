// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Runtime, Session } from '../types'
import { NeedsYouBadge, PermissionQueueBar, nextWaitingAgent, waitingAgentsOf } from './CompanionAttention'

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { if (root) act(() => root?.unmount()); host?.remove(); root = null; host = null })
function mount(ui: React.ReactElement) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(ui))
  return host
}

const runtime = { id: 'rt', provider: 'codex', status: 'ready' } as unknown as Runtime
const agent = (id: string, name: string) => ({ id, name, runtimeId: 'rt', color: 'violet' }) as unknown as Agent
const waitingSession = (agentId: string) => ({ id: 's-' + agentId, agentId, runtimeId: 'rt', state: 'waiting_permission', updatedAt: '2026-10-15T10:00:00Z', messages: [] }) as unknown as Session
const idleSession = (agentId: string) => ({ id: 's-' + agentId, agentId, runtimeId: 'rt', state: 'idle', updatedAt: '2026-10-15T10:00:00Z', messages: [] }) as unknown as Session

describe('waiting agents', () => {
  const agents = [agent('a', 'Atlas'), agent('b', 'Pixel'), agent('c', 'Nova')]
  const sessions = [waitingSession('a'), idleSession('b'), waitingSession('c')]

  it('lists the bots that are waiting for the person, in roster order', () => {
    expect(waitingAgentsOf(agents, sessions, [runtime], true).map((item) => item.id)).toEqual(['a', 'c'])
    expect(waitingAgentsOf(agents, sessions, [runtime], false)).toEqual([])
  })

  it('picks the next waiting bot after the focused one and wraps', () => {
    const waiting = waitingAgentsOf(agents, sessions, [runtime], true)
    expect(nextWaitingAgent(waiting, 'a')?.id).toBe('c')
    expect(nextWaitingAgent(waiting, 'c')?.id).toBe('a')
    expect(nextWaitingAgent(waiting, 'b')?.id).toBe('a')
    expect(nextWaitingAgent([], 'a')).toBeNull()
  })
})

describe('NeedsYouBadge', () => {
  it('renders nothing at zero and a count otherwise, and opens the next one on click', () => {
    const open = vi.fn()
    const empty = mount(<NeedsYouBadge count={0} onOpen={open} />)
    expect(empty.querySelector('.needs-you')).toBeNull()
    act(() => root?.unmount()); host?.remove()
    const view = mount(<NeedsYouBadge count={2} onOpen={open} />)
    const button = view.querySelector<HTMLButtonElement>('.needs-you')!
    expect(button.textContent).toContain('2 need you')
    act(() => button.click())
    expect(open).toHaveBeenCalledOnce()
  })

  it('uses the singular form for one', () => {
    const view = mount(<NeedsYouBadge count={1} onOpen={vi.fn()} />)
    expect(view.textContent).toContain('1 needs you')
  })
})

describe('PermissionQueueBar', () => {
  it('shows the position and steps through the queue', () => {
    const prev = vi.fn(); const next = vi.fn(); const later = vi.fn()
    const view = mount(<PermissionQueueBar index={0} total={3} onPrev={prev} onNext={next} onLater={later} />)
    expect(view.querySelector('.queue-count')?.textContent).toBe('1 of 3')
    act(() => view.querySelector<HTMLButtonElement>('[aria-label="Next request"]')!.click())
    act(() => view.querySelector<HTMLButtonElement>('[aria-label="Previous request"]')!.click())
    act(() => view.querySelector<HTMLButtonElement>('.queue-later')!.click())
    expect(next).toHaveBeenCalledOnce(); expect(prev).toHaveBeenCalledOnce(); expect(later).toHaveBeenCalledOnce()
  })

  it('offers only Later when there is one request', () => {
    const view = mount(<PermissionQueueBar index={0} total={1} onPrev={vi.fn()} onNext={vi.fn()} onLater={vi.fn()} />)
    expect(view.querySelector('.queue-count')).toBeNull()
    expect(view.querySelector('.queue-later')).not.toBeNull()
  })
})
