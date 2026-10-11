// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DaemonEvent, Session } from '../types'
import { fetchSnapshot, listenForDaemonEvents, rpc } from './fixtureBridge'

describe('composer preview RPC behavior', () => {
  afterEach(() => vi.restoreAllMocks())

  it('creates an agent-backed session with catalog defaults and confirms model changes with a normalized reset', async () => {
    const created = await rpc<{ session: Session }>('session.new', { agentId:'agent-codex', projectPath:'C:\\fixture\\repo' })
    expect(created.session.modelLock).toEqual({ model:'gpt-6.1-sol', thinking:'low' })
    expect(created.session.contextUsed).toBeNull()
    expect(created.session.contextSize).toBeNull()

    created.session.state = 'working'
    await expect(rpc('session.model.update', { sessionId:created.session.id, model:'gpt-6-astra', thinking:'high', confirmModelChange:true }))
      .rejects.toThrow('active turn')
    created.session.state = 'idle'
    await expect(rpc('session.model.update', { sessionId:created.session.id, model:'gpt-6-astra', thinking:'high', confirmModelChange:false }))
      .rejects.toThrow('confirmation_required')
    expect(created.session.modelLock).toEqual({ model:'gpt-6.1-sol', thinking:'low' })
    created.session.contextUsed = 1200
    created.session.contextSize = 8000

    const events: DaemonEvent[] = []
    const unlisten = await listenForDaemonEvents((event) => events.push(event))
    try {
      const updated = await rpc<{ session:Session; modelChanged:boolean }>('session.model.update', {
        sessionId:created.session.id, model:'gpt-6-astra', thinking:'high', confirmModelChange:true,
      })
      expect(updated.modelChanged).toBe(true)
      expect(updated.session.modelLock).toEqual({ model:'gpt-6-astra', thinking:'high' })
      expect(updated.session.contextUsed).toBeNull()
      expect(updated.session.contextSize).toBeNull()
      expect(events.map((event) => event.type)).toEqual(['session.context.reset','session.changed'])
      expect(events[0]?.payload).toEqual({ sessionId:created.session.id })
      expect((events[1]?.payload?.session as Session).modelLock).toEqual({ model:'gpt-6-astra', thinking:'high' })
    } finally { unlisten() }
  })

  it('toggles a scoped reaction and stores a bounded quoted-reply snapshot in preview history', async () => {
    const created = await rpc<{ session: Session }>('session.new', { agentId:'agent-codex', projectPath:'C:\\fixture\\reply' })
    created.session.state = 'idle'
    created.session.messages = [{ id:'preview-source', role:'assistant', content:'A source message for the reply.', createdAt:'2026-10-11T10:00:00.000Z' }]
    const events: DaemonEvent[] = []
    const unlisten = await listenForDaemonEvents((event) => events.push(event))
    try {
      await rpc('message.reaction.toggle', { sessionId:created.session.id, messageId:'preview-source', emoji:'❤️' })
      expect(created.session.messages[0]?.reactions).toEqual(['❤️'])
      expect(events.at(-1)).toMatchObject({ type:'message.reactions.changed', payload:{ sessionId:created.session.id, messageId:'preview-source', selected:true, reactions:['❤️'] } })

      await rpc('session.prompt', { sessionId:created.session.id, text:'What does this mean?', replyTo:{ sourceSessionId:created.session.id, messageId:'preview-source' } })
      const sent = created.session.messages.at(-1)!
      expect(sent.content).toBe('What does this mean?')
      expect(sent.meta?.replyTo).toMatchObject({ sourceSessionId:created.session.id, messageId:'preview-source', author:'Codex', excerpt:'A source message for the reply.', truncated:false })
      await expect(rpc('session.prompt', { sessionId:created.session.id, text:'Wrong source', replyTo:{ sourceSessionId:'session-claude', messageId:'preview-source' } })).rejects.toThrow('invalid_argument')
    } finally { unlisten() }
  })

  it('has explicit preview-only runtime-error and fresh usage-tip presets', async () => {
    const original = location.href
    try {
      window.history.replaceState({}, '', '/?preset=opencode-runtime-error')
      const failed = await fetchSnapshot()
      expect(failed.runtimes?.find((runtime) => runtime.provider === 'opencode')).toMatchObject({ status:'error', probeStep:'Protocol check' })
      expect(failed.runtimes?.filter((runtime) => runtime.provider !== 'opencode').every((runtime) => runtime.status === 'online')).toBe(true)

      window.history.replaceState({}, '', '/?preset=usage-tip-90')
      const warning = await fetchSnapshot()
      expect(warning.quotas?.find((quota) => quota.provider === 'codex')).toMatchObject({ lastError:null })
      const quota = warning.quotas?.find((item) => item.provider === 'codex')
      const snapshot = quota?.snapshot as { limits?: Array<{ secondary?: { usedPercent?: number } }> } | undefined
      expect(snapshot?.limits?.[0]?.secondary?.usedPercent).toBe(90)
      const settings = await rpc<{ settings: Record<string, unknown> }>('settings.get')
      expect(settings.settings['experimental.usageTips']).toBe(true)
    } finally { window.history.replaceState({}, '', new URL(original).pathname + new URL(original).search) }
  })
})
