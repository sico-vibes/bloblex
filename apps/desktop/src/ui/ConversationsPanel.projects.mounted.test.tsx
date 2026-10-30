// @vitest-environment happy-dom
// Phase 1A: a bot works in every project, so its conversations are grouped by
// project in the conversations panel, which also owns the project menu (rename,
// folder, tags, delete) and the project picker for a new conversation.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Project, Session } from '../types'
import { ConversationsPanel, type ProjectActions } from './ConversationsPanel'

const h = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../tauri', () => ({ rpc: h.rpc, inDesktop: false, previewMode: false }))

const bot: Agent = {
  id: 'agent-alpha', name: 'Alpha', runtimeId: 'rt', sortOrder: 0, projectId: 'p1',
  description: '', instructions: '', color: 'mint', model: null, thinking: null, serviceTier: null,
  customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, archived: false,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
}
const projects: Project[] = [
  { id: 'p1', name: 'Korus', path: 'D:\\korus', sortOrder: 0, tags: ['ui', 'backend'] },
  { id: 'p2', name: 'Site', path: 'D:\\site', sortOrder: 1 },
]
const said = [{ id: 'm1', role: 'user', text: 'hi' }] as Session['messages']
function conversation(id: string, title: string, projectId: string | null, updatedAt: string): Session {
  return { id, runtimeId: 'rt', agentId: bot.id, title, projectId, messages: said, createdAt: updatedAt, updatedAt }
}
const sessions = [
  conversation('s1', 'Korus layout', 'p1', '2026-10-29T10:00:00.000Z'),
  conversation('s2', 'Site copy', 'p2', '2026-10-29T12:00:00.000Z'),
  conversation('s3', 'Just chatting', null, '2026-10-28T09:00:00.000Z'),
]

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  h.rpc.mockReset()
  h.rpc.mockResolvedValue({})
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  host = null
})

function projectActions(): ProjectActions {
  return { onCreateProject: vi.fn(), onRenameProject: vi.fn(), onChangeProjectFolder: vi.fn(), onDeleteProject: vi.fn() }
}

function mount(onNew = vi.fn(), actions = projectActions()) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(<ConversationsPanel agent={bot} agents={[bot]} projects={projects} sessions={sessions} selectedSessionId={null} sideSessionId={null} canCreate
    onSelect={vi.fn()} onOpenSide={vi.fn()} onNew={onNew} projectActions={actions} onRename={vi.fn()} onDelete={vi.fn()} />))
  return host
}

function menuItem(view: HTMLElement, label: string) {
  return [...view.querySelectorAll<HTMLButtonElement>('.team-menu .team-menu-item')].find((button) => button.textContent === label)
}

describe('conversations by project (Phase 1A)', () => {
  it('groups conversations under their project, most recent project first', () => {
    const view = mount()
    const groups = [...view.querySelectorAll<HTMLElement>('.convo-project')]
    expect(groups.map((group) => group.dataset.projectId)).toEqual(['p2', 'p1', 'none'])
    expect(groups.map((group) => group.querySelector('.convo-project-name')?.textContent)).toEqual(['Site', 'Korus', 'No project'])
    expect(groups[1].querySelector('.convo-title')?.textContent).toBe('Korus layout')
  })

  it('shows a project\u2019s tags as chips on its heading', () => {
    const view = mount()
    const chips = [...view.querySelectorAll('.convo-project[data-project-id="p1"] .project-tag')].map((chip) => chip.textContent)
    expect(chips).toEqual(['ui', 'backend'])
  })

  it('edits a project\u2019s tags through project.update from the project menu', async () => {
    const view = mount()
    await act(async () => { view.querySelector<HTMLButtonElement>('button[aria-label="Korus options"]')!.click() })
    await act(async () => { menuItem(view, 'Tags…')!.click() })
    const dialog = view.querySelector<HTMLElement>('.tag-editor')!
    expect(dialog).toBeTruthy()
    await act(async () => { dialog.querySelector<HTMLButtonElement>('button[aria-label="Remove ui"]')!.click() })
    await act(async () => { [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Save tags')!.click() })
    expect(h.rpc).toHaveBeenCalledWith('project.update', { projectId: 'p1', tags: ['backend'] })
    expect(view.querySelector('.tag-editor')).toBeNull()
  })

  it('starts a conversation in a project from its heading and from the picker', async () => {
    const onNew = vi.fn()
    const view = mount(onNew)
    await act(async () => { view.querySelector<HTMLButtonElement>('button[aria-label="New conversation in Site"]')!.click() })
    expect(onNew).toHaveBeenLastCalledWith('p2')
    await act(async () => { view.querySelector<HTMLButtonElement>('button[aria-label="Choose the project for a new conversation"]')!.click() })
    await act(async () => { menuItem(view, 'No project')!.click() })
    expect(onNew).toHaveBeenLastCalledWith(null)
    // The plain button starts where the bot's next conversation goes (its default project).
    expect(view.querySelector('.convo-new-where')?.textContent).toBe('Korus')
    await act(async () => { view.querySelector<HTMLButtonElement>('button.convo-new')!.click() })
    expect(onNew).toHaveBeenLastCalledWith()
  })

  it('routes rename, folder and delete through the project actions', async () => {
    const actions = projectActions()
    const view = mount(vi.fn(), actions)
    for (const [label, handler] of [['Rename project', actions.onRenameProject], ['Change folder…', actions.onChangeProjectFolder], ['Delete project', actions.onDeleteProject]] as const) {
      await act(async () => { view.querySelector<HTMLButtonElement>('button[aria-label="Site options"]')!.click() })
      await act(async () => { menuItem(view, label)!.click() })
      expect(handler).toHaveBeenCalledWith(projects[1])
    }
  })
})
