// @vitest-environment happy-dom
// Phase 6: visual replies, terminal links, the bot's commands and the sidebar's order.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Project, Session } from '../types'

vi.mock('./openSafeLink', () => ({ openSafeLink: vi.fn() }))
const rpc = vi.fn()
vi.mock('../tauri', () => ({ inDesktop: true, rpc: (...args: unknown[]) => rpc(...args), openExternal: vi.fn(), revealInExplorer: vi.fn() }))

import { VisualFrame, VisualReply, visualDocument, visualFence } from './VisualReply'
import { terminalLinks } from './terminalLinks'
import { botCommands } from './BotCommands'
import { WebhookPanel } from './WebhookPanel'
import { SETTLE_AFTER_MS, groupBotsByProject, hasSettled, settleOrder, sortBots } from './sidebarOrder'

let root: Root | null = null
let host: HTMLDivElement
const render = async (element: React.ReactElement) => { await act(async () => { root!.render(element) }) }
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => { await act(async () => { root?.unmount() }); root = null; host.remove(); document.body.innerHTML = '' })

describe('visual replies', () => {
  it('only a bitbots-visual fence opens drawn', () => {
    expect(visualFence('bitbots-visual', '<b>x</b>')).toEqual({ start: 'preview' })
    expect(visualFence('html', '<b>x</b>')).toEqual({ start: 'code' })
    expect(visualFence('svg', '<svg></svg>')).toEqual({ start: 'code' })
    expect(visualFence('svg', 'not a picture')).toBeNull()
    expect(visualFence('js', 'x')).toBeNull()
  })

  it('the frame has an empty sandbox and a closed policy', async () => {
    await render(<VisualFrame code={'<script>parent.x=1</script><p>Hi</p>'} />)
    const frame = host.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('')
    const doc = frame.getAttribute('srcdoc') ?? ''
    expect(doc).toContain("default-src 'none'")
    expect(doc).not.toContain("script-src")
    expect(visualDocument('<p>x</p>')).toContain('<p>x</p>')
  })

  it('switches between the picture and its code', async () => {
    await render(<VisualReply code="<p>Hi</p>" start="code" renderCode={() => <pre>raw code</pre>} />)
    expect(host.querySelector('iframe')).toBeNull()
    expect(host.textContent).toContain('raw code')
    await act(async () => { [...host.querySelectorAll('button')].find((item) => item.textContent === 'Preview')!.click() })
    expect(host.querySelector('iframe')).not.toBeNull()
  })
})

