// @vitest-environment happy-dom
// FIX22 B3/B7/B8/B9/B10/B11: the second batch of bot-page work.
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Runtime, Session } from '../types'
import type { AgentDraft } from './agentForm'
import { BlobSettings } from './BlobSettings'
import { resetHints } from './uiPrefs'
import { setDetailsOpen } from './botPrefs'
import { recordInstructionVersion } from './instructionHistory'
import { chooseOption, selectOptions, selectTrigger, viewText } from './testSelect'

const rpc = vi.hoisted(() => vi.fn())
const openProjectFolder = vi.hoisted(() => vi.fn())
vi.mock('../tauri', () => ({ inDesktop: true, previewMode: false, rpc, openProjectFolder }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const runtime: Runtime = { id: 'rt-1', provider: 'codex', status: 'online' }

const catalog = {
  runtimeId: 'rt-1', provider: 'codex', fallback: false, validated: true, source: 'live_query', fetchedAt: '2026-10-02T00:00:00Z', expiresAt: '2026-10-02T00:01:00Z',
  models: [{ id: 'alpha', displayName: 'Alpha', supportedThinking: [], defaultThinking: null, serviceTiers: [], defaultServiceTier: null, hostDependent: false, isDefault: true, group: 'Alpha', availability: 'offered' }],
}

function draft(partial: Partial<AgentDraft> = {}): AgentDraft {
  return {
    name: 'Claude', description: '', instructions: '', color: 'mint', look: null, runtimeId: 'rt-1', defaultProject: null,
    model: 'alpha', thinking: null, serviceTier: null, approvalMode: null, role: '', projectId: null, leader: false, ...partial,
  }
}

function answer(method: string) {
  if (method === 'runtime.capabilities') return { runtimeId: 'rt-1', settings: {} }
  if (method === 'runtime.models') return catalog
  if (method === 'exec.snapshot.latest') return null
  if (method === 'memory.list') return { records: [] }
  if (method === 'settings.get') return { settings: {} }
  return {}
}

interface HarnessProps {
  initial?: AgentDraft
  agentId?: string | null
  sections?: React.ComponentProps<typeof BlobSettings>['sections']
  sessions?: Session[]
  memoryEnabled?: boolean
  onOpenMemory?: () => void
  autoApprovals?: React.ComponentProps<typeof BlobSettings>['autoApprovals']
  onValue?: (draft: AgentDraft) => void
}

function Harness({ initial = draft(), agentId = 'agent-1', sections, sessions, memoryEnabled, onOpenMemory, autoApprovals, onValue }: HarnessProps) {
  const [value, setValue] = useState(initial)
  return <BlobSettings
    draft={value}
    runtimes={[runtime]}
    errors={{}}
    execution={{ model: initial.model, thinking: initial.thinking, serviceTier: initial.serviceTier, maxConcurrency: 1 }}
    agentId={agentId}
    sessionId={null}
    sections={sections}
    sessions={sessions}
    memoryEnabled={memoryEnabled}
    onOpenMemory={onOpenMemory}
    autoApprovals={autoApprovals}
    onDraftChange={(next) => { setValue(next); onValue?.(next) }}
  />
}

const mounted: Array<{ unmount: () => void }> = []
function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  act(() => root.render(node))
  let live = true
  const view = {
    host,
    async settle() { await act(async () => { await Promise.resolve(); await Promise.resolve() }) },
    unmount() { if (!live) return; live = false; act(() => root.unmount()); host.remove() },
  }
  mounted.push(view)
  return view
}

beforeEach(() => {
  localStorage.clear()
  setDetailsOpen(false)
  resetHints()
  openProjectFolder.mockReset()
  rpc.mockImplementation(async (method: string) => answer(method))
})
afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount()
  rpc.mockReset()
  localStorage.clear()
  setDetailsOpen(false)
  resetHints()
})

