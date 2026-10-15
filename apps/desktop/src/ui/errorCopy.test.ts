import { describe, expect, it } from 'vitest'
import { friendlyError, friendlyErrorText, type FriendlyErrorInput } from './errorCopy'

type Row = [label: string, input: FriendlyErrorInput, title: string, action: string | null, tone: string]

const ROWS: Row[] = [
  ['daemon invalid_argument', 'invalid_argument: title must be between 1 and 120 characters', 'That did not work.', 'retry', 'attention'],
  ['provider_unavailable', 'provider_unavailable: runtime is not installed', 'The coding agent is not available.', 'update-agent', 'failure'],
  ['unauthenticated', 'unauthenticated: no credentials', 'Sign in to your coding agent.', 'sign-in', 'attention'],
  ['not_signed_in with provider', { code: 'not_signed_in', message: 'opencode is not signed in', provider: 'opencode' }, 'Sign in to OpenCode.', 'sign-in', 'attention'],
  ['rate_limited', 'rate_limited: slow down', 'The coding agent is busy right now.', 'retry', 'attention'],
  ['overloaded', { code: 'overloaded', message: 'server overloaded' }, 'The coding agent is busy right now.', 'retry', 'attention'],
  ['model_unavailable', 'model_unavailable: model not found', 'That model is not available.', 'open-settings', 'attention'],
  ['context', { code: 'context', message: 'Context window is full. Start a new conversation.' }, 'This conversation is full.', 'retry', 'attention'],
  ['timeout', 'timeout: no answer', 'The coding agent took too long.', 'retry', 'attention'],
  ['process_exited', 'process_exited: process is unavailable', 'The coding agent stopped.', 'retry', 'failure'],
  ['permission denied', { message: 'A required permission was denied.' }, 'Permission was denied.', null, 'attention'],
  ['quota', { code: 'quota_exceeded', message: 'quota reached' }, 'You have reached the usage limit.', 'retry', 'attention'],
  ['not_found', 'not_found: session not found', 'That is no longer available.', 'retry', 'info'],
  ['conflict', 'conflict: cannot delete an active conversation', 'That action does not match the current state.', 'retry', 'attention'],
  ['internal', 'internal: agent storage operation failed', 'Something went wrong on your device.', 'open-logs', 'failure'],
  ['cancelled', 'cancelled: turn stopped', 'Cancelled.', null, 'info'],
  ['provider_error', { code: 'provider_error', message: 'The provider reported a turn error.' }, 'The coding agent reported a problem.', 'retry', 'failure'],
  ['config_unsupported', { code: 'config_unsupported', message: 'Requested execution settings were unsupported.' }, 'Those settings are not supported.', 'open-settings', 'attention'],
  ['probe sign-in message', { message: 'Sign-in check timed out.', provider: 'codex' }, 'Sign in to Codex.', 'sign-in', 'attention'],
  ['probe protocol message', { message: 'The CLI does not advertise the required protocol.' }, 'Those settings are not supported.', 'open-settings', 'attention'],
  ['raw provider text as message', { message: 'sk-ant-secret boom: fatal error 0x8000' }, 'Something went wrong. Try again.', 'retry', 'failure'],
  ['empty string', '', 'Something went wrong. Try again.', 'retry', 'failure'],
  ['null', null, 'Something went wrong. Try again.', 'retry', 'failure'],
  ['undefined', undefined, 'Something went wrong. Try again.', 'retry', 'failure'],
  ['empty object', {}, 'Something went wrong. Try again.', 'retry', 'failure'],
]

describe('friendlyError', () => {
  it.each(ROWS)('%s', (_label, input, title, actionKind, tone) => {
    const result = friendlyError(input)
    expect(result.title).toBe(title)
    expect(result.action?.kind ?? null).toBe(actionKind)
    expect(result.tone).toBe(tone)
  })

  it('never uses the raw provider text as the title', () => {
    const raw = 'sk-live-SECRET 429 whatever happened'
    const result = friendlyError(raw)
    expect(result.title).not.toContain('sk-live-SECRET')
    expect(result.title).not.toContain('429')
  })

  it('does not mutate the shared copy objects', () => {
    const first = friendlyError('timeout: a')
    first.title = 'changed'
    expect(friendlyError('timeout: b').title).toBe('The coding agent took too long.')
  })

  it('joins title and detail for single-line callers', () => {
    expect(friendlyErrorText('provider_unavailable: x')).toBe('The coding agent is not available. It may be offline or need an update. Check Settings, then try again.')
    expect(friendlyErrorText('internal: x')).toBe('Something went wrong on your device. Try again. If it keeps happening, open the logs.')
  })
})