describe("the bot's commands", () => {
  const session = (tools: unknown[]) => ({ id: 's', state: 'idle', messages: [], turns: [], tools }) as unknown as Session
  it('lists commands only, and hides what the step view hides', () => {
    const rows = botCommands(session([
      { id: 'a', kind: 'command', state: 'completed', detail: { command: 'npm test', output: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789' } },
      { id: 'b', kind: 'read', state: 'completed', detail: { path: 'x.ts' } },
    ]))
    expect(rows.map((row) => row.command)).toEqual(['npm test'])
    expect(rows[0].output).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  })
  it('has nothing for no conversation', () => {
    expect(botCommands(null)).toEqual([])
  })
})

describe('a schedule webhook', () => {
  const click = async (label: string) => { await act(async () => { [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)!.click() }); await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
  beforeEach(() => rpc.mockReset())

  it('asks first, shows the secret once, and forgets it when turned off', async () => {
    rpc.mockImplementation(async (method: string) => method === 'automation.webhook.enable'
      ? { url: 'https://host/api/hook/a', secret: 'shh-once', webhook: { enabled: true, includeBody: false } }
      : { webhook: { enabled: false, includeBody: false } })
    await render(<WebhookPanel automationId="a" name="Nightly" onChanged={vi.fn()} />)
    await click('Start from a webhook')
    await click('Turn on')
    expect(rpc).not.toHaveBeenCalled()
    const confirm = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].find((item) => item.textContent?.trim() === 'Turn on') as HTMLButtonElement
    await act(async () => { confirm.click() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(rpc).toHaveBeenCalledWith('automation.webhook.enable', { id: 'a', includeBody: false, confirm: true })
    expect(document.body.textContent).toContain('shh-once')
    expect(document.body.textContent).toContain("It won't be shown again.")
    await click('Turn off')
    expect(rpc).toHaveBeenCalledWith('automation.webhook.disable', { id: 'a' })
    expect(document.body.textContent).not.toContain('shh-once')
  })

  it('an existing webhook shows no secret, and rotating asks first', async () => {
    rpc.mockResolvedValue({ url: 'https://host/api/hook/a', secret: 'new-one', webhook: { enabled: true, includeBody: false } })
    await render(<WebhookPanel automationId="a" name="Nightly" webhook={{ enabled: true, includeBody: false, url: 'https://host/api/hook/a' }} onChanged={vi.fn()} />)
    await click('Webhook on')
    expect(document.body.textContent).toContain('https://host/api/hook/a')
    expect(document.body.textContent).toContain('Rotate it')
    await click('Rotate the secret')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('leaves the body out unless asked', async () => {
    rpc.mockResolvedValue({ webhook: { enabled: true, includeBody: true } })
    await render(<WebhookPanel automationId="a" name="Nightly" webhook={{ enabled: true, includeBody: false }} onChanged={vi.fn()} />)
    await click('Webhook on')
    expect(document.body.textContent).toContain('Turn Remote on')
    const box = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(box.checked).toBe(false)
    await act(async () => { box.click() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(rpc).toHaveBeenCalledWith('automation.webhook.update', { id: 'a', includeBody: true })
  })
})

describe('terminal links', () => {
  it('finds http and https with 1-based columns', () => {
    expect(terminalLinks('see https://a.example/x now')).toEqual([{ start: 5, end: 23, url: 'https://a.example/x' }])
    expect(terminalLinks('http://localhost:5173')).toEqual([{ start: 1, end: 21, url: 'http://localhost:5173' }])
  })
  it('leaves other schemes and trailing punctuation out', () => {
    expect(terminalLinks('file:///c:/x javascript:alert(1)')).toEqual([])
    expect(terminalLinks('go to https://a.example/x.')[0].url).toBe('https://a.example/x')
    expect(terminalLinks('(https://a.example/y)')[0].url).toBe('https://a.example/y')
    expect(terminalLinks('https://a.example/w_(x)')[0].url).toBe('https://a.example/w_(x)')
  })
})

describe('the sidebar order', () => {
  const agent = (id: string, name: string, projectId: string | null = null) => ({ id, name, projectId }) as unknown as Agent
  const session = (id: string, agentId: string, state: string, updatedAt: string) => ({ id, agentId, state, updatedAt }) as unknown as Session
  const bots = [agent('c', 'Cleo'), agent('a', 'Ana'), agent('b', 'Bo')]
  const sessions = [session('1', 'c', 'idle', '2026-10-01T00:00:00Z'), session('2', 'a', 'working', '2026-09-01T00:00:00Z'), session('3', 'b', 'waiting_permission', '2026-08-01T00:00:00Z')]
  it('sorts by name, recent and status, and keeps my order', () => {
    expect(sortBots(bots, sessions, 'manual').map((item) => item.id)).toEqual(['c', 'a', 'b'])
    expect(sortBots(bots, sessions, 'name').map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(sortBots(bots, sessions, 'recent').map((item) => item.id)).toEqual(['c', 'a', 'b'])
    expect(sortBots(bots, sessions, 'status').map((item) => item.id)).toEqual(['b', 'a', 'c'])
  })
  it('groups by default project, with none last', () => {
    const projects = [{ id: 'p2', name: 'Two', sortOrder: 2 }, { id: 'p1', name: 'One', sortOrder: 1 }] as Project[]
    const groups = groupBotsByProject([agent('a', 'A', 'p2'), agent('b', 'B'), agent('c', 'C', 'p1'), agent('d', 'D', 'gone')], projects)
    expect(groups.map((group) => [group.name, group.agents.map((item) => item.id)])).toEqual([['One', ['c']], ['Two', ['a']], ['No project', ['b', 'd']]])
  })
  it('a finished conversation settles only when read and an hour old', () => {
    const now = Date.parse('2026-10-31T12:00:00Z')
    const old = new Date(now - SETTLE_AFTER_MS - 1000).toISOString()
    const fresh = new Date(now - 1000).toISOString()
    expect(hasSettled(session('x', 'a', 'idle', old), now, false)).toBe(true)
    expect(hasSettled(session('x', 'a', 'idle', fresh), now, false)).toBe(false)
    expect(hasSettled(session('x', 'a', 'idle', old), now, true)).toBe(false)
    expect(hasSettled(session('x', 'a', 'working', old), now, false)).toBe(false)
    expect(hasSettled(session('x', 'a', 'waiting_permission', old), now, false)).toBe(false)
    expect(hasSettled(session('x', 'a', 'failed', old), now, false)).toBe(false)
    expect(settleOrder([1, 2, 3, 4], (item) => item % 2 === 1)).toEqual([2, 4, 1, 3])
  })
})
