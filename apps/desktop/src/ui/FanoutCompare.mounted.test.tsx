// @vitest-environment happy-dom
// Phase 1B: one prompt to several bots, and the answers side by side.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Project, Runtime } from '../types'

const h = vi.hoisted(() => ({ rpc: vi.fn(), listener: null as null | ((event: { type: string; payload?: unknown }) => void) }))
vi.mock('../tauri', () => ({ rpc: h.rpc, listenForDaemonEvents: async (listener: (event: { type: string; payload?: unknown }) => void) => { h.listener = listener; return () => undefined } }))
vi.mock('../blob/BlobCanvas', () => ({ BlobCanvas: ({ label }: { label?: string }) => <span data-face={label} /> }))

import { CompanionFanoutSummary, CompareView, durationLabel, FanoutDialog, fanoutRowState, normalizeFanout } from './FanoutCompare'

const agent = (id: string, name: string, runtimeId = 'rt'): Agent => ({ id, name, description: '', instructions: '', color: 'mint', runtimeId, model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: 't', updatedAt: 't' })
const bots = [agent('a1', 'Alpha'), agent('a2', 'Beta'), agent('a3', 'Gamma'), agent('a4', 'Offline', 'gone')]
const runtimes = [{ id: 'rt', provider: 'codex', status: 'online' }] as Runtime[]
const projects: Project[] = [{ id: 'p1', name: 'Korus', path: 'D:/korus', sortOrder: 0 }, { id: 'p2', name: 'No folder', path: null, sortOrder: 1 }]
const row = (agentId: string, agentName: string, extra: Record<string, unknown> = {}) => ({ agentId, agentName, sessionId: `s-${agentId}`, state: 'idle', reply: `${agentName} says hi`, error: null, durationMs: 65_000, tokens: null, worktree: null, ...extra })
const record = (extra: Record<string, unknown> = {}) => ({ id: 'f1', title: 'Compare this', text: 'What should we do?', projectId: 'p1', projectName: 'Korus', createdAt: '2026-10-30T10:00:00.000Z', chosenSessionId: null, rows: [row('a1', 'Alpha'), row('a2', 'Beta')], ...extra })

let root: Root | null = null
let host: HTMLDivElement | null = null
beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; h.rpc.mockReset(); h.listener = null })
afterEach(() => { if (root) act(() => root!.unmount()); root = null; host?.remove(); host = null; vi.useRealTimers() })
async function mount(node: React.ReactNode) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(node); await Promise.resolve(); await Promise.resolve() })
  return host
}
const settle = () => act(async () => { for (let index = 0; index < 6; index++) await Promise.resolve() })
const button = (view: HTMLElement, label: string) => [...view.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.includes(label))
async function type(field: HTMLTextAreaElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}

describe('fan-out helpers', () => {
  it('reads only well-formed records and keeps unknown usage as null, not zero', () => {
    expect(normalizeFanout(null)).toBeNull()
    expect(normalizeFanout({ id: 'x' })).toBeNull()
    const parsed = normalizeFanout(record({ rows: [row('a1', 'Alpha', { tokens: undefined, durationMs: undefined }), 'junk'] }))!
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0].tokens).toBeNull()
    expect(parsed.rows[0].durationMs).toBeNull()
  })

  it('never calls a conversation with no reply yet done', () => {
    expect(fanoutRowState({ state: 'idle', reply: 'hello', error: null })).toEqual({ label: 'Done', tone: 'done' })
    expect(fanoutRowState({ state: 'idle', reply: null, error: null })).toEqual({ label: 'No reply yet', tone: 'idle' })
    expect(fanoutRowState({ state: 'working', reply: null, error: null }).tone).toBe('live')
    expect(fanoutRowState({ state: 'waiting_permission', reply: null, error: null })).toEqual({ label: 'Needs you', tone: 'needs' })
    expect(fanoutRowState({ state: 'idle', reply: 'x', error: 'It could not start.' })).toEqual({ label: 'Failed', tone: 'bad' })
    expect(durationLabel(null)).toBeNull()
    expect(durationLabel(12_000)).toBe('12s')
    expect(durationLabel(125_000)).toBe('2m 5s')
  })
})

