import { describe, expect, it } from 'vitest'
import type { BoardTask } from '../types'
import { SCHEDULE_DISCLAIMER, dispatchMessage, draftTasks, elapsedLabel, laneAvailability, laneTasks, remainingMinutes, scheduleSummary, scheduledTasks } from './taskModel'
import type { Agent } from '../types'

const NOW = Date.parse('2026-10-21T12:00:00Z')
const task = (id: string, state: BoardTask['state'], extra: Partial<BoardTask> = {}): BoardTask => ({
  id, title: id, brief: '', doneGoal: '', reportBack: '', projectId: null, assigneeAgentId: 'a1', supervisionPolicy: 'report_only', state, version: 1,
  createdAt: '2026-10-21T10:00:00Z', updatedAt: '2026-10-21T10:00:00Z', ...extra,
})

describe('task model', () => {
  it('shows a remaining time only when the estimate and an observed start both exist', () => {
    expect(remainingMinutes(task('t', 'running', { estimateMinutes: 30, startedAt: '2026-10-21T11:48:00Z' }), NOW)).toBe(18)
    expect(remainingMinutes(task('t', 'running', { estimateMinutes: 30 }), NOW)).toBeNull()
    expect(remainingMinutes(task('t', 'running', { startedAt: '2026-10-21T11:48:00Z' }), NOW)).toBeNull()
    expect(remainingMinutes(task('t', 'running', { estimateMinutes: 10, startedAt: '2026-10-21T11:00:00Z' }), NOW)).toBe(0)
  })

  it('orders a lane: needs you, review, working, then the queue in order', () => {
    const tasks = [task('q2', 'queued', { queuePosition: 1 }), task('run', 'running'), task('q1', 'queued', { queuePosition: 0 }), task('rev', 'awaiting_review'), task('need', 'needs_you'), task('done', 'done'), task('other', 'running', { assigneeAgentId: 'a2' })]
    expect(laneTasks(tasks, 'a1').map((item) => item.id)).toEqual(['need', 'rev', 'run', 'q1', 'q2'])
  })

  it('describes a lane without inventing a duration', () => {
    expect(laneAvailability([], NOW)).toEqual({ tone: 'free', label: 'Free', queued: 0 })
    expect(laneAvailability([task('r', 'running')], NOW)).toEqual({ tone: 'working', label: 'Working', queued: 0 })
    expect(laneAvailability([task('r', 'running', { estimateMinutes: 30, startedAt: '2026-10-21T11:48:00Z' }), task('q', 'queued')], NOW)).toEqual({ tone: 'working', label: 'Busy · 18 min left', queued: 1 })
    expect(laneAvailability([task('n', 'needs_you'), task('q', 'queued')], NOW).tone).toBe('attention')
  })

  it('lists drafts newest first and leaves finished work out of lanes', () => {
    const tasks = [task('old', 'unassigned', { assigneeAgentId: null, createdAt: '2026-10-21T08:00:00Z' }), task('new', 'unassigned', { assigneeAgentId: null, createdAt: '2026-10-21T09:00:00Z' }), task('d', 'done')]
    expect(draftTasks(tasks).map((item) => item.id)).toEqual(['new', 'old'])
    expect(laneTasks(tasks, 'a1')).toEqual([])
  })

  it('words the dispatch result and elapsed time plainly', () => {
    expect(dispatchMessage('started', 'Codex')).toBe('Started on Codex.')
    expect(dispatchMessage('queued', 'Codex', 1, 'bot_busy')).toBe('Codex is busy. Queued at position 2 for Codex.')
    expect(dispatchMessage('queued', 'Codex', null, 'global_pause')).toBe('Tasks are paused. Queued for Codex.')
    expect(elapsedLabel('2026-10-21T11:00:00Z', null, NOW)).toBe('1 h')
    expect(elapsedLabel(null, null, NOW)).toBeNull()
    expect(elapsedLabel('2026-10-21T12:00:30Z', null, NOW)).toBeNull()
  })

  it('keeps scheduled tasks out of the drafts and describes their schedule', () => {
    const repeat = task('r', 'unassigned', { assigneeAgentId: null, schedule: { kind: 'cron', cron: '0 9 * * 1-5', timezone: 'UTC' }, scheduleAgentId: 'a1', scheduleState: 'active', scheduleNextAt: '2026-10-22T09:00:00Z' })
    const missed = task('m', 'unassigned', { assigneeAgentId: null, schedule: { kind: 'once', at: '2026-10-20T09:00:00Z' }, scheduleAgentId: 'a1', scheduleState: 'missed' })
    const plain = task('p', 'unassigned', { assigneeAgentId: null })
    expect(draftTasks([repeat, missed, plain]).map((item) => item.id).sort()).toEqual(['m', 'p'])
    expect(scheduledTasks([repeat, missed, plain]).map((item) => item.id)).toEqual(['r'])
    expect(scheduleSummary(repeat, [{ id: 'a1', name: 'Codex' } as Agent])).toBe('Weekdays at 09:00 · Codex')
    expect(scheduleSummary(plain, [])).toBeNull()
    expect(SCHEDULE_DISCLAIMER).toContain('skipped, not run late')
  })
})
