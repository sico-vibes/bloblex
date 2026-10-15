import { describe, expect, it } from 'vitest'
import { PLAN_STEP_MATCH_THRESHOLD, planProgress, planSteps } from './planProgress'

describe('planSteps', () => {
  it('reads numbered and bulleted list lines and drops everything else', () => {
    const text = [
      'Here is the plan.',
      '',
      '1. Add the storage column',
      '2) Wire the daemon command',
      '- Update the sidebar',
      '* Write the tests',
      '+ Ship it',
      '• Check the docs',
      '',
      'That is everything.',
    ].join('\n')
    expect(planSteps(text)).toEqual([
      'Add the storage column',
      'Wire the daemon command',
      'Update the sidebar',
      'Write the tests',
      'Ship it',
      'Check the docs',
    ])
  })

  it('returns nothing for prose, an empty string or a non string', () => {
    expect(planSteps('No list here.')).toEqual([])
    expect(planSteps('')).toEqual([])
    expect(planSteps(undefined as unknown as string)).toEqual([])
  })
})

describe('planProgress', () => {
  const steps = ['Add the storage column', 'Update the sidebar spacing', 'Write release notes']

  it('marks a step done on a close later message and leaves the rest alone', () => {
    expect(planProgress(steps, ['Added the storage column to the agents table.'])).toEqual([1, 0, 0])
  })

  it('marks every step when the later messages cover them all', () => {
    const messages = [
      'Added the storage column and its migration.',
      'Update the sidebar spacing token.',
      'Wrote release notes for the build.',
    ]
    expect(planProgress(steps, messages)).toEqual([1, 1, 1])
  })

  it('does not mark a step on a weak overlap', () => {
    // Only "sidebar" of three content words overlaps: 1/3 < 0.6.
    expect(planProgress(['Update the sidebar spacing'], ['The sidebar is fine.'])).toEqual([0])
  })

  it('treats a step with no content words as not done and tolerates empty input', () => {
    expect(planProgress(['the and of'], ['the and of was done'])).toEqual([0])
    expect(planProgress([], ['anything'])).toEqual([])
    expect(planProgress(steps, [])).toEqual([0, 0, 0])
  })

  it('is index aligned and uses the documented threshold', () => {
    expect(PLAN_STEP_MATCH_THRESHOLD).toBe(0.6)
    const progress = planProgress(steps, ['Added the storage column and updated the sidebar spacing token.'])
    expect(progress).toHaveLength(steps.length)
    expect(progress).toEqual([1, 1, 0])
  })
})
