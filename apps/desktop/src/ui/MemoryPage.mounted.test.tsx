// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, MemoryRecord, Project } from '../types'
import { MemoryPage } from './MemoryPage'
import { chooseOption } from './testSelect'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../tauri', () => ({ rpc: mocks.rpc }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agents = [
  { id: 'a1', name: 'Codex', color: '#82aaff', runtimeId: 'r', sortOrder: 0 },
  { id: 'a2', name: 'Retired', color: '#f38c6f', runtimeId: 'r', sortOrder: 1, archived: true },
] as Agent[]
const projects = [{ id: 'p1', name: 'Site' }] as Project[]

const record = (partial: Partial<MemoryRecord> & Pick<MemoryRecord, 'id' | 'title'>): MemoryRecord => ({
  scope: 'shared', scopeId: null, kind: 'preference', body: 'Use tabs.', origin: 'user', reviewed: true, version: 1, pinned: false, ...partial,
})

let host: HTMLDivElement
let root: Root
let notes: MemoryRecord[]
const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const q = <T extends Element>(selector: string) => host.querySelector<T>(selector)
const all = (selector: string) => [...host.querySelectorAll<HTMLElement>(selector)]
const click = async (element: Element | null | undefined) => { if (!element) throw new Error('missing element'); await act(async () => { (element as HTMLElement).click() }); await tick() }
const type = async (element: HTMLInputElement | HTMLTextAreaElement | null, value: string) => {
  if (!element) throw new Error('missing field')
  await act(async () => {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function mount(extra: Partial<React.ComponentProps<typeof MemoryPage>> = {}) {
  const props = { onEnabledChange: vi.fn(async () => undefined), onSharedWritesChange: vi.fn(async () => undefined), onAboutSave: vi.fn(async () => undefined) }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<MemoryPage agents={agents} projects={projects} enabled={false} sharedWrites={false} about="" connected {...props} {...extra} />))
  await tick()
  return props
}

beforeEach(() => {
  notes = []
  mocks.rpc.mockReset()
  mocks.rpc.mockImplementation(async (method: string) => method === 'memory.list' ? { records: notes } : {})
})
afterEach(() => { if (root) act(() => root.unmount()); host?.remove() })

describe('MemoryPage', () => {
  it('starts empty, off, and explains that unreviewed notes stay unused', async () => {
    await mount()
    expect(host.textContent).toContain('stay unused until you approve them')
    expect(q('.memory-empty')?.textContent).toContain('No notes yet')
    expect(q('[aria-label="Let bots use memory"]')?.getAttribute('aria-checked')).toBe('false')
  })

  it('puts agent-saved notes needing review first and approves through the daemon', async () => {
    notes = [
      record({ id: 'n1', title: 'Prefers tabs' }),
      record({ id: 'n2', title: 'Uses pnpm', scope: 'project', scopeId: 'p1', origin: 'agent', reviewed: false, version: 3 }),
    ]
    await mount()
    expect(q('.memory-heading')?.textContent).toContain('Needs your review')
    const rows = all('.memory-row')
    expect(rows[0].textContent).toContain('Uses pnpm')
    expect(rows[0].textContent).toContain('Site')
    expect(rows[0].textContent).toContain('Saved by a bot')
    expect(rows[1].textContent).toContain('Prefers tabs')
    expect(rows[1].textContent).toContain('Written by you')
    await click(all('.memory-row button').find((button) => button.textContent?.includes('Approve')))
    expect(mocks.rpc).toHaveBeenCalledWith('memory.approve', { id: 'n2' })
  })

  it('filters by search text and shows a no-match message', async () => {
    notes = [record({ id: 'n1', title: 'Prefers tabs' }), record({ id: 'n2', title: 'Deploy steps', body: 'Run the release script.' })]
    await mount()
    await type(q<HTMLInputElement>('.memory-search'), 'release')
    expect(all('.memory-row')).toHaveLength(1)
    expect(all('.memory-row')[0].textContent).toContain('Deploy steps')
    await type(q<HTMLInputElement>('.memory-search'), 'nothing like this')
    expect(q('.memory-empty')?.textContent).toContain('No notes match')
  })

  it('edits with the optimistic version and surfaces a conflict', async () => {
    notes = [record({ id: 'n1', title: 'Prefers tabs', version: 4 })]
    await mount()
    mocks.rpc.mockImplementation(async (method: string) => {
      if (method === 'memory.list') return { records: notes }
      if (method === 'memory.update') throw new Error('That note changed. Reload and try again.')
      return {}
    })
    await click(q('[aria-label="Edit Prefers tabs"]'))
    const dialog = q('[role="dialog"]')!
    await type(dialog.querySelector<HTMLInputElement>('input'), 'Prefers tabs, always')
    await click([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Save'))
    expect(mocks.rpc).toHaveBeenCalledWith('memory.update', { id: 'n1', expectedVersion: 4, title: 'Prefers tabs, always', body: 'Use tabs.', kind: 'preference', pinned: false })
    expect(q('[role="dialog"] [role="alert"]')?.textContent).toBe('That note changed. Reload and try again.')
  })

  it('adds a note for everyone or one blob and never offers archived blobs', async () => {
    await mount()
    await click(all('button').find((button) => button.textContent?.includes('Add note')))
    const dialog = q('[role="dialog"]')!
    const create = () => [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Add note') as HTMLButtonElement
    expect(create().disabled).toBe(true)
    await type(dialog.querySelector<HTMLInputElement>('input'), 'Likes short answers')
    await type(dialog.querySelector<HTMLTextAreaElement>('textarea'), 'Keep replies brief.')
    await chooseOption(dialog, 'Who can use it', 'blob')
    await tick()
    const blobOptions = await (async () => {
      const trigger = dialog.querySelector<HTMLElement>('.select-trigger[aria-label^="Bot"]')!
      await act(async () => { trigger.click() })
      return [...trigger.parentElement!.querySelectorAll('[role="option"]')].map((option) => option.textContent)
    })()
    expect(blobOptions).toEqual(['Codex'])
    await act(async () => { dialog.querySelector<HTMLElement>('.select-trigger[aria-label^="Bot"]')!.click() })
    await click(create())
    expect(mocks.rpc).toHaveBeenCalledWith('memory.create', { scope: 'blob', scopeId: 'a1', kind: 'fact', title: 'Likes short answers', body: 'Keep replies brief.', pinned: false })
  })

  it('offers shared-note suggestions only while memory is on and saves the choice', async () => {
    const off = await mount()
    expect(q('[aria-label="Let bots suggest shared notes"]')).toBeNull()
    act(() => root.unmount()); host.remove()
    const on = await mount({ enabled: true })
    const toggle = q('[aria-label="Let bots suggest shared notes"]')
    expect(toggle?.getAttribute('aria-checked')).toBe('false')
    await click(toggle)
    expect(on.onSharedWritesChange).toHaveBeenCalledWith(true)
    expect(off.onSharedWritesChange).not.toHaveBeenCalled()
  })

  it('confirms before deleting', async () => {
    notes = [record({ id: 'n1', title: 'Prefers tabs' })]
    await mount()
    await click(q('[aria-label="Delete Prefers tabs"]'))
    expect(mocks.rpc).not.toHaveBeenCalledWith('memory.delete', expect.anything())
    await click([...host.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === 'Delete'))
    expect(mocks.rpc).toHaveBeenCalledWith('memory.delete', { id: 'n1' })
  })

  it('saves the about-you text within its limit and toggles memory through the host', async () => {
    const props = await mount({ about: 'Staff engineer.' })
    const area = q<HTMLTextAreaElement>('.memory-about textarea')!
    expect(area.value).toBe('Staff engineer.')
    const save = all('.memory-about button')[0] as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await type(area, 'Staff engineer who prefers small diffs.')
    expect(save.disabled).toBe(false)
    await click(save)
    expect(props.onAboutSave).toHaveBeenCalledWith('Staff engineer who prefers small diffs.')
    await type(area, 'x'.repeat(1501))
    expect((all('.memory-about button')[0] as HTMLButtonElement).disabled).toBe(true)
    expect(q('.memory-about small.over')?.textContent).toBe('1501/1500')
    await click(q('[aria-label="Let bots use memory"]'))
    expect(props.onEnabledChange).toHaveBeenCalledWith(true)
  })

  it('shows the daemon text, with the code prefix stripped, for a plain string rejection', async () => {
    mocks.rpc.mockImplementation(async (method: string) => method === 'memory.list' ? Promise.reject('conflict: Real reason') : {})
    await mount()
    expect(q('[role="alert"]')?.textContent).toBe('Real reason')
  })
})