describe('asking several bots', () => {
  it('needs two bots and a message, starts in the chosen project with its own copies, and reports the result', async () => {
    h.rpc.mockResolvedValue({ fanout: record() })
    const onStarted = vi.fn()
    const view = await mount(<FanoutDialog agents={bots} projects={projects} runtimes={runtimes} initialAgent={{ ...bots[0], projectId: 'p1' }} onCancel={vi.fn()} onStarted={onStarted} />)
    expect(button(view, 'Alpha')?.getAttribute('aria-pressed')).toBe('true')
    expect(button(view, 'Offline')?.disabled).toBe(true)
    expect(button(view, 'Choose 2 or more')?.disabled).toBe(true)
    await act(async () => { button(view, 'Beta')!.click() })
    expect(button(view, 'Ask 2 bots')?.disabled, 'still needs a message').toBe(true)
    await type(view.querySelector<HTMLTextAreaElement>('.fanout-prompt')!, ' What should we do? ')
    await act(async () => { button(view, 'Ask 2 bots')!.click() }); await settle()
    expect(h.rpc).toHaveBeenCalledWith('fanout.start', { agentIds: ['a1', 'a2'], text: 'What should we do?', projectId: 'p1', worktrees: true })
    expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }))
  })

  it('sends an explicit null for No project, without worktrees, and offers no folderless project', async () => {
    h.rpc.mockResolvedValue({ fanout: record() })
    const view = await mount(<FanoutDialog agents={bots} projects={projects} runtimes={runtimes} initialAgent={bots[0]} onCancel={vi.fn()} onStarted={vi.fn()} />)
    await act(async () => { button(view, 'Beta')!.click() })
    expect(view.querySelector('.fanout-copy'), 'no project has no repository to copy').toBeNull()
    await type(view.querySelector<HTMLTextAreaElement>('.fanout-prompt')!, 'Hello')
    await act(async () => { button(view, 'Ask 2 bots')!.click() }); await settle()
    expect(h.rpc).toHaveBeenCalledWith('fanout.start', { agentIds: ['a1', 'a2'], text: 'Hello', projectId: null, worktrees: false })
  })

  it('stops at six bots and shows a refusal', async () => {
    const many = [1, 2, 3, 4, 5, 6, 7].map((index) => agent(`b${index}`, `Bot${index}`))
    h.rpc.mockRejectedValue(new Error('Choose 2 to 6 bots.'))
    const view = await mount(<FanoutDialog agents={many} projects={[]} runtimes={runtimes} initialAgent={null} onCancel={vi.fn()} onStarted={vi.fn()} />)
    for (const index of [1, 2, 3, 4, 5, 6]) await act(async () => { button(view, `Bot${index}`)!.click() })
    expect(button(view, 'Bot7')?.disabled).toBe(true)
    await type(view.querySelector<HTMLTextAreaElement>('.fanout-prompt')!, 'Hello')
    await act(async () => { button(view, 'Ask 6 bots')!.click() }); await settle()
    expect(view.querySelector('[role="alert"]')?.textContent).toBe('Choose 2 to 6 bots.')
    expect(button(view, 'Ask 6 bots')?.disabled, 'can try again').toBe(false)
  })
})