const buttonNamed = (host: ParentNode, name: string) => [...host.querySelectorAll('button')].find((button) => (button.textContent ?? '').replace(/\s+/g, ' ').trim() === name) ?? null
async function type(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const instructionsField = (host: ParentNode) => host.querySelector<HTMLTextAreaElement>('[aria-label="Instructions"]')!

describe('B3 instructions editor', () => {
  it('shows a live character and token counter', async () => {
    const view = mount(<Harness initial={draft({ instructions: 'x'.repeat(1200) })} />)
    await view.settle()
    expect(view.host.querySelector('#blob-instructions-count')?.textContent).toBe('1,200 characters, about 300 tokens')
    await type(instructionsField(view.host), 'abcd')
    expect(view.host.querySelector('#blob-instructions-count')?.textContent).toBe('4 characters, about 1 tokens')
  })

  it('applies a preset directly to an empty field', async () => {
    const applied: AgentDraft[] = []
    const view = mount(<Harness initial={draft({ instructions: '   ' })} onValue={(next) => applied.push(next)} />)
    await view.settle()
    await act(async () => { (buttonNamed(view.host, 'Test writer') as HTMLButtonElement).click() })
    expect(applied.at(-1)?.instructions).toContain('You write and repair tests')
    expect(buttonNamed(view.host, 'Replace')).toBeNull()
  })

  it('asks before replacing, then replaces or appends', async () => {
    const view = mount(<Harness initial={draft({ instructions: 'Keep me.' })} />)
    await view.settle()
    await act(async () => { (buttonNamed(view.host, 'Bug hunter') as HTMLButtonElement).click() })
    expect(buttonNamed(view.host, 'Replace')).not.toBeNull()
    expect(instructionsField(view.host).value).toBe('Keep me.')
    await act(async () => { (buttonNamed(view.host, 'Add to the end') as HTMLButtonElement).click() })
    expect(instructionsField(view.host).value.startsWith('Keep me.\n\nYou find and fix bugs.')).toBe(true)

    await act(async () => { (buttonNamed(view.host, 'Researcher') as HTMLButtonElement).click() })
    await act(async () => { (buttonNamed(view.host, 'Replace') as HTMLButtonElement).click() })
    expect(instructionsField(view.host).value.startsWith('You answer questions')).toBe(true)
  })

  it('lists the last five versions and restores one into the draft', async () => {
    for (const text of ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']) recordInstructionVersion('agent-1', text)
    const view = mount(<Harness initial={draft({ instructions: 'current' })} />)
    await view.settle()
    await act(async () => { (buttonNamed(view.host, 'History') as HTMLButtonElement).click() })
    const rows = [...view.host.querySelectorAll('.instructions-history-list li')]
    expect(rows).toHaveLength(5)
    expect(view.host.textContent).toContain('kept on this device')
    expect(rows[0].textContent).toContain('v6')
    expect(rows.at(-1)?.textContent).toContain('v2')
    await act(async () => { (rows[0].querySelector('button') as HTMLButtonElement).click() })
    expect(instructionsField(view.host).value).toBe('v6')
    expect(view.host.querySelector('.instructions-history-menu')).toBeNull()
  })
})

describe('B7 folder wording and recent folders', () => {
  it('renames the two project concepts', async () => {
    const view = mount(<Harness />)
    await view.settle()
    expect(view.host.textContent).toContain('Team project')
    expect(viewText(view.host)).toContain('Which project this bot belongs to on the team.')
    expect(view.host.textContent).toContain('Working folder')
    expect(viewText(view.host)).toContain('Where this bot works when you start a conversation.')
    expect(selectTrigger(view.host, 'Team project')).not.toBeNull()
    expect(view.host.textContent).not.toContain('Default project')
  })

  it('offers recent folders and the Browse button, remembering the choice', async () => {
    localStorage.setItem('bitbots.recentFolders', JSON.stringify(['C:/one', 'C:/two']))
    openProjectFolder.mockResolvedValue('C:/three')
    const view = mount(<Harness />)
    await view.settle()
    const options = (await selectOptions(view.host, 'Recent folders')).map((option) => option.value)
    expect(options).toEqual(['C:/one', 'C:/two'])
    await chooseOption(view.host, 'Recent folders', 'C:/two')
    expect(instructionsField(view.host)).not.toBeNull()
    expect(view.host.querySelector<HTMLInputElement>('[aria-label="Working folder"]')?.value).toBe('C:/two')

    await act(async () => { (buttonNamed(view.host, 'Browse…') as HTMLButtonElement).click() })
    await view.settle()
    expect(view.host.querySelector<HTMLInputElement>('[aria-label="Working folder"]')?.value).toBe('C:/three')
    expect(JSON.parse(localStorage.getItem('bitbots.recentFolders') ?? '[]')[0]).toBe('C:/three')
  })
})

describe('B8 permissions in plain language', () => {
  it('states what each mode does and counts recent auto-approvals', async () => {
    const view = mount(<Harness autoApprovals={[
      { summary: 'Read file', category: 'READ', mode: 'auto', sequence: 1 },
      { summary: 'Edit file', category: 'EDIT', mode: 'auto', sequence: 2 },
    ]} />)
    await view.settle()
    expect(view.host.textContent).toContain('Ask first')
    expect(view.host.textContent).toContain('nothing changes until you approve each action')
    expect(view.host.textContent).toContain('Approved without asking recently: 2 actions')
    const bypass = view.host.querySelector('[role="radio"][data-mode="bypass"]')!
    expect(bypass.classList.contains('warning')).toBe(true)
    expect(view.host.querySelector('[role="radio"][data-mode="ask"]')?.classList.contains('warning')).toBe(false)
  })
})

describe('B9 memory and activity', () => {
  it('hides the group while memory is off and shows notes when it is on', async () => {
    rpc.mockImplementation(async (method: string) => method === 'memory.list'
      ? { records: [{ id: 'm1', scope: 'blob', scopeId: 'agent-1', kind: 'fact', title: 'Prefers tabs', body: 'Use tabs.', origin: 'user', reviewed: true, version: 1 }] }
      : answer(method))
    const off = mount(<Harness memoryEnabled={false} />)
    await off.settle()
    expect(off.host.querySelector('#bot-section-memory')).toBeNull()
    off.unmount()

    const on = mount(<Harness memoryEnabled onOpenMemory={() => undefined} />)
    await on.settle()
    expect(on.host.querySelector('#bot-section-memory')?.textContent).toContain('Prefers tabs')
    expect(on.host.querySelector('#bot-section-memory')?.textContent).toContain('Open in Settings › Memory')
  })

  it('shows an empty state and a one-line activity summary from sessions', async () => {
    const sessions = [
      { id: 's1', runtimeId: 'rt-1', agentId: 'agent-1', updatedAt: '2026-10-02T11:00:00.000Z' },
      { id: 's2', runtimeId: 'rt-1', agentId: 'agent-1', updatedAt: '2026-10-02T11:30:00.000Z' },
      { id: 's3', runtimeId: 'rt-1', agentId: 'agent-2', updatedAt: '2026-10-02T11:45:00.000Z' },
    ] as Session[]
    const view = mount(<Harness memoryEnabled sessions={sessions} />)
    await view.settle()
    const group = view.host.querySelector('#bot-section-memory')!
    expect(group.textContent).toContain('No notes yet')
    expect(group.textContent).toContain('2 conversations')
    expect(group.textContent).toContain('last active')
  })

  it('reads the experimental.memory setting when no override is given and links to Settings', async () => {
    rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings: { 'experimental.memory': true } } : answer(method))
    const opened = vi.fn()
    const view = mount(<Harness onOpenMemory={opened} />)
    await view.settle()
    expect(view.host.querySelector('#bot-section-memory')).not.toBeNull()
    await act(async () => { (buttonNamed(view.host, 'Open in Settings › Memory') as HTMLButtonElement).click() })
    expect(opened).toHaveBeenCalled()
  })
})

