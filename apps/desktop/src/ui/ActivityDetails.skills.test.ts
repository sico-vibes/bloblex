import { describe, expect, it } from 'vitest'
import { activityTitle, loadedSkillName } from './ActivityDetails'
import type { ConversationItem } from './conversation'

const step = (tool: string, input?: unknown) => ({ kind: 'activity', activity: { kind: 'tool', detail: { tool: `bloblex · ${tool}`, input } } }) as unknown as ConversationItem

describe('skill tool steps', () => {
  it('names the skill a bot loaded, from an object or JSON input', () => {
    expect(loadedSkillName({ name: 'pdf' })).toBe('pdf')
    expect(loadedSkillName('{"name":"release-notes"}')).toBe('release-notes')
    expect(loadedSkillName('not json')).toBeNull()
    expect(activityTitle(step('load_skill', { name: 'pdf' }))).toBe('Used skill: pdf')
    expect(activityTitle(step('load_skill'))).toBe('Used a skill')
    expect(activityTitle(step('list_skills'))).toBe('Checked the skills')
  })
})
