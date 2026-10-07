// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DaemonEvent, Session } from '../types'
import { listenForDaemonEvents, rpc } from './fixtureBridge'

describe('composer preview RPC behavior', () => {
  afterEach(() => vi.restoreAllMocks())

  it('creates an agent-backed session with catalog defaults and confirms model changes with a normalized reset', async () => {
    const created = await rpc<{ session: Session }>('session.new', { agentId:'agent-codex', projectPath:'C:\\fixture\\repo' })
    expect(created.session.modelLock).toEqual({ model:'gpt-5.5', thinking:'medium' })
    expect(created.session.contextUsed).toBeNull()
    expect(created.session.contextSize).toBeNull()

    created.session.state = 'working'
    await expect(rpc('session.model.update', { sessionId:created.session.id, model:'gpt-5.4', thinking:'high', confirmModelChange:true }))
      .rejects.toThrow('active turn')
    created.session.state = 'idle'
    await expect(rpc('session.model.update', { sessionId:created.session.id, model:'gpt-5.4', thinking:'high', confirmModelChange:false }))
      .rejects.toThrow('confirmation_required')
    expect(created.session.modelLock).toEqual({ model:'gpt-5.5', thinking:'medium' })
    created.session.contextUsed = 1200
    created.session.contextSize = 8000

    const events: DaemonEvent[] = []
    const unlisten = await listenForDaemonEvents((event) => events.push(event))
    try {
      const updated = await rpc<{ session:Session; modelChanged:boolean }>('session.model.update', {
        sessionId:created.session.id, model:'gpt-5.4', thinking:'high', confirmModelChange:true,
      })
      expect(updated.modelChanged).toBe(true)
      expect(updated.session.modelLock).toEqual({ model:'gpt-5.4', thinking:'high' })
      expect(updated.session.contextUsed).toBeNull()
      expect(updated.session.contextSize).toBeNull()
      expect(events.map((event) => event.type)).toEqual(['session.context.reset','session.changed'])
      expect(events[0]?.payload).toEqual({ sessionId:created.session.id })
      expect((events[1]?.payload?.session as Session).modelLock).toEqual({ model:'gpt-5.4', thinking:'high' })
    } finally { unlisten() }
  })
})
