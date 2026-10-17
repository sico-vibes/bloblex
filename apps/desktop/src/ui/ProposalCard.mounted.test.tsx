// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rpc: vi.fn(), openProjectFolder: vi.fn() }))
vi.mock('../tauri', () => ({ rpc: h.rpc, openProjectFolder: h.openProjectFolder }))
import { folderNameFor, joinFolder, ProposalCard, proposalEdits } from './ProposalCard'
import type { PermissionRequest } from '../types'

let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const button = (label: string) => [...host!.querySelectorAll('button')].find((item) => item.textContent?.trim() === label || item.textContent?.includes(label)) as HTMLButtonElement

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  h.rpc.mockReset(); h.rpc.mockResolvedValue({})
  h.openProjectFolder.mockReset()
})
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = null; host = null })

async function mount(request: PermissionRequest) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(<ProposalCard request={request} managerName="Max" projects={[{ id: 'p1', name: 'Yummy' } as never]} />) })
}
const proposal = (kind: string, payload: Record<string, unknown>): PermissionRequest => ({ id: 'perm-1', sessionId: 's', runtimeId: 'rt', status: 'pending', kind: 'proposal', choices: ['approve', 'reject'], proposal: { id: 'prop-1', kind, payload } })

describe('proposal helpers', () => {
  it('makes a safe folder name and joins it to the chosen parent', () => {
    expect(folderNameFor('Yummy: v2 / app?')).toBe('Yummy- v2 - app')
    expect(joinFolder('C:\\Users\\me\\Projects\\', 'Yummy')).toBe('C:\\Users\\me\\Projects\\Yummy')
    expect(joinFolder('/home/me', 'Yummy')).toBe('/home/me/Yummy')
  })
  it('sends only the fields the owner changed', () => {
    expect(proposalEdits({ name: 'A', role: 'B' }, { name: 'A', role: 'C' })).toEqual({ role: 'C' })
    expect(proposalEdits({ name: 'A' }, { name: 'A' })).toBeUndefined()
  })
})

describe('proposal card', () => {
  it('approves a bot with the owner’s edit', async () => {
    await mount(proposal('bot', { name: 'Scout', role: 'Research', description: 'Finds things', instructions: 'Be brief', provider: 'opencode' }))
    expect(host!.textContent).toContain('Max proposes')
    expect(host!.textContent).toContain('Create a bot')
    await act(async () => { button('Edit').click() })
    const role = [...host!.querySelectorAll('input')][1]!
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(role, 'Researcher'); role.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { button('Approve').click() })
    await flush()
    expect(h.rpc).toHaveBeenCalledWith('proposal.decide', { id: 'prop-1', decision: 'approve', edits: { role: 'Researcher' } })
  })

  it('needs a place for a new project folder before it can be approved', async () => {
    h.openProjectFolder.mockResolvedValue('C:\\Code')
    await mount(proposal('project', { name: 'Yummy', description: 'A desktop app', folder: { mode: 'new' } }))
    expect(button('Approve').disabled).toBe(true)
    await act(async () => { button('Choose where').click() })
    await flush()
    expect(host!.textContent).toContain('C:\\Code\\Yummy')
    await act(async () => { button('Approve').click() })
    await flush()
    expect(h.rpc).toHaveBeenCalledWith('proposal.decide', { id: 'prop-1', decision: 'approve', edits: { folder: { mode: 'new', path: 'C:\\Code\\Yummy' } } })
  })

  it('rejects without edits', async () => {
    await mount(proposal('task', { bot: 'Scout', brief: 'Look into it' }))
    await act(async () => { button('Reject').click() })
    await flush()
    expect(h.rpc).toHaveBeenCalledWith('proposal.decide', { id: 'prop-1', decision: 'reject' })
  })
})
