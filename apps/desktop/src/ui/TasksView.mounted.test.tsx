// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, BoardTask } from '../types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const calls: Array<{ method: string; params: Record<string, unknown> }> = []
let listed: BoardTask[] = []
vi.mock('../tauri', () => ({
  rpc: vi.fn(async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    if (method === 'task.list') return { tasks: listed }
    if (method === 'automation.preview') return { utc: ['2026-10-26T09:00:00.000Z', '2026-10-27T09:00:00.000Z'], local: [] }
    if (method === 'task.image') return { dataUrl: 'data:image/png;base64,AAAA' }
    if (method === 'task.create') return { task: { ...base('new-1', 'unassigned'), title: String(params.title) } }
    if (method === 'task.update') return { task: { ...(listed.find((item) => item.id === params.taskId) as BoardTask), title: String(params.title), version: 3 } }
    if (method === 'task.dispatch') return { task: { ...base('new-1', 'running'), assigneeAgentId: params.assigneeAgentId }, disposition: 'started', queuePosition: null, reason: null, replayed: false }
    return {}
  }),
  listenForDaemonEvents: vi.fn(async () => () => undefined),
  stagePromptAttachment: vi.fn(async () => 'C:/staged/shot.png'),
}))
const { TasksView } = await import('./TasksView')

const agent = (id: string, name: string): Agent => ({ id, name, color: '#82aaff', runtimeId: 'runtime-codex', sortOrder: 0, archived: false } as Agent)
const AGENTS = [agent('a1', 'Codex'), agent('a2', 'Claude')]
function base(id: string, state: BoardTask['state'], extra: Partial<BoardTask> = {}): BoardTask {
  return { id, title: `Task ${id}`, brief: '', doneGoal: '', reportBack: '', projectId: null, assigneeAgentId: null, supervisionPolicy: 'report_only', state, version: 1, createdAt: '2026-10-21T10:00:00Z', updatedAt: '2026-10-21T10:00:00Z', ...extra }
}

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  calls.length = 0
  listed = []
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  if (!URL.createObjectURL) Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:preview' })
  if (!URL.revokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined })
})
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.querySelectorAll('.select-menu').forEach((node) => node.remove()) })

const flush = async () => { await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const mount = async () => {
  act(() => root.render(<TasksView agents={AGENTS} projects={[]} runtimes={[]} connected onBack={() => undefined} onOpenSession={() => undefined} />))
  await flush()
}
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')!
const button = (label: string, within: ParentNode = document.body) => [...within.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)!
const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const choose = async (trigger: string, option: string) => {
  act(() => dialog().querySelector<HTMLButtonElement>(`.select-trigger[aria-label^="${trigger}"]`)!.click())
  act(() => [...document.body.querySelectorAll<HTMLElement>('.select-option')].find((item) => item.textContent?.includes(option))!.click())
  await flush()
}
const last = (method: string) => [...calls].reverse().find((call) => call.method === method)

describe('Tasks page forms', () => {
  it('saves a repeating task with its bot, an image and a time limit, and shows the missed-run note', async () => {
    await mount()
    act(() => button('New task', host).click())
    await flush()
    type(dialog().querySelector<HTMLInputElement>('input[data-dialog-initial-focus]')!, 'Nightly check')
    expect(dialog().textContent).not.toContain('Runs only while Bitbots is open')
    act(() => button('Repeat', dialog()).click())
    await flush()
    expect(dialog().textContent).toContain('Runs only while Bitbots is open and this computer is on and awake.')
    expect(dialog().textContent).toContain('skipped, not run late')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)) })
    expect(dialog().textContent).toContain('Next: ')
    expect(button('Add task', dialog()).disabled).toBe(true)
    expect(dialog().textContent).toContain('Choose the bot that runs this task.')
    await choose('Bot', 'Claude')
    await choose('Stop a run after', '2 hours')
    const form = dialog().querySelector('.task-form')!
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown }
    paste.clipboardData = { files: [new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })], items: [] }
    await act(async () => { form.dispatchEvent(paste); await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(dialog().querySelectorAll('.composer-attachment')).toHaveLength(1)
    act(() => button('Add task', dialog()).click())
    await flush()
    const created = last('task.create')!.params
    expect(created).toMatchObject({ title: 'Nightly check', projectId: null, maxRuntimeSecs: 7200, scheduleAgentId: 'a2', attachments: [{ path: 'C:/staged/shot.png', name: 'shot.png' }] })
    expect((created.schedule as { kind: string; cron: string }).kind).toBe('cron')
    expect((created.schedule as { cron: string }).cron).toBe('0 9 * * *')
    expect(last('task.dispatch')).toBeUndefined()
  })

  it('creates and starts a task straight away when "Now" and a bot are chosen', async () => {
    await mount()
    act(() => button('New task', host).click())
    await flush()
    type(dialog().querySelector<HTMLInputElement>('input[data-dialog-initial-focus]')!, 'Do it now')
    await choose('Bot', 'Codex')
    expect(button('Add and start', dialog())).toBeTruthy()
    act(() => button('Add and start', dialog()).click())
    await flush()
    expect(last('task.create')!.params).toMatchObject({ title: 'Do it now', schedule: null, scheduleAgentId: null })
    expect(last('task.dispatch')!.params).toMatchObject({ taskId: 'new-1', assigneeAgentId: 'a1' })
  })

  it('opens a draft in the editor with its images and schedule, keeps images by id, and lists scheduled tasks apart from drafts', async () => {
    listed = [
      base('draft-1', 'unassigned', { title: 'Write notes', brief: 'Summarise', images: [{ id: 'img-1', name: 'before.png', mediaType: 'image/png' }], maxRuntimeSecs: 3600 }),
      base('sched-1', 'unassigned', { title: 'Every morning', schedule: { kind: 'cron', cron: '0 9 * * 1-5', timezone: 'UTC' }, scheduleAgentId: 'a1', scheduleState: 'active', scheduleNextAt: '2026-10-26T09:00:00.000Z', scheduleLastOutcome: 'skipped_late' }),
    ]
    await mount()
    expect(host.querySelectorAll('.delegate-draft')).toHaveLength(1)
    expect(host.querySelector('.delegate-scheduled-card')!.textContent).toContain('Every morning')
    expect(host.querySelector('.delegate-scheduled-card')!.textContent).toContain('Weekdays at 09:00')
    expect(host.querySelector('.delegate-scheduled-card')!.textContent).toContain('Skipped: more than five minutes late')
    act(() => host.querySelector<HTMLButtonElement>('.delegate-draft-main')!.click())
    await flush()
    expect(dialog().querySelector<HTMLInputElement>('input[data-dialog-initial-focus]')!.value).toBe('Write notes')
    expect(dialog().querySelectorAll('.composer-attachment')).toHaveLength(1)
    expect(dialog().querySelector('.composer-attachment img')!.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    type(dialog().querySelector<HTMLInputElement>('input[data-dialog-initial-focus]')!, 'Write the notes')
    act(() => button('Save', dialog()).click())
    await flush()
    expect(last('task.update')!.params).toMatchObject({ taskId: 'draft-1', expectedVersion: 1, title: 'Write the notes', maxRuntimeSecs: 3600, attachments: [{ id: 'img-1' }], schedule: null })
    act(() => host.querySelector<HTMLButtonElement>('.delegate-scheduled-card')!.click())
    await flush()
    expect(dialog().textContent).toContain('Last time: Skipped: more than five minutes late.')
    expect(button('Repeat', dialog()).getAttribute('aria-checked')).toBe('true')
  })
})
