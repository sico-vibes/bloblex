// @vitest-environment happy-dom
// Phase 8: sub-bots stay visible under their parent, in the conversation that started them, and in the companion.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '../types'

const rpc = vi.fn()
const showMainWindow = vi.fn(async () => undefined)
vi.mock('../tauri', () => ({
  inDesktop: true,
  rpc: (...args: unknown[]) => rpc(...args),
  showMainWindow: (...args: unknown[]) => showMainWindow(...(args as [])),
  listenForDaemonEvents: vi.fn(async () => () => undefined),
  openExternal: vi.fn(),
}))
vi.mock('../blob/BlobCanvas', () => ({ BlobCanvas: () => <i /> }))

import { CompanionFleetChip, SubbotComposer, SubbotCount, SubbotFleet, SubbotRows } from './SubbotViews'
import { fleetCount, isActiveSubbot, normalizeSubbots, orderFleet, subbotLine, type Subbot } from './subbots'
import { rosterAgents } from './teamSelectors'

const parent = { id: 'p', name: 'Rae', color: 'mint' } as unknown as Agent
const sub = (over: Partial<Subbot> = {}): Subbot => ({ agentId: 'a', parentAgentId: 'p', originSessionId: 's', name: 'Pricing', role: null, provider: 'claude', model: 'claude-haiku-5-5', thinking: null, sessionId: 'side-a', delegationId: 'd-a', status: 'running', doingNow: null, startedAt: null, finishedAt: null, error: null, ...over })

let root: Root | null = null
let host: HTMLDivElement
const render = async (element: React.ReactElement) => {
  await act(async () => { root!.render(element) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const button = (label: string) => [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label) as HTMLButtonElement
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click() }); await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const fleet = (rows: Subbot[]) => rpc.mockImplementation(async (method: string) => method === 'subbot.list' ? { subbots: rows } : {})

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  rpc.mockReset(); showMainWindow.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => { await act(async () => { root?.unmount() }); root = null; host.remove() })

describe('what the daemon reports', () => {
  it('leaves out a row with no bot or an unknown status, and never guesses', () => {
    expect(normalizeSubbots({ subbots: [{ status: 'running' }, { agentId: 'a', status: 'nonsense' }, { agentId: 'b', status: 'queued' }] }).map((item) => item.agentId)).toEqual(['b'])
    expect(normalizeSubbots(null)).toEqual([])
  })
  it('counts what is working against the whole fleet', () => {
    expect(fleetCount([sub(), sub({ agentId: 'b' }), sub({ agentId: 'c', status: 'queued' })])).toBe('2/3 working')
    expect(fleetCount([sub({ status: 'completed' })])).toBeNull()
    expect(fleetCount([])).toBeNull()
  })
  it('keeps live ones first without reshuffling them', () => {
    expect(orderFleet([sub({ agentId: 'x', status: 'completed' }), sub({ agentId: 'y' }), sub({ agentId: 'z', status: 'queued' })]).map((item) => item.agentId)).toEqual(['y', 'z', 'x'])
    expect(isActiveSubbot({ status: 'interrupted' })).toBe(false)
  })
  it('says what it is doing, or how it ended', () => {
    expect(subbotLine(sub({ doingNow: 'Reading a.ts' }))).toBe('Reading a.ts')
    expect(subbotLine(sub())).toBe('Working')
    expect(subbotLine(sub({ status: 'failed', error: 'Limit reached.' }))).toBe('Limit reached.')
    expect(subbotLine(sub({ status: 'completed', doingNow: 'stale' }))).toBe('Done')
  })
  it('a sub-bot stays off the roster', () => {
    const list = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', hidden: true, parentAgentId: 'a' }, { id: 'c', name: 'C', parentAgentId: 'a' }] as unknown as Agent[]
    expect(rosterAgents(list, true).map((item) => item.id)).toEqual(['a'])
  })
})

