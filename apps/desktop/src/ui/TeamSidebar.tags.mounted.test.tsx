// @vitest-environment happy-dom
// FIX39 item 21: the owner's tag editor on a project and on a bot.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Project, Runtime } from '../types'
import { TeamSidebar, type TeamSidebarActions } from './TeamSidebar'

const h = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../tauri', () => ({ rpc: h.rpc, inDesktop: false, previewMode: false }))

import { resetCatalogCacheForTests } from './catalogCache'

function agent(partial: Pick<Agent, 'id' | 'name' | 'runtimeId' | 'sortOrder'> & Partial<Agent>): Agent {
  return {
    description: '', instructions: '', color: 'mint', model: null, thinking: null, serviceTier: null,
    customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, archived: false,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...partial,
  }
}

const alpha = agent({ id: 'agent-alpha', name: 'Alpha', runtimeId: 'rt', sortOrder: 0, projectId: 'p1', tags: ['reviewer'] })
const beta = agent({ id: 'agent-beta', name: 'Beta', runtimeId: 'rt', sortOrder: 1, projectId: 'p1' })
const locked = agent({ id: 'agent-locked', name: 'Frozen', runtimeId: 'rt', sortOrder: 2, projectId: 'p2', locked: true })
const projects: Project[] = [
  { id: 'p1', name: 'Korus', path: null, sortOrder: 0, tags: ['ui', 'backend'] },
  { id: 'p2', name: 'Site', path: null, sortOrder: 1 },
]

function actions(overrides: Partial<TeamSidebarActions> = {}): TeamSidebarActions {
  return {
    onSelect: vi.fn(), onCreate: vi.fn(), onCreateProject: vi.fn(), onEdit: vi.fn(), onArchive: vi.fn(),
    onDuplicate: vi.fn(), onExportBlob: vi.fn(), onRename: vi.fn(), onTogglePin: vi.fn(), onMove: vi.fn(),
    onReorder: vi.fn(), onPlace: vi.fn(), onSetHidden: vi.fn(), onToggleLock: vi.fn(), onToggleUnread: vi.fn(),
    onCopyConversationId: vi.fn(), onDeleteConversation: vi.fn(), onRenameProject: vi.fn(), onChangeProjectFolder: vi.fn(),
    onDeleteProject: vi.fn(), onToggleProjectCollapsed: vi.fn(), onOpenRuntimeSettings: vi.fn(),
    ...overrides,
  }
}

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  h.rpc.mockReset()
  h.rpc.mockResolvedValue({})
  resetCatalogCacheForTests()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  host = null
})

function mount(list: TeamSidebarActions) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(<TeamSidebar agents={[alpha, beta, locked]} projects={projects} sessions={[]} runtimes={[] as Runtime[]} connected now={Date.now()} pinnedIds={[]} unreadSessionIds={new Set()} approvalSessionIds={new Set()} selectedAgentId="agent-beta" onOpenSearch={vi.fn()} actions={list} />))
  return host
}

function row(view: HTMLElement, id: string) {
  return view.querySelector<HTMLButtonElement>(`.team-row[data-agent-id="${id}"]`)!
}

async function openBlobMenu(view: HTMLElement, id: string) {
  await act(async () => { row(view, id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })) })
  return view.querySelector<HTMLElement>('.team-menu')!
}

function menuItem(menu: HTMLElement, label: string) {
  return [...menu.querySelectorAll<HTMLButtonElement>('.team-menu-item')].find((button) => button.textContent === label)
}

describe('tags (FIX39 item 21)', () => {
  it('shows a project\u2019s tags as chips in the sidebar', () => {
    const view = mount(actions())
    const chips = [...view.querySelectorAll('.project-tag')].map((chip) => chip.textContent)
    expect(chips).toEqual(['ui', 'backend'])
  })

  it('edits a bot\u2019s tags through agent.team.update', async () => {
    const view = mount(actions())
    const menu = await openBlobMenu(view, 'agent-alpha')
    await act(async () => { menuItem(menu, 'Tags…')!.click() })
    const dialog = view.querySelector<HTMLElement>('.tag-editor')!
    expect(dialog).toBeTruthy()
    const input = dialog.querySelector<HTMLInputElement>('input[aria-label="New tag"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Payments')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Add')!.click() })
    expect([...dialog.querySelectorAll('.tag-chip')].map((chip) => chip.textContent)).toEqual(['reviewer', 'payments'])
    await act(async () => { [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Save tags')!.click() })
    expect(h.rpc).toHaveBeenCalledWith('agent.team.update', { agentId: 'agent-alpha', tags: ['reviewer', 'payments'] })
    expect(view.querySelector('.tag-editor')).toBeNull()
  })

  it('edits a project\u2019s tags through project.update', async () => {
    const view = mount(actions())
    const toggle = view.querySelector<HTMLButtonElement>('.team-group[data-project-id="p1"] .team-group-toggle')!
    await act(async () => { toggle.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })) })
    const menu = view.querySelector<HTMLElement>('.team-menu')!
    await act(async () => { menuItem(menu, 'Tags…')!.click() })
    const dialog = view.querySelector<HTMLElement>('.tag-editor')!
    // Remove 'ui', keep 'backend'.
    await act(async () => { dialog.querySelector<HTMLButtonElement>('button[aria-label="Remove ui"]')!.click() })
    await act(async () => { [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Save tags')!.click() })
    expect(h.rpc).toHaveBeenCalledWith('project.update', { projectId: 'p1', tags: ['backend'] })
  })

  it('disables Tags on a locked bot', async () => {
    const view = mount(actions())
    const menu = await openBlobMenu(view, 'agent-locked')
    // FIX39 item 13: a locked bot keeps its tags, so the entry is disabled.
    expect(menuItem(menu, 'Tags…')?.disabled).toBe(true)
  })
})
