// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, BoardTask } from '../types'
import { DelegateBoard } from './DelegateBoard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.parse('2026-10-21T12:00:00Z')
const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({ id, name, color: '#82aaff', runtimeId: 'runtime-codex', sortOrder: 0, archived: false, ...extra } as Agent)
const AGENTS = [agent('a1', 'Codex'), agent('a2', 'Claude', { sortOrder: 1 }), agent('a3', 'Retired', { archived: true, sortOrder: 2 })]
const task = (id: string, state: BoardTask['state'], extra: Partial<BoardTask> = {}): BoardTask => ({
  id, title: `Task ${id}`, brief: '', doneGoal: '', reportBack: '', projectId: null, assigneeAgentId: state === 'unassigned' ? null : 'a1', supervisionPolicy: 'report_only', state, version: 1,
  createdAt: '2026-10-21T10:00:00Z', updatedAt: '2026-10-21T10:00:00Z', ...extra,
})

let root: Root
let host: HTMLDivElement
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
const all = (selector: string) => [...host.querySelectorAll<HTMLElement>(selector)]

function board(tasks: BoardTask[]) {
  const onAssign = vi.fn(); const onOpen = vi.fn()
  act(() => root.render(<DelegateBoard tasks={tasks} agents={AGENTS} projects={[]} nowMs={NOW} connected busy={new Set()} runtimeName={() => 'Codex · GPT'} onAssign={onAssign} onOpen={onOpen} />))
  return { onAssign, onOpen }
}
const withTransfer = (type: string, data: unknown) => { const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer?: unknown }; event.dataTransfer = data; return event }
const dragStart = (card: HTMLElement) => act(() => { card.dispatchEvent(withTransfer('dragstart', { setData: () => undefined, effectAllowed: 'move' })) })
const drop = (lane: HTMLElement, id: string) => act(() => { lane.dispatchEvent(withTransfer('drop', { getData: () => id, dropEffect: 'move' })) })

describe('DelegateBoard', () => {
  it('lists drafts on the left and one lane per live bot', () => {
    board([task('d1', 'unassigned'), task('r1', 'running', { estimateMinutes: 30, startedAt: '2026-10-21T11:48:00Z' }), task('q1', 'queued', { queuePosition: 0 }), task('x', 'done')])
    expect(all('.delegate-draft')).toHaveLength(1)
    expect(all('.delegate-draft')[0].textContent).toContain('Task d1')
    expect(all('.delegate-lane').map((lane) => lane.getAttribute('aria-label'))).toEqual(['Codex, Busy · 18 min left', 'Claude, Free'])
    expect(host.textContent).toContain('1 queued')
    expect(all('.delegate-done')).toHaveLength(0)
    act(() => all('.delegate-finished-toggle')[0].click())
    expect(all('.delegate-done')).toHaveLength(1)
  })

  it('runs the single assign action when a draft is dropped on a bot, and ignores work that is not a draft', () => {
    const { onAssign } = board([task('d1', 'unassigned'), task('r1', 'running')])
    dragStart(all('.delegate-draft')[0])
    const lanes = all('.delegate-lane')
    drop(lanes[1], 'd1')
    expect(onAssign).toHaveBeenCalledTimes(1)
    expect(onAssign.mock.calls[0][0].id).toBe('d1')
    expect(onAssign.mock.calls[0][1].id).toBe('a2')
    drop(lanes[1], 'r1')
    expect(onAssign).toHaveBeenCalledTimes(1)
  })

  it('offers the same assignment from a menu for keyboard use', () => {
    const { onAssign } = board([task('d1', 'unassigned')])
    act(() => host.querySelector<HTMLButtonElement>('.delegate-draft button[aria-haspopup]')!.click())
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent === 'Claude')
    act(() => option!.click())
    expect(onAssign).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }), expect.objectContaining({ id: 'a2' }))
  })

  it('says so when there is nothing to assign', () => {
    board([])
    expect(host.textContent).toContain('No drafts')
  })
})