describe('B10 technical details disclosure', () => {
  it('starts closed, opens on click and remembers the choice', async () => {
    const view = mount(<Harness />)
    await view.settle()
    const toggle = view.host.querySelector<HTMLButtonElement>('.details-toggle')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect((view.host.querySelector('#bot-details-content') as HTMLElement).hidden).toBe(true)
    await act(async () => { toggle.click() })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect((view.host.querySelector('#bot-details-content') as HTMLElement).hidden).toBe(false)
    expect(localStorage.getItem('bitbots.botPage.detailsOpen')).toBe('true')
  })
})

describe('B11 sections prop', () => {
  it('renders only the groups it is given', async () => {
    const view = mount(<Harness sections={['profile', 'permissions']} />)
    await view.settle()
    expect(view.host.querySelector('#bot-section-profile')).not.toBeNull()
    expect(view.host.querySelector('#bot-section-permissions')).not.toBeNull()
    expect(view.host.querySelector('#bot-section-look')).toBeNull()
    expect(view.host.querySelector('#bot-section-model')).toBeNull()
  })

  it('renders every group by default', async () => {
    const view = mount(<Harness memoryEnabled />)
    await view.settle()
    for (const id of ['look', 'profile', 'team', 'model', 'permissions', 'notifications', 'details', 'memory']) {
      expect(view.host.querySelector(`#bot-section-${id}`), id).not.toBeNull()
    }
  })
})
