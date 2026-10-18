import { describe, expect, it } from 'vitest'
import { deriveCompanionStatus } from './companionStatus'
import { DEFAULT_EXPERIMENTS } from './experiments'
import { buildConversationItems } from './conversation'

describe('P8 watchdog presentation', () => {
  it('shows a usage reset in the companion and defaults recovery on', () => {
    const status = deriveCompanionStatus({ connected: true, runtime: { id: 'r', provider: 'codex', status: 'online' }, session: { id: 's', runtimeId: 'r', state: 'limited', limitedUntil: '2026-10-18T12:00:00Z' } })
    expect(status.mood).toBe('rate_limited')
    expect(status.label).toContain('Limited until')
    expect(DEFAULT_EXPERIMENTS.resumeAfterUsageLimits).toBe(true)
  })
  it('shows recovery once instead of an error for every attempt', () => {
    const items = buildConversationItems({ id: 's', runtimeId: 'r', messages: [{ id: 'n', role: 'notice', content: 'Retrying (2 of 3)…' }], turns: [{ id: 't', state: 'error', recoveryHandled: true }] })
    expect(items.some(item => item.kind === 'activity' && item.id === 'turn-error:t')).toBe(false)
  })
})