describe('the compare view', () => {
  function daemon(state: { fanout: ReturnType<typeof record> }) {
    h.rpc.mockImplementation(async (method: string, params: { sessionId?: string | null }) => {
      if (method === 'fanout.list') return { fanouts: [state.fanout] }
      if (method === 'fanout.get') return { fanout: state.fanout }
      if (method === 'fanout.pick') { state.fanout = { ...state.fanout, chosenSessionId: params.sessionId ?? null } as never; return { fanout: state.fanout } }
      if (method === 'fanout.delete') return { deleted: true }
      throw new Error(`unexpected ${method}`)
    })
  }

  it('shows each answer in a column, opens a conversation and marks a pick', async () => {
    const state = { fanout: record({ rows: [row('a1', 'Alpha', { tokens: 1200, worktree: { path: 'D:/w/a', branch: 'bitbots/a' } }), row('a2', 'Beta', { sessionId: null, reply: null, error: 'That coding agent takes no images.', state: 'failed' })] }) }
    daemon(state)
    const onOpen = vi.fn()
    const view = await mount(<CompareView initialId="f1" agents={bots} connected onBack={vi.fn()} onOpenSession={onOpen} onStartNew={vi.fn()} />); await settle()
    const columns = [...view.querySelectorAll<HTMLElement>('.compare-column')]
    expect(columns.map((column) => column.querySelector('strong')?.textContent)).toEqual(['Alpha', 'Beta'])
    expect(columns[0].textContent).toContain('Alpha says hi')
    expect(columns[0].textContent).toContain('1m 5s · 1,200 tokens')
    expect(columns[0].textContent).toContain('bitbots/a')
    expect(columns[1].textContent).toContain('That coding agent takes no images.')
    expect(button(columns[1], 'Pick this'), 'a failed row has nothing to pick').toBeUndefined()
    await act(async () => { button(columns[0], 'Open')!.click() })
    expect(onOpen).toHaveBeenCalledWith('s-a1')
    await act(async () => { button(columns[0], 'Pick this')!.click() }); await settle()
    expect(h.rpc).toHaveBeenCalledWith('fanout.pick', { id: 'f1', sessionId: 's-a1' })
    expect(button(view.querySelector<HTMLElement>('.compare-column.chosen')!, 'Your pick')?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => { button(view, 'Your pick')!.click() }); await settle()
    expect(h.rpc).toHaveBeenLastCalledWith('fanout.pick', { id: 'f1', sessionId: null })
  })

  it('refreshes when a member conversation changes, and ignores others', async () => {
    const state = { fanout: record({ rows: [row('a1', 'Alpha', { reply: null, state: 'working' }), row('a2', 'Beta')] }) }
    daemon(state)
    vi.useFakeTimers()
    const view = await mount(<CompareView initialId="f1" agents={bots} connected onBack={vi.fn()} onOpenSession={vi.fn()} onStartNew={vi.fn()} />); await settle()
    expect(view.querySelector('.compare-column')?.textContent).toContain('Working on it')
    state.fanout = record({ rows: [row('a1', 'Alpha', { reply: 'Finished now' }), row('a2', 'Beta')] })
    await act(async () => { h.listener?.({ type: 'session.changed', payload: { id: 'someone-else' } }); await vi.advanceTimersByTimeAsync(400) })
    expect(view.querySelector('.compare-column')?.textContent).toContain('Working on it')
    await act(async () => { h.listener?.({ type: 'session.changed', payload: { id: 's-a1' } }); await vi.advanceTimersByTimeAsync(400) }); await settle()
    expect(view.querySelector('.compare-column')?.textContent).toContain('Finished now')
  })

  it('lists earlier comparisons, opens one and removes it', async () => {
    daemon({ fanout: record() })
    const view = await mount(<CompareView initialId={null} agents={bots} connected onBack={vi.fn()} onOpenSession={vi.fn()} onStartNew={vi.fn()} />); await settle()
    const item = view.querySelector<HTMLButtonElement>('.compare-list button')!
    expect(item.textContent).toContain('Alpha, Beta · Korus')
    await act(async () => { item.click() }); await settle()
    expect(view.querySelectorAll('.compare-column')).toHaveLength(2)
    await act(async () => { button(view, 'Remove')!.click() }); await settle()
    expect(h.rpc).toHaveBeenCalledWith('fanout.delete', { id: 'f1' })
    expect(view.querySelector('.compare-column')).toBeNull()
  })
})

describe('the companion summary', () => {
  it('shows a comparison only while a bot is working or needs you, and opens its conversation', async () => {
    h.rpc.mockResolvedValue({ fanouts: [record({ rows: [row('a1', 'Alpha', { state: 'working', reply: null }), row('a2', 'Beta')] })] })
    const onOpen = vi.fn()
    const view = await mount(<CompanionFanoutSummary connected onOpen={onOpen} />); await settle()
    expect(view.querySelector('.companion-fanout')?.textContent).toContain('Comparing: Compare this')
    await act(async () => { button(view, 'Alpha')!.click() })
    expect(onOpen).toHaveBeenCalledWith('s-a1')
    act(() => root!.unmount()); root = null; host?.remove()
    h.rpc.mockResolvedValue({ fanouts: [record()] })
    const done = await mount(<CompanionFanoutSummary connected onOpen={onOpen} />); await settle()
    expect(done.querySelector('.companion-fanout')).toBeNull()
  })
})
