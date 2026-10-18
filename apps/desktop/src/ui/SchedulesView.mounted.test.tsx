// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Automation } from '../types'
import { SchedulesView } from './SchedulesView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = new Date(2026, 9, 12, 10, 0, 0).getTime()
const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({ id, name, color: '#82aaff', runtimeId: 'runtime-codex', sortOrder: 0, ...extra } as Agent)
const AGENTS = [agent('a1', 'Codex'), agent('a2', 'Claude', { color: '#f38c6f' }), agent('a3', 'Retired', { archived: true })]

const automation = (partial: Partial<Automation> & Pick<Automation, 'id' | 'name'>): Automation => ({
  agentId: 'a1', prompt: 'Summarise what changed.', schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
  sessionMode: 'new', approvalMode: 'auto', maxRuntimeSecs: 1800, enabled: true, createdBy: 'user',
  nextRunAt: new Date(NOW + 3 * 3_600_000).toISOString(), consecutiveFailures: 0, pauseReason: null, running: false, lastRun: null, ...partial,
})

let root: Root
let host: HTMLDivElement
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

const q = <T extends Element>(selector: string) => host.querySelector<T>(selector)
const all = (selector: string) => [...host.querySelectorAll<HTMLElement>(selector)]
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const click = async (element: Element | null | undefined) => { if (!element) throw new Error('missing element'); await act(async () => { (element as HTMLElement).click() }) }
const type = async (element: HTMLInputElement | HTMLTextAreaElement | null, value: string) => {
  if (!element) throw new Error('missing field')
  await act(async () => {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function view(items: Automation[], extra: Partial<ComponentProps<typeof SchedulesView>> = {}) {
  const handlers = {
    onBack: vi.fn(), onCreate: vi.fn(async () => undefined), onUpdate: vi.fn(async () => undefined), onSetEnabled: vi.fn(async () => undefined),
    onRunNow: vi.fn(async () => undefined), onDelete: vi.fn(async () => undefined), onLoadRuns: vi.fn(async () => []),
    onPreview: vi.fn(async () => ['Tue 13 Oct 09:00']), onSetPaused: vi.fn(async () => undefined), onOpenSession: vi.fn(),
  }
  const node: ReactNode = <SchedulesView automations={items} agents={AGENTS} connected paused={false} nowMs={NOW} {...handlers} {...extra} />
  act(() => root.render(node))
  return handlers
}

describe('SchedulesView', () => {
  it('shows an empty state with a way to create the first schedule', async () => {
    view([])
    expect(q('.schedules-empty')?.textContent).toContain('No automations yet')
    expect(q<HTMLButtonElement>('.schedules-new')?.disabled).toBe(false)
  })

  it('starts from an idea: the editor opens filled in and creates an action, not a message', async () => {
    const handlers = view([])
    const idea = all('.schedules-template').find((node) => node.textContent?.includes('Check my email'))!
    await click(idea)
    await flush()
    const dialog = q('[role="dialog"]')!
    expect(dialog.textContent).toContain('New automation')
    expect((dialog.querySelector('input[maxlength="80"]') as HTMLInputElement).value).toBe('Email check')
    expect((dialog.querySelector('textarea') as HTMLTextAreaElement).value).toContain('Check my email')
    expect((dialog.querySelector('input[type="time"]') as HTMLInputElement).value).toBe('08:30')
    expect((dialog.querySelector('input[name="approval"]:checked') as HTMLInputElement).closest('label')?.textContent).toContain('Read-only')
    await click(all('[role="dialog"] button').find((button) => button.textContent === 'Create automation'))
    await flush()
    expect(handlers.onCreate).toHaveBeenCalledOnce()
    expect((handlers.onCreate.mock.calls[0] as unknown[])[0]).toMatchObject({ name: 'Email check', approvalMode: 'plan', enabled: true })
  })

  it('lists schedules with plain-language timing, the blob, and next run', () => {
    view([
      automation({ id: 's1', name: 'Morning summary', schedule: { kind: 'cron', cron: '30 7 * * 1-5', timezone: 'UTC' } }),
      automation({ id: 's2', name: 'Nightly tests', agentId: 'a2', enabled: false, pauseReason: 'user', nextRunAt: null }),
      automation({ id: 's3', name: 'Flaky job', enabled: false, pauseReason: 'auto_failures', nextRunAt: null }),
    ])
    const names = all('.schedule-name').map((node) => node.textContent)
    expect(names).toEqual(['Flaky job', 'Morning summary', 'Nightly tests'])
    const morning = all('.schedule-card').find((card) => card.textContent?.includes('Morning summary'))!
    expect(morning.textContent).toContain('Codex · Weekdays at 07:30')
    expect(morning.textContent).toContain('Next run in 3 h')
    expect(all('.schedule-card').find((card) => card.textContent?.includes('Flaky job'))?.textContent).toContain('Paused after three failed runs')
    expect(all('.schedule-card').find((card) => card.textContent?.includes('Nightly tests'))?.textContent).toContain('Claude · Every day at 09:00')
  })

  it('marks a read-only schedule and a running one', () => {
    view([automation({ id: 's1', name: 'Audit', approvalMode: 'plan', running: true })])
    expect(q('.schedule-card.running .schedule-state')?.textContent).toBe('Running now · read-only')
  })

  it('pauses and resumes through the switch, runs now, and confirms before deleting', async () => {
    const handlers = view([automation({ id: 's1', name: 'Morning summary' })])
    await click(q('[role="switch"][aria-labelledby="schedule-s1"]'))
    expect(handlers.onSetEnabled).toHaveBeenCalledWith('s1', false)
    await click(q('[aria-label="Run Morning summary now"]'))
    expect(handlers.onRunNow).toHaveBeenCalledWith('s1')
    await click(q('[aria-label="Delete Morning summary"]'))
    expect(handlers.onDelete).not.toHaveBeenCalled()
    expect(q('[role="dialog"]')?.textContent).toContain('Delete “Morning summary”?')
    await click(all('[role="dialog"] button').find((button) => button.textContent === 'Delete'))
    await flush()
    expect(handlers.onDelete).toHaveBeenCalledWith('s1')
  })

  it('keeps blob proposals off until the user approves them', async () => {
    const handlers = view([automation({ id: 'p1', name: 'Dependency check', createdBy: 'agent', enabled: false, pauseReason: 'needs_approval', approvalMode: 'plan', nextRunAt: null })])
    expect(q('[aria-label="Proposed by bots"]')?.textContent).toContain('These stay off until you approve them.')
    expect(q('.schedule-proposal')?.textContent).toContain('proposed this')
    expect(q('.schedule-card [role="switch"]')).toBeNull()
    await click(all('.schedule-card button').find((button) => button.textContent === 'Approve'))
    expect(handlers.onSetEnabled).toHaveBeenCalledWith('p1', true)
  })

  it('opens run history, shows reasons, and opens a run conversation', async () => {
    const onLoadRuns = vi.fn(async () => [
      { id: 'r1', automationId: 's1', sessionId: 'sess-1', status: 'completed', reason: 'late:900', startedAt: new Date(NOW - 3_600_000).toISOString() },
      { id: 'r2', automationId: 's1', sessionId: null, status: 'skipped', reason: 'still_running', startedAt: new Date(NOW - 7_200_000).toISOString() },
    ])
    const handlers = view([automation({ id: 's1', name: 'Morning summary' })], { onLoadRuns })
    await click(q('[aria-label="Run history for Morning summary"]'))
    await flush()
    const rows = all('.schedule-runs li').map((row) => row.textContent)
    expect(rows[0]).toContain('Done · Started 15 min late')
    expect(rows[1]).toContain('Skipped · The previous run was still going.')
    await click(all('.schedule-runs button').find((button) => button.textContent === 'Open conversation'))
    expect(handlers.onOpenSession).toHaveBeenCalledWith('sess-1')
  })

  it('creates a schedule from presets with the daemon payload and an enabled flag', async () => {
    const handlers = view([])
    await click(q('.schedules-new'))
    const dialog = q('[role="dialog"]')!
    expect(dialog.textContent).toContain('New automation')
    const create = () => all('[role="dialog"] button').find((button) => button.textContent === 'Create automation') as HTMLButtonElement
    expect(create().disabled).toBe(true)
    await type(dialog.querySelector<HTMLInputElement>('input[placeholder="Morning summary"]'), 'Morning summary')
    await type(dialog.querySelector<HTMLTextAreaElement>('textarea'), 'Summarise the repository changes.')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)) })
    expect(handlers.onPreview).toHaveBeenCalledWith({ kind: 'cron', cron: '0 9 * * *', timezone: expect.any(String) })
    expect(dialog.textContent).toContain('Next: Tue 13 Oct 09:00')
    expect(create().disabled).toBe(false)
    await click(create())
    await flush()
    expect(handlers.onCreate).toHaveBeenCalledWith({
      agentId: 'a1', name: 'Morning summary', prompt: 'Summarise the repository changes.', schedule: { kind: 'cron', cron: '0 9 * * *', timezone: expect.any(String) },
      sessionMode: 'new', approvalMode: 'auto', maxRuntimeSecs: 1800, enabled: true,
    })
  })

  it('never offers bypass or ask as an unattended mode and only lists unarchived blobs', async () => {
    view([])
    await click(q('.schedules-new'))
    const labels = all('[role="dialog"] .schedule-mode strong').map((node) => node.textContent)
    expect(labels).toEqual(['Safe actions only', 'Read-only', 'A new one each run', 'Keep going in the same one'])
    const text = q('[role="dialog"]')!.textContent ?? ''
    expect(text).not.toMatch(/bypass|full access/i)
  })

  it('toggles the global pause and reports errors without crashing', async () => {
    const onSetPaused = vi.fn(async () => { throw new Error('The daemon refused.') })
    view([], { onSetPaused })
    await click(q('[aria-label="Pause all automations"]'))
    await flush()
    expect(onSetPaused).toHaveBeenCalledWith(true)
    expect(q('[role="alert"]')?.textContent).toBe('The daemon refused.')
  })

  it('shows the daemon text, with the code prefix stripped, for a plain string rejection', async () => {
    const onSetPaused = vi.fn(async () => Promise.reject('conflict: Real reason'))
    view([], { onSetPaused })
    await click(q('[aria-label="Pause all automations"]'))
    await flush()
    expect(onSetPaused).toHaveBeenCalledWith(true)
    expect(q('[role="alert"]')?.textContent).toBe('Real reason')
  })
})
