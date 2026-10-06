import { describe, expect, it } from 'vitest'
import { moodWithFileReference } from './characterState'

describe('honest local file-reference states', () => {
  it.each([
    ['drop', 'file_drop'],
    ['preparing', 'file_preparing'],
    ['ready', 'file_ready'],
    ['sending', 'file_sending'],
    ['error', 'file_error'],
  ] as const)('maps %s to the matching character cue', (stage, expected) => {
    expect(moodWithFileReference('idle', stage)).toBe(expected)
  })

  it('does not mask approval, offline, rate-limit or provider failure states', () => {
    for (const protectedMood of ['permission', 'offline', 'rate_limited', 'error'] as const) {
      expect(moodWithFileReference(protectedMood, 'drop')).toBe(protectedMood)
      expect(moodWithFileReference(protectedMood, 'ready')).toBe(protectedMood)
      expect(moodWithFileReference(protectedMood, 'sending')).toBe(protectedMood)
      expect(moodWithFileReference(protectedMood, 'error')).toBe(protectedMood)
    }
  })

  it('keeps the provider mood when no local reference is active', () => {
    expect(moodWithFileReference('thinking')).toBe('thinking')
    expect(moodWithFileReference('tool_activity', undefined)).toBe('tool_activity')
  })

  it('lets an explicit local action replace stale completion while preserving active barriers and failures', () => {
    expect(moodWithFileReference('success', 'drop')).toBe('file_drop')
    expect(moodWithFileReference('success', 'ready')).toBe('file_ready')
    for (const protectedMood of ['permission', 'offline', 'rate_limited', 'error'] as const) {
      expect(moodWithFileReference(protectedMood, 'ready')).toBe(protectedMood)
    }
  })
})
