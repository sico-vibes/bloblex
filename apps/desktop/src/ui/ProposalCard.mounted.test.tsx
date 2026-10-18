// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rpc: vi.fn(), openProjectFolder: vi.fn(), setActiveRuntime: vi.fn(), setActiveSession: vi.fn() }))
vi.mock('../tauri', () => ({ rpc: h.rpc, openProjectFolder: h.openProjectFolder, setActiveRuntime: h.setActiveRuntime, setActiveSession: h.setActiveSession }))
vi.mock('../blob/BlobCanvas', () => ({ BlobCanvas: () => <div aria-label="Proposed look" /> }))
import { folderNameFor, joinFolder, ProposalCard, proposalEdits, projectForDraft } from './ProposalCard'
import type { PermissionRequest, Project } from '../types'

let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const button = (label: string) => [...host!.querySelectorAll('button')].find((item) => item.textContent?.trim() === label || item.textContent?.includes(label)) as HTMLButtonElement

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  h.rpc.mockReset(); h.rpc.mockResolvedValue({})
  h.setActiveRuntime.mockReset(); h.setActiveSession.mockReset()
  h.openProjectFolder.mockReset()
})
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = null; host = null })

async function mount(request: PermissionRequest) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(<ProposalCard request={request} managerName="Max" projects={[{ id: 'p1', name: 'Yummy' } as never]} />) })
}

/** Mounts the card with a given project list, replacing any previous mount. */
async function mountWith(request: PermissionRequest, projects: readonly Project[]) {
  if (root) act(() => root!.unmount())
  host?.remove()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(<ProposalCard request={request} managerName="Max" projects={projects} />) })
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

  // FIX39 item 19: the Manager's permission card shows the conversation and the
  // mode, and never offers full access.
  it('shows a conversation permission change without offering full access', async () => {
    await mount(proposal('permission', { conversation: 'side-7', mode: 'auto' }))
    expect(host!.textContent).toContain("Change a bot's permission")
    expect(host!.textContent).toContain('side-7')
    expect(host!.textContent).toContain('Auto')
    expect(host!.textContent).toContain('Full access can never be set this way.')
    expect(host!.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => { button('Approve').click() })
    await flush()
    expect(h.rpc).toHaveBeenCalledWith('proposal.decide', { id: 'prop-1', decision: 'approve' })
  })
})

// FIX39 P6 audit finding 4: the folder line must resolve a project the same way
// the daemon does (id, or a trimmed case-insensitive name), so it never shows "—"
// while the delegated bot still runs and writes in that project's folder.
describe('task folder line (FIX39 risk 7)', () => {
  const projects: Project[] = [
    { id: 'p-one', name: 'Korus', path: 'C:\\Code\\Korus', sortOrder: 0 },
    { id: 'p-two', name: 'Site', path: 'C:\\Code\\Site', sortOrder: 1 },
  ]
  const task = (project: string) => proposal('task', { bot: 'Scout', brief: 'Look into it', project })
  const folderLine = () => {
    const field = [...host!.querySelectorAll('.proposal-field')].find((node) => node.querySelector('span')?.textContent === 'Folder it runs in')
    return field?.querySelector('.proposal-value')?.textContent ?? null
  }

  it('matches by exact name, another case and id, and refuses an unknown name', async () => {
    await mountWith(task('Korus'), projects)
    expect(folderLine()).toBe('C:\\Code\\Korus')
    await mountWith(task('  kOrUs '), projects)
    expect(folderLine()).toBe('C:\\Code\\Korus')
    await mountWith(task('p-two'), projects)
    expect(folderLine()).toBe('C:\\Code\\Site')
    await mountWith(task('Missing'), projects)
    expect(folderLine()).toBe('Project not found')
    await mountWith(task(''), projects)
    expect(folderLine()).toBeNull()
  })

  it('resolves the project for the same inputs as the daemon', () => {
    expect(projectForDraft(projects, 'Korus')?.id).toBe('p-one')
    expect(projectForDraft(projects, ' KORUS ')?.id).toBe('p-one')
    expect(projectForDraft(projects, 'p-two')?.id).toBe('p-two')
    expect(projectForDraft(projects, 'Missing')).toBeUndefined()
    expect(projectForDraft(projects, '  ')).toBeUndefined()
  })
})

// P7: the owner reviews the Manager's actual change and task contract.
describe('P7 tool proposals', () => {
  it('shows every proposed bot field', async () => {
    await mount(proposal('bot', { action: 'update', blob: 'Scout', name: 'Sage', tags: ['researcher'], model: 'm1', thinking: 'high', approvalMode: 'auto', look: { shape: 'circle' } }))
    expect(host!.textContent).toContain('Update a bot')
    for (const value of ['Scout', 'Sage', 'researcher', 'm1', 'high', 'Auto', 'circle']) expect(host!.textContent).toContain(value)
    expect(host!.textContent).not.toContain('Coding agent')
    await act(async () => { button('Approve').click() })
    expect(h.rpc).toHaveBeenCalledWith('proposal.decide', { id: 'prop-1', decision: 'approve' })
  })
  it('shows project edits without asking for a new folder', async () => {
    await mount(proposal('project', { action: 'update', project: 'Portal', tags: ['research'] }))
    expect(host!.textContent).toContain('Update a project')
    expect(host!.textContent).toContain('Portal')
    expect(host!.textContent).toContain('research')
    expect(host!.textContent).not.toContain('Choose where')
    expect(button('Approve').disabled).toBe(false)
  })
  it('shows the Manager-filled task contract without a form', async () => {
    await mount(proposal('task', { bot: 'Scout', brief: 'Research the market', doneGoal: 'Three checked sources', reportBack: 'Findings and links' }))
    for (const value of ['Research the market', 'Three checked sources', 'Findings and links']) expect(host!.textContent).toContain(value)
    expect(host!.querySelector('input, textarea')).toBeNull()
  })
  it('shows which conversation will open', async () => {
    await mount(proposal('task', { action: 'open', conversation: 'side-1', title: 'Research' }))
    expect(host!.textContent).toContain('Open a conversation')
    expect(host!.textContent).toContain('side-1')
    expect(host!.textContent).toContain('Research')
    expect(host!.textContent).not.toContain('The task')
  })
})

it('opens only the conversation returned by an approved open proposal', async () => {
  h.rpc.mockResolvedValue({ result: { action: 'open', sessionId: 'approved-side', runtimeId: 'rt1' } })
  await mount(proposal('task', { action: 'open', conversation: 'side-1', title: 'Research' }))
  expect(h.setActiveSession).not.toHaveBeenCalled()
  await act(async () => { button('Approve').click() })
  expect(h.setActiveRuntime).toHaveBeenCalledWith('rt1')
  expect(h.setActiveSession).toHaveBeenCalledWith('approved-side')
})

it('does not open a rejected proposal', async () => {
  await mount(proposal('task', { action: 'open', conversation: 'side-1', title: 'Research' }))
  await act(async () => { button('Reject').click() })
  expect(h.setActiveSession).not.toHaveBeenCalled()
})
