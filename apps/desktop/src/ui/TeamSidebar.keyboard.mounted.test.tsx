// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Project } from '../types'
import { TeamSidebar, type TeamSidebarActions } from './TeamSidebar'

function agent(partial: Pick<Agent, 'id' | 'name' | 'runtimeId' | 'sortOrder'> & Partial<Agent>): Agent {
  return {
    description: '', instructions: '', color: 'mint', model: null, thinking: null, serviceTier: null,
    customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, archived: false,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...partial,
  }
}

const alpha = agent({ id: 'agent-alpha', name: 'Alpha', runtimeId: 'rt', sortOrder: 0, projectId: 'p1' })
const beta = agent({ id: 'agent-beta', name: 'Beta', runtimeId: 'rt', sortOrder: 1, projectId: 'p1' })
const gamma = agent({ id: 'agent-gamma', name: 'Gamma', runtimeId: 'rt', sortOrder: 2, projectId: 'p2' })
const projects: Project[] = [
  { id: 'p1', name: 'Korus', path: null, sortOrder: 0 },
  { id: 'p2', name: 'Site', path: null, sortOrder: 1 },
]

function actions(overrides: Partial<TeamSidebarActions> = {}): TeamSidebarActions {
  return {
    onSelect: vi.fn(), onCreate: vi.fn(), onCreateProject: vi.fn(), onEdit: vi.fn(), onArchive: vi.fn(),
    onDuplicate: vi.fn(), onExportBlob: vi.fn(), onRename: vi.fn(), onTogglePin: vi.fn(), onMove: vi.fn(),
    onReorder: vi.fn(), onPlace: vi.fn(), onSetHidden: vi.fn(), onToggleUnread: vi.fn(),
    onCopyConversationId: vi.fn(), onDeleteConversation: vi.fn(), onRenameProject: vi.fn(), onChangeProjectFolder: vi.fn(),
    onDeleteProject: vi.fn(), onToggleProjectCollapsed: vi.fn(), onOpenRuntimeSettings: vi.fn(),
    ...overrides,
  }
}

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true })

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  host = null
})

function mount(list: TeamSidebarActions) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(<TeamSidebar agents={[alpha, beta, gamma]} projects={projects} sessions={[]} runtimes={[]} connected now={Date.now()} pinnedIds={[]} unreadSessionIds={new Set()} approvalSessionIds={new Set()} selectedAgentId="agent-beta" query="" onQueryChange={vi.fn()} actions={list} />))
  return host
}

function row(view: HTMLElement, id: string) {
  return view.querySelector<HTMLButtonElement>(`.team-row[data-agent-id="${id}"]`)!
}

describe('roster keyboard moves', () => {
  it('moves a blob a step inside its project with Alt+Arrow', async () => {
    const list = actions()
    const view = mount(list)
    await act(async () => { row(view, 'agent-beta').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true })) })
    expect(list.onReorder).toHaveBeenCalledWith(beta, -1)
    await act(async () => { row(view, 'agent-beta').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true })) })
    expect(list.onReorder).toHaveBeenLastCalledWith(beta, 1)
    expect(list.onSelect).not.toHaveBeenCalled()
    expect(view.querySelector('[role="status"]')?.textContent).toBe('Moved Beta down.')
  })

  it('opens a Move to project menu with Alt+Shift+ArrowRight and moves on choosing', async () => {
    const list = actions()
    const view = mount(list)
    await act(async () => { row(view, 'agent-gamma').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, shiftKey: true, bubbles: true })) })
    const menu = view.querySelector('[role="menu"][aria-label="Move Gamma to a project"]')!
    expect(menu).not.toBeNull()
    expect([...menu.querySelectorAll<HTMLButtonElement>('.team-menu-item')].map((item) => item.textContent)).toEqual(['Korus', 'Site', 'Unassigned'])
    await act(async () => { [...menu.querySelectorAll<HTMLButtonElement>('.team-menu-item')].find((item) => item.textContent === 'Korus')!.click() })
    expect(list.onMove).toHaveBeenCalledWith(gamma, 'p1')
    expect(view.querySelector('[role="status"]')?.textContent).toBe('Moved Gamma to Korus.')
  })

  it('keeps a plain arrow key on the focus path, not the move path', async () => {
    const list = actions()
    const view = mount(list)
    row(view, 'agent-beta').focus()
    await act(async () => { row(view, 'agent-beta').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    expect(list.onReorder).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(row(view, 'agent-alpha'))
  })
})
