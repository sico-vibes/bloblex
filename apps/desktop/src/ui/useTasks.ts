// Board task state: one `task.list` load, then the daemon's task events keep it current. The daemon owns every transition.
import { useCallback, useEffect, useRef, useState } from 'react'
import { listenForDaemonEvents, rpc } from '../tauri'
import { rpcFailure } from '../executionContract'
import type { BoardTask, BoardTaskRun, TaskDispatchResult } from '../types'
import type { DaemonSchedule } from './automationSchedule'

/** One image on a task: a kept one by its stored id, or a new one staged on disk by the desktop shell. */
export type TaskImageRef = { id: string } | { path: string; name: string }
export interface TaskInput {
  title: string; brief: string; doneGoal: string; reportBack: string; projectId: string | null
  estimateMinutes?: number | null
  maxRuntimeSecs?: number
  attachments?: TaskImageRef[]
  /** `null` is "now"; a schedule needs the bot that runs it. */
  schedule?: DaemonSchedule | null
  scheduleAgentId?: string | null
}

export function useTasks(active: boolean, connected: boolean) {
  const [tasks, setTasks] = useState<BoardTask[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(async () => {
    try {
      const result = await rpc<{ tasks?: BoardTask[] }>('task.list', {})
      if (!alive.current) return
      setTasks(result.tasks ?? [])
      setError(null)
    } catch (reason) {
      if (alive.current) setError(rpcFailure(reason).message)
    } finally {
      if (alive.current) setLoaded(true)
    }
  }, [])

  useEffect(() => { if (active && connected) void load() }, [active, connected, load])

  useEffect(() => {
    if (!active || !connected) return
    let off: (() => void) | null = null
    let cancelled = false
    void listenForDaemonEvents((event) => {
      if (event.type === 'task.changed' || event.type === 'task.run.finished' || event.type === 'task.run.changed') {
        // The daemon's task events carry identifiers and lifecycle only (no title or brief): patch the card we have, or reload for a task we have not seen.
        const patch = (event.payload as { task?: Partial<BoardTask> } | undefined)?.task
        if (patch?.id) {
          let known = false
          setTasks((current) => current.map((item) => { if (item.id !== patch.id) return item; known = true; return (patch.version ?? 0) >= item.version ? { ...item, ...patch } as BoardTask : item }))
          if (!known) void load()
        } else void load()
      }
    }).then((unlisten) => { if (cancelled) unlisten(); else off = unlisten })
    return () => { cancelled = true; off?.() }
  }, [active, connected, load])

  const merge = (task: BoardTask) => setTasks((current) => current.some((item) => item.id === task.id) ? current.map((item) => item.id === task.id ? task : item) : [task, ...current])

  const create = useCallback(async (input: TaskInput) => { const result = await rpc<{ task: BoardTask }>('task.create', { ...input }); merge(result.task); return result.task }, [])
  const update = useCallback(async (task: BoardTask, input: TaskInput) => { const result = await rpc<{ task: BoardTask }>('task.update', { ...input, taskId: task.id, expectedVersion: task.version }); merge(result.task); return result.task }, [])
  /** One stored image as a data URL, for its thumbnail. */
  const image = useCallback(async (taskId: string, imageId: string) => (await rpc<{ dataUrl: string }>('task.image', { taskId, imageId })).dataUrl, [])
  const dispatch = useCallback(async (task: BoardTask, assigneeAgentId: string, idempotencyKey: string) => {
    const result = await rpc<TaskDispatchResult>('task.dispatch', { taskId: task.id, assigneeAgentId, expectedVersion: task.version, idempotencyKey })
    merge(result.task)
    return result
  }, [])
  const act = useCallback(async (method: 'task.unassign' | 'task.cancel' | 'task.stop', task: BoardTask) => {
    const result = await rpc<{ task: BoardTask }>(method, { taskId: task.id, expectedVersion: task.version })
    merge(result.task)
    return result.task
  }, [])
  const review = useCallback(async (task: BoardTask, runId: string | null, decision: 'done' | 'needs_changes' | 'not_done', evidence: string) => {
    const result = await rpc<{ task: BoardTask }>('task.review', { taskId: task.id, runId, decision, evidence, expectedVersion: task.version })
    merge(result.task)
    return result.task
  }, [])
  const reorder = useCallback(async (task: BoardTask, beforeTaskId: string | null) => {
    const result = await rpc<{ task: BoardTask }>('task.reorder', { taskId: task.id, beforeTaskId, expectedVersion: task.version })
    merge(result.task)
    await load()
    return result.task
  }, [load])
  const runs = useCallback(async (taskId: string) => (await rpc<{ runs?: BoardTaskRun[] }>('task.runs', { taskId })).runs ?? [], [])

  return { tasks, loaded, error, reload: load, create, update, image, dispatch, act, review, reorder, runs }
}
