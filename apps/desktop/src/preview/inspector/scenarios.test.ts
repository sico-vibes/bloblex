import { describe, expect, it } from 'vitest'
import { sceneFor, sceneIds } from '../fixtureScenes'
import { GROUPS, SCENARIOS } from './scenarios'

describe('the inspector index', () => {
  it('gives every state its own id, so a note always lands on the right one', () => {
    const ids = SCENARIOS.map((scenario) => scenario.id)
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
  })

  it('only opens conversations that exist', () => {
    const used = SCENARIOS.flatMap((scenario) => new URLSearchParams(scenario.url.split('?')[1] ?? '').get('scene') ?? [])
    expect(used.filter((id) => !sceneFor(id))).toEqual([])
  })

  it('shows every conversation the fixtures hold', () => {
    const used = new Set(SCENARIOS.flatMap((scenario) => new URLSearchParams(scenario.url.split('?')[1] ?? '').get('scene') ?? []))
    expect(sceneIds().filter((id) => !used.has(id))).toEqual([])
  })

  it('has no empty group', () => {
    expect(GROUPS.filter((group) => group.scenarios.length === 0)).toEqual([])
  })
})
