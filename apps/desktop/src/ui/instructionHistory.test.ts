// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  INSTRUCTION_HISTORY_LIMIT, INSTRUCTION_TEXT_LIMIT, instructionCounts, instructionVersions,
  recordInstructionVersion, thousands,
} from './instructionHistory'

describe('instruction history', () => {
  beforeEach(() => { localStorage.clear() })
  afterEach(() => { localStorage.clear() })

  it('keeps the newest save first', () => {
    recordInstructionVersion('agent-1', 'first')
    recordInstructionVersion('agent-1', 'second')
    expect(instructionVersions('agent-1').map((version) => version.text)).toEqual(['second', 'first'])
    expect(instructionVersions('agent-1')[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('does not store the same text twice', () => {
    recordInstructionVersion('agent-1', 'same')
    recordInstructionVersion('agent-1', 'same')
    expect(instructionVersions('agent-1')).toHaveLength(1)
  })

  it('caps history at five and keeps the most recent', () => {
    for (const text of ['a', 'b', 'c', 'd', 'e', 'f']) recordInstructionVersion('agent-1', text)
    const versions = instructionVersions('agent-1')
    expect(versions).toHaveLength(INSTRUCTION_HISTORY_LIMIT)
    expect(versions.map((version) => version.text)).toEqual(['f', 'e', 'd', 'c', 'b'])
  })

  it('caps each saved text at twenty thousand characters', () => {
    recordInstructionVersion('agent-1', 'x'.repeat(INSTRUCTION_TEXT_LIMIT + 500))
    expect(instructionVersions('agent-1')[0].text).toHaveLength(INSTRUCTION_TEXT_LIMIT)
  })

  it('keeps each bot separate and ignores an empty id', () => {
    recordInstructionVersion('agent-1', 'one')
    recordInstructionVersion('agent-2', 'two')
    recordInstructionVersion('', 'ignored')
    expect(instructionVersions('agent-1').map((version) => version.text)).toEqual(['one'])
    expect(instructionVersions('agent-2').map((version) => version.text)).toEqual(['two'])
    expect(instructionVersions('')).toEqual([])
  })

  it('drops malformed stored entries', () => {
    localStorage.setItem('bitbots.instructionHistory.agent-1', JSON.stringify([{ at: 'now' }, 'nope', { at: 't', text: 'ok' }]))
    expect(instructionVersions('agent-1')).toEqual([{ at: 't', text: 'ok' }])
    localStorage.setItem('bitbots.instructionHistory.agent-1', 'not json')
    expect(instructionVersions('agent-1')).toEqual([])
  })
})

describe('instruction counts', () => {
  it('counts characters and estimates one token per four characters', () => {
    expect(instructionCounts('')).toEqual({ characters: 0, tokens: 0 })
    expect(instructionCounts('abcd')).toEqual({ characters: 4, tokens: 1 })
    expect(instructionCounts('abcde')).toEqual({ characters: 5, tokens: 2 })
    expect(instructionCounts('x'.repeat(1234))).toEqual({ characters: 1234, tokens: 309 })
  })

  it('formats thousands with separators', () => {
    expect(thousands(0)).toBe('0')
    expect(thousands(300)).toBe('300')
    expect(thousands(1234)).toBe('1,234')
    expect(thousands(1_234_567)).toBe('1,234,567')
  })
})
