import { describe, expect, it } from 'vitest'
import type { BoardTask, BoardTaskRun } from '../types'
import { buildTaskForest } from './TaskTree'
import { timelineBars } from './TaskTimeline'

const NOW = Date.parse('2026-10-21T12:00:00Z')
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()
const task = (id: string, state: BoardTask['state'], extra: Partial<BoardTask> = {}): BoardTask => ({
  id, title: id, brief: '', doneGoal: '', reportBack: '', projectId: null, assigneeAgentId: 'a1', supervisionPolicy: 'report_only', state, version: 1,
  createdAt: iso(100), updatedAt: iso(100), ...extra,
})
const run = (taskId: string, attempt: number, state: string, started: number | null, ended: number | null, agent = 'a1'): BoardTaskRun => ({ id: `${taskId}-${attempt}`, taskId, attempt, assigneeAgentId: agent, state, startedAt: started == null ? null : iso(started), endedAt: ended == null ? null : iso(ended) })

describe('task tree', () => {
  it('nests tasks under their parent and keeps parentless, childless tasks apart', () => {
    const forest = buildTaskForest([task('root', 'running'), task('a', 'queued', { parentTaskId: 'root', createdAt: iso(50) }), task('b', 'running', { parentTaskId: 'root', createdAt: iso(60) }), task('solo', 'unassigned'), task('orphan', 'running', { parentTaskId: 'missing' })])
    expect(forest.trees.map((item) => item.id)).toEqual(['root'])
    expect(forest.children.get('root')?.map((item) => item.id)).toEqual(['b', 'a'])
    expect(forest.standalone.map((item) => item.id).sort()).toEqual(['orphan', 'solo'])
  })
})

describe('timeline bars', () => {
  const from = NOW - 30 * 60_000
  it('draws observed intervals only and counts runs that have none', () => {
    const tasks = [task('t1', 'running', { assignedAt: iso(20) }), task('t2', 'done')]
    const runs = { t1: [run('t1', 1, 'running', 12, null)], t2: [run('t2', 1, 'done', null, null)] }
    const { bars, unplaced } = timelineBars(tasks, runs, 'a1', from, NOW)
    expect(bars.map((bar) => [bar.kind, Math.round((bar.endMs - bar.startMs) / 60000)])).toEqual([['queued', 8], ['work', 12]])
    expect(unplaced).toBe(1)
  })

  it('stacks overlapping attempts into separate rows and skips work outside the range', () => {
    const tasks = [task('t1', 'running'), task('t2', 'running'), task('old', 'done')]
    const runs = { t1: [run('t1', 1, 'running', 20, null)], t2: [run('t2', 1, 'running', 10, null)], old: [run('old', 1, 'done', 200, 180)] }
    const { bars, rows } = timelineBars(tasks, runs, 'a1', from, NOW)
    expect(bars.map((bar) => bar.row)).toEqual([0, 1])
    expect(rows).toBe(2)
  })

  it('shows a queued task as a waiting bar up to now, and ignores another bot\'s runs', () => {
    const tasks = [task('q', 'queued', { assignedAt: iso(9), queuePosition: 0 }), task('x', 'running')]
    const runs = { x: [run('x', 1, 'running', 5, null, 'a2')] }
    const { bars } = timelineBars(tasks, runs, 'a1', from, NOW)
    expect(bars).toHaveLength(1)
    expect(bars[0]).toMatchObject({ kind: 'queued', endMs: NOW })
  })
})
