// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, ManagerFact, PlaybookVersion } from '../types'

const h = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../tauri', () => ({ rpc: h.rpc, listenForDaemonEvents: () => Promise.resolve(() => undefined) }))
import { groupFacts, ManagerPage } from './ManagerPage'

const facts: ManagerFact[] = [
  { id: 'f1', category: 'workflow', key: 'Reviews', value: 'Small diffs, one topic each', source: 'learned', locked: false },
  { id: 'f2', category: 'identity', key: 'Name', value: 'Sam', source: 'said', locked: true },
  { id: 'f3', category: 'workflow', key: 'Tests first', value: 'Always', source: 'corrected', locked: true },
]
const versions: PlaybookVersion[] = [
  { version: 2, text: '# Playbook\nAsk first.\nKeep teams small.', author: 'manager', createdAt: '2026-10-17T20:00:00Z' },
  { version: 1, text: '# Playbook\nAsk first.', author: 'default', createdAt: '2026-10-16T20:00:00Z' },
]
const manager = { id: 'mgr', name: 'Max', model: 'gpt-6-luna', systemRole: 'manager' } as unknown as Agent

let root: Root | null = null
let host: HTMLDivElement | null = null
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) }) }
const button = (label: string) => [...host!.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)!

beforeEach(() => {
  h.rpc.mockReset()
  h.rpc.mockImplementation(async (method: string) => {
    if (method === 'manager.profile.list') return { facts }
    if (method === 'manager.playbook.history') return { versions }
    return {}
  })
})
afterEach(() => { if (root) act(() => root?.unmount()); host?.remove(); root = null; host = null })

async function mount(onOpen = vi.fn()) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(<ManagerPage manager={manager} onOpenManager={onOpen} />) })
  await settle()
  return onOpen
}

describe('Settings › Manager', () => {
  it('groups facts by category with locked ones first', () => {
    expect(groupFacts(facts).map((group) => [group.label, group.facts.map((fact) => fact.key)])).toEqual([
      ['About you', ['Name']],
      ['How you work', ['Tests first', 'Reviews']],
    ])
  })

  it('shows what it knows, locks a fact and deletes one after a second click', async () => {
    const onOpen = await mount()
    expect(host!.textContent).toContain('Small diffs, one topic each')
    expect(host!.textContent).toContain('Learned')
    act(() => button('Open').click())
    expect(onOpen).toHaveBeenCalledWith('mgr')
    await act(async () => { button('Lock Reviews').click() })
    expect(h.rpc).toHaveBeenCalledWith('manager.profile.set', { id: 'f1', category: 'workflow', key: 'Reviews', value: 'Small diffs, one topic each', locked: true })
    act(() => button('Delete Reviews').click())
    expect(h.rpc).not.toHaveBeenCalledWith('manager.profile.delete', expect.anything())
    await act(async () => { button('Delete?').click() })
    expect(h.rpc).toHaveBeenCalledWith('manager.profile.delete', { id: 'f1' })
  })

  it('adds a fact the Manager must ask before changing', async () => {
    await mount()
    act(() => button('Add').click())
    const inputs = host!.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.manager-fact-form input.text-input, .manager-fact-form textarea')
    const set = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
      Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set?.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
    set(inputs[0]!, 'Editor')
    set(inputs[1]!, 'VS Code')
    await act(async () => { button('Save').click() })
    expect(h.rpc).toHaveBeenCalledWith('manager.profile.set', { category: 'workflow', key: 'Editor', value: 'VS Code', locked: true })
  })

  it('shows the playbook, what a version changed, and restores an older one', async () => {
    await mount()
    expect(host!.querySelector('.manager-playbook')?.textContent).toContain('Keep teams small.')
    act(() => button('Changes').click())
    const added = [...host!.querySelectorAll('.playbook-diff-line.add')].map((line) => line.textContent)
    expect(added.join()).toContain('Keep teams small.')
    await act(async () => { button('Restore').click() })
    expect(h.rpc).toHaveBeenCalledWith('manager.playbook.revert', { version: 1 })
  })

  it('shows the daemon text, with the code prefix stripped, for a plain string rejection', async () => {
    h.rpc.mockImplementation(async (method: string) => {
      if (method === 'manager.profile.list') return Promise.reject('conflict: Real reason')
      if (method === 'manager.playbook.history') return { versions }
      return {}
    })
    await mount()
    expect(host!.querySelector('[role="alert"]')?.textContent).toBe('Real reason')
  })
})
