// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Project, Runtime } from '../types'
import { TeamSidebar, type TeamSidebarActions } from './TeamSidebar'

const h = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../tauri', () => ({ rpc: h.rpc, inDesktop: false, previewMode: false }))

import { fetchCached, resetCatalogCacheForTests } from './catalogCache'

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
  resetCatalogCacheForTests()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  host = null
})

function mount(list: TeamSidebarActions, props: { agents?: Agent[]; botLock?: boolean; sidebarModel?: boolean; runtimes?: Runtime[] } = {}) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(<TeamSidebar agents={props.agents ?? [alpha, beta, gamma]} projects={projects} sessions={[]} runtimes={props.runtimes ?? []} botLock={props.botLock} sidebarModel={props.sidebarModel} connected now={Date.now()} pinnedIds={[]} unreadSessionIds={new Set()} approvalSessionIds={new Set()} selectedAgentId="agent-beta" onOpenSearch={vi.fn()} actions={list} />))
  return host
}

function row(view: HTMLElement, id: string) {
  return view.querySelector<HTMLButtonElement>(`.team-row[data-agent-id="${id}"]`)!
}

describe('bot lock (FIX39 item 13)', () => {
  const openMenu = async (view: HTMLElement, id: string) => {
    await act(async () => { row(view, id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })) })
    return view.querySelector<HTMLElement>('.team-menu')!
  }

  it('offers Lock bot only while the feature is on, and calls the action', async () => {
    const list = actions()
    const view = mount(list, { botLock: true })
    const menu = await openMenu(view, 'agent-alpha')
    const item = [...menu.querySelectorAll<HTMLButtonElement>('.team-menu-item')].find((button) => button.textContent === 'Lock bot')
    expect(item).toBeTruthy()
    await act(async () => { item!.click() })
    expect(list.onToggleLock).toHaveBeenCalledWith(alpha)
  })

  it('always offers Unlock for a locked bot, even when the switch is off, and freezes its settings', async () => {
    const list = actions()
    const lockedAlpha = agent({ ...alpha, locked: true })
    const view = mount(list, { agents: [lockedAlpha, beta, gamma] })
    expect(row(view, 'agent-alpha').querySelector('.lock-badge')).not.toBeNull()
    const menu = await openMenu(view, 'agent-alpha')
    const labels = [...menu.querySelectorAll<HTMLButtonElement>('.team-menu-item')]
    expect(labels.find((button) => button.textContent === 'Unlock bot')).toBeTruthy()
    // Rename, Edit, Archive and Move to are refused while locked.
    for (const label of ['Rename bot', 'Edit bot', 'Archive', 'Move to']) {
      expect(labels.find((button) => button.textContent === label)?.disabled, label).toBe(true)
    }
    // Placement the owner expects to keep working stays enabled.
    expect(labels.find((button) => button.textContent === 'Pin')?.disabled).toBe(false)
  })

  it('shows the model and effort line for an idle bot when the model-line experiment is on', () => {
    const view = mount(actions(), { sidebarModel: true, runtimes: [{ id: 'rt', provider: 'codex', status: 'ready' }] })
    const preview = row(view, 'agent-beta').querySelector('.bot-row-preview')
    expect(preview?.textContent).toBe('Default model')
  })

  // FIX39 item 12 / P5 audit S7: the row reads the shared catalog cache, so it
  // must repaint when the catalog lands instead of keeping the raw model id.
  it('names the catalog model once it arrives, and the raw id before that', async () => {
    const modelled = agent({ id: 'agent-modelled', name: 'Modelled', runtimeId: 'rt', sortOrder: 3, projectId: 'p1', model: 'claude-sonnet-5-5', thinking: 'high' })
    const view = mount(actions(), { sidebarModel: true, agents: [modelled, beta, gamma], runtimes: [{ id: 'rt', provider: 'claude', status: 'ready' }] })
    expect(row(view, 'agent-modelled').querySelector('.bot-row-preview')?.textContent).toBe('claude-sonnet-5-5 · High')
    h.rpc.mockResolvedValue({
      runtimeId: 'rt', provider: 'claude', validated: true, fallback: false, models: [
        { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', supportedThinking: ['low', 'high'], defaultThinking: 'high', serviceTiers: [], defaultServiceTier: null, variants: [], hostDependent: false, isDefault: true, group: null, availability: 'offered' },
      ],
    })
    await act(async () => { await fetchCached('runtime.models', { runtimeId: 'rt' }) })
    expect(row(view, 'agent-modelled').querySelector('.bot-row-preview')?.textContent).toBe('Sonnet 5.5 · High')
  })

  it('does not start a drag for a locked bot', async () => {
    const list = actions()
    const lockedAlpha = agent({ ...alpha, locked: true })
    const view = mount(list, { agents: [lockedAlpha, beta, gamma] })
    const target = row(view, 'agent-alpha')
    await act(async () => { target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 10, clientY: 10 })) })
    await act(async () => { target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 40, clientY: 12 })) })
    await act(async () => { target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 40, clientY: 12 })) })
    expect(target.className).not.toContain('dragging')
    expect(list.onPlace).not.toHaveBeenCalled()
    expect(list.onMove).not.toHaveBeenCalled()
  })
})

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
