// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { WorkingBotsPanel } from './WorkingBotsPanel'
import type { Agent, Session } from '../types'

vi.mock('../blob/BlobCanvas', () => ({ BlobCanvas: () => <span data-face="" /> }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('lists assigned work across bots, opens it and folds finished work', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const agents = [{ id: 'manager', name: 'Manager', color: 'violet' }, { id: 'worker', name: 'Researcher', color: 'blue' }] as Agent[]
  const make = (id: string, state: string, extra = {}): Session => ({ id, runtimeId: 'rt', agentId: 'worker', title: id, state, createdAt: new Date(Date.now() - 65_000).toISOString(), link: { kind: 'side', peerAgentId: 'manager' }, ...extra })
  const sessions = [make('Investigate', 'working'), make('Queued task', 'idle', { messages: [{ role: 'notice', meta: { kind: 'delegation', state: 'queued' } }] }), make('Limited task', 'limited'), make('Finished task', 'idle', { turns: [{ id: 't', state: 'completed' }] })]
  const open = vi.fn()
  try {
    await act(async () => root.render(<WorkingBotsPanel agents={agents} sessions={sessions} selectedId={null} onOpen={open} />))
    const panel = host.querySelector('[aria-label="Working bots"]')!
    expect(panel).not.toBeNull()
    expect(panel.textContent).toContain('Working')
    expect(panel.textContent).toContain('Waiting')
    expect(panel.textContent).toContain('Limited')
    expect(panel.textContent).toContain('1 finished')
    expect(panel.querySelector('[data-face]')).not.toBeNull()
    expect(panel.querySelector('time')?.textContent).toMatch(/^1m \d+s$/)
    await act(async () => panel.querySelector<HTMLButtonElement>('[data-task-id="Investigate"]')!.click())
    expect(open).toHaveBeenCalledWith('Investigate')
    expect(panel.querySelector('details')?.open).toBe(false)
    await act(async () => root.render(<WorkingBotsPanel agents={agents} sessions={sessions.map(s => s.id === 'Queued task' ? { ...s, state: 'working', messages: [{ role: 'user', content: 'Start now', meta: { kind: 'blob_message' } }] } : s)} selectedId={null} onOpen={open} />))
    expect(panel.querySelector('[data-task-id="Queued task"]')?.textContent).toContain('Working')
  } finally { act(() => root.unmount()); host.remove() }
})

it('keeps an unhydrated side session out until its finished turn arrives', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const agents = [{ id: 'worker', name: 'Researcher', color: 'blue' }] as Agent[]
  const at = Date.now()
  const created = new Date(at - 7_200_000).toISOString()
  const thin: Session = { id: 'old-task', runtimeId: 'rt', agentId: 'worker', title: 'Old task', state: 'idle', createdAt: created, link: { kind: 'side', peerAgentId: 'manager' } }
  const open = vi.fn()
  try {
    // A list row has no turns yet: it must not appear as an active task with a ticking clock.
    await act(async () => root.render(<WorkingBotsPanel agents={agents} sessions={[thin]} selectedId={null} onOpen={open} />))
    expect(host.querySelector('[aria-label="Working bots"]')).toBeNull()
    expect(host.querySelector('[data-task-id="old-task"]')).toBeNull()
    const hydrated: Session = { ...thin, messages: [], turns: [{ id: 't', state: 'completed', completedAt: new Date(at - 3_600_000).toISOString() }] }
    await act(async () => root.render(<WorkingBotsPanel agents={agents} sessions={[hydrated]} selectedId={null} onOpen={open} />))
    const panel = host.querySelector('[aria-label="Working bots"]')!
    expect(panel.textContent).toContain('1 finished')
    expect(panel.textContent).not.toContain('Waiting')
    expect(panel.querySelector('time')?.textContent).toBe('1h 0m')
  } finally { act(() => root.unmount()); host.remove() }
})