describe('in the sidebar', () => {
  it('nests each one under its parent, finished ones included, and opens it', async () => {
    fleet([sub({ name: 'Done one', status: 'completed', agentId: 'x', sessionId: 'side-x' }), sub({ doingNow: 'Reading a.ts' })])
    const onOpen = vi.fn()
    await render(<SubbotRows parent={parent} onOpen={onOpen} />)
    expect(rpc).toHaveBeenCalledWith('subbot.list', { agentId: 'p' })
    const rows = [...document.querySelectorAll('.subbot-row')]
    expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual(['Pricing', 'Done one'])
    expect(rows[0].textContent).toContain('Reading a.ts')
    await click(rows[1])
    expect(onOpen).toHaveBeenCalledWith('side-x')
  })
  it('shows nothing with no fleet', async () => {
    fleet([])
    await render(<SubbotRows parent={parent} onOpen={vi.fn()} />)
    expect(document.querySelector('.subbot-rows')).toBeNull()
  })
})

describe('in the conversation', () => {
  it('shows each model and state, and stops one or all', async () => {
    fleet([sub(), sub({ agentId: 'b', name: 'Other', delegationId: 'd-b', status: 'queued' }), sub({ agentId: 'c', name: 'Over', status: 'completed' })])
    const onOpen = vi.fn()
    await render(<SubbotFleet sessionId="s" parent={parent} onOpen={onOpen} />)
    expect(rpc).toHaveBeenCalledWith('subbot.list', { sessionId: 's' })
    expect(document.body.textContent).toContain('1/3 working')
    expect(document.body.textContent).toContain('claude-haiku-5-5')
    expect(button('Stop Over')).toBeUndefined()
    await click(button('Stop Pricing'))
    expect(rpc).toHaveBeenCalledWith('delegation.cancel', { delegationId: 'd-a' })
    await click(button('Stop all'))
    expect(rpc).toHaveBeenCalledWith('delegation.cancelGroup', { originSessionId: 's', delegationIds: ['d-a', 'd-b'] })
    await click(button('Open Pricing'))
    expect(onOpen).toHaveBeenCalledWith('side-a')
  })
  it('stays once they have finished, and offers no Stop all', async () => {
    fleet([sub({ status: 'completed' })])
    await render(<SubbotFleet sessionId="s" onOpen={vi.fn()} />)
    expect(document.body.textContent).toContain('1 finished')
    expect(button('Stop all')).toBeUndefined()
  })
})

describe('messaging a sub-bot', () => {
  it('sends to its own conversation', async () => {
    rpc.mockResolvedValue({})
    await render(<SubbotComposer sessionId="side-a" name="Pricing" onClose={vi.fn()} />)
    const box = document.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value')!.set!
    await act(async () => { setter.call(box, 'Look at the EU too'); box.dispatchEvent(new Event('input', { bubbles: true })) })
    await click(button('Send'))
    expect(rpc).toHaveBeenCalledWith('session.prompt', { sessionId: 'side-a', text: 'Look at the EU too' })
    expect(box.value).toBe('')
  })
})

describe('in the companion', () => {
  it('counts on the rail and opens the full app from the chip', async () => {
    fleet([sub(), sub({ agentId: 'b', status: 'queued' })])
    await render(<><SubbotCount agentId="p" /><CompanionFleetChip agent={parent} sessionId="s" /></>)
    expect(document.querySelector('.subbot-count')?.textContent).toBe('1/2')
    expect(button('Rae · 1/2 working')).toBeTruthy()
    await click(button('Rae · 1/2 working'))
    expect(showMainWindow).toHaveBeenCalledWith('s')
  })
  it('shows nothing when no sub-bot is active', async () => {
    fleet([sub({ status: 'completed' })])
    await render(<><SubbotCount agentId="p" /><CompanionFleetChip agent={parent} /></>)
    expect(document.querySelector('.subbot-count')).toBeNull()
    expect(document.querySelector('.companion-fleet')).toBeNull()
  })
})
