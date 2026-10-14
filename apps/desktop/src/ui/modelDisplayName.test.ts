import { describe, expect, it } from 'vitest'
import { modelDisplayName } from './modelDisplayName'

describe('modelDisplayName', () => {
  it('adds the release read from a Claude model id to a bare family name', () => {
    expect(modelDisplayName({ id: 'claude-sonnet-5-5', displayName: 'Sonnet' })).toBe('Sonnet 5.5')
    expect(modelDisplayName({ id: 'claude-opus-5-5', displayName: 'Opus' })).toBe('Opus 5.5')
    expect(modelDisplayName({ id: 'claude-haiku-4-5-20251001', displayName: 'Haiku' })).toBe('Haiku 4.5')
    expect(modelDisplayName({ id: 'claude-fable-5', displayName: 'Fable' })).toBe('Fable 5')
  })
  it('leaves names that already carry a number, custom names and unversioned ids alone', () => {
    expect(modelDisplayName({ id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' })).toBe('Claude Opus 5.5')
    expect(modelDisplayName({ id: 'sonnet', displayName: 'Sonnet' })).toBe('Sonnet')
    expect(modelDisplayName({ id: 'claude-opus-5-5', displayName: 'Default (recommended)' })).toBe('Default (recommended)')
    expect(modelDisplayName({ id: 'gpt-6-luna', displayName: 'GPT-6-Luna' })).toBe('GPT-6-Luna')
  })
})
