import { describe, expect, it, vi } from 'vitest'
import { busyDelivery, busySendMode, sendWithDelivery } from './busySend'
import { rpc } from '../tauri'
import { taskElapsed, taskStatus } from './WorkingBotsPanel'
import { applyTemplate, BOT_TEMPLATES } from './botTemplates'
import { createDraft, createParams, draftFromAgent } from './agentForm'
import type { Agent, Session } from '../types'

vi.mock('../tauri', () => ({ rpc: vi.fn() }))
describe('busy send delivery', () => {
  it('queues and reports an unsupported steer without losing the message', async () => {
    vi.mocked(rpc).mockRejectedValueOnce('unsupported: Steering is turned off').mockResolvedValueOnce({})
    expect(await sendWithDelivery('session.steer', { sessionId: 's', text: 'Follow up' })).toEqual({ queued: true, fallback: true })
    expect(rpc).toHaveBeenLastCalledWith('session.queue.add', { clientMessageId: expect.stringMatching(/^m-/), sessionId: 's', text: 'Follow up' })
  })
  it('reports the daemon queue fallback for a stale steer', async () => {
    vi.mocked(rpc).mockResolvedValueOnce({ queued: true, steered: false })
    expect(await sendWithDelivery('session.steer', { sessionId: 's', text: 'Follow up' })).toEqual({ queued: true, fallback: true })
  })
  it('does not resend an ambiguous provider failure', async () => {
    vi.mocked(rpc).mockClear().mockRejectedValueOnce('provider_error: stream failed')
    await expect(sendWithDelivery('session.steer', { sessionId: 's', text: 'Follow up' })).rejects.toBe('provider_error: stream failed')
    expect(rpc).toHaveBeenCalledTimes(1)
  })
  it('defaults to Steer and recognises Queue', () => {
    expect(busySendMode(undefined)).toBe('steer')
    expect(busySendMode('queue')).toBe('queue')
  })
  it('selects the preference and its keyboard override', () => {
    expect(busyDelivery('steer', false, 'working', true).mode).toBe('steer')
    expect(busyDelivery('steer', true, 'working', true).mode).toBe('queue')
    expect(busyDelivery('queue', false, 'working', true).mode).toBe('queue')
    expect(busyDelivery('queue', true, 'working', true).mode).toBe('steer')
  })
  it.each([[false, 'working', false], [true, 'starting', false], [true, 'working', true]] as const)('explains a Queue fallback (%s, %s, %s)', (supported, state, context) => {
    expect(busyDelivery('steer', false, state, supported, context)).toEqual({ mode: 'queue', reason: expect.any(String) })
  })
})

describe('assigned task presentation', () => {
  const base: Session = { id: 'side', runtimeId: 'rt', createdAt: '2026-10-18T10:00:00Z', updatedAt: '2026-10-18T10:02:00Z' }
  const hydrated: Session = { ...base, messages: [] }
  it('treats an idle thin snapshot as not yet known', () => expect(taskStatus(base)).toBe('Loading'))
  it('still trusts a live state on a thin snapshot', () => {
    expect(taskStatus({ ...base, state: 'working' })).toBe('Working')
    expect(taskStatus({ ...base, state: 'waiting_permission' })).toBe('Waiting for you')
    expect(taskStatus({ ...base, state: 'limited' })).toBe('Limited')
  })
  it('distinguishes pending approvals, failures and completed work', () => {
    expect(taskStatus({ ...hydrated, state: 'waiting_permission' })).toBe('Waiting for you')
    expect(taskStatus({ ...hydrated, state: 'error' })).toBe('Failed')
    expect(taskStatus({ ...hydrated, turns: [{ state: 'completed' }] })).toBe('Done')
    expect(taskStatus({ ...hydrated, turns: [{ state: 'cancelled' }] })).toBe('Cancelled')
  })
  it('treats any other finished turn state as a failure', () => {
    expect(taskStatus({ ...hydrated, turns: [{ state: 'timeout' }] })).toBe('Failed')
    expect(taskStatus({ ...hydrated, turns: [{ state: 'interrupted' }] })).toBe('Failed')
  })
  it('freezes elapsed time on the recorded completion and shows a dash without it', () => {
    expect(taskElapsed({ ...base, turns: [{ state: 'completed', completedAt: '2026-10-18T10:02:00Z' }] }, 'Done', Date.parse('2026-10-18T12:00:00Z'))).toBe('2m 0s')
    expect(taskElapsed(base, 'Done', Date.parse('2026-10-18T12:00:00Z'))).toBe('—')
    expect(taskElapsed(base, 'Working', Date.parse('2026-10-18T12:00:00Z'))).toBe('2h 0m')
    expect(taskElapsed({ id: 'x', runtimeId: 'rt' }, 'Working', Date.now())).toBe('—')
  })
})

it('starts every new template with Full access and preserves existing bot modes', () => {
  for (const template of BOT_TEMPLATES) {
    const draft = applyTemplate(createDraft([{ id: 'rt', provider: 'codex' }], 'rt'), template)
    expect(createParams(draft).approvalMode).toBe('bypass')
  }
  expect(draftFromAgent({ id: 'old', approvalMode: 'ask' } as Agent).approvalMode).toBe('ask')
  expect(draftFromAgent({ id: 'old', approvalMode: null } as Agent).approvalMode).toBeNull()
})
