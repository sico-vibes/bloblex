import { describe, expect, it } from 'vitest'
import { commandMessage, leadingCommand, slashItems, slashQuery, COMPANION_SLASH_ACTIONS } from './slashCommands'

const skills = [
  { name: 'code-review', description: 'Review a change for bugs.' },
  { name: 'pdf', description: 'Read and fill PDF files.' },
]

describe('slash query detection', () => {
  it('opens at the start of the composer and after a space', () => {
    expect(slashQuery('/', 1)).toEqual({ start: 0, query: '' })
    expect(slashQuery('/mo', 3)).toEqual({ start: 0, query: 'mo' })
    expect(slashQuery('run /mode', 9)).toEqual({ start: 4, query: 'mode' })
  })

  it('does not open inside a word, on a second slash or past a space in the query', () => {
    expect(slashQuery('and/or', 6)).toBeNull()
    expect(slashQuery('http://x', 8)).toBeNull()
    expect(slashQuery('plain text', 10)).toBeNull()
    expect(slashQuery('/model now', 10)).toBeNull()
  })
})

describe('slash menu rows', () => {
  it('lists the actions, this bot skills, then the Manager commands', () => {
    const rows = slashItems('', { skills, isManager: true })
    const groups = [...new Set(rows.map((row) => row.group))]
    expect(groups).toEqual(['Actions', 'Skills', 'Manager'])
    expect(rows.some((row) => row.name === 'help' && row.kind === 'action')).toBe(true)
    expect(rows.some((row) => row.name === 'code-review' && row.kind === 'skill')).toBe(true)
    expect(rows.some((row) => row.name === 'interview' && row.kind === 'manager')).toBe(true)
  })

  it('hides the Manager commands for an ordinary bot', () => {
    const rows = slashItems('', { skills, isManager: false })
    expect(rows.some((row) => row.kind === 'manager')).toBe(false)
    expect(rows.some((row) => row.kind === 'skill')).toBe(true)
  })

  it('filters by name and description', () => {
    expect(slashItems('plan', { skills }).map((row) => row.name)).toEqual(['plan'])
    expect(slashItems('pdf', { skills }).map((row) => row.name)).toEqual(['pdf'])
    expect(slashItems('bug', { skills }).map((row) => row.name)).toEqual(['code-review'])
  })

  it('offers the companion only new, model and effort', () => {
    const names = slashItems('', { skills, actions: COMPANION_SLASH_ACTIONS }).filter((row) => row.kind === 'action').map((row) => row.name)
    expect(names).toEqual(['new', 'model', 'effort'])
  })
})

describe('a command typed by hand', () => {
  it('recognises a leading skill or Manager command', () => {
    expect(leadingCommand('/code-review check the parser', { skills })).toEqual({ kind: 'skill', name: 'code-review' })
    expect(leadingCommand('/interview', { skills, isManager: true })).toEqual({ kind: 'manager', name: 'interview' })
    expect(leadingCommand('/interview', { skills, isManager: false })).toBeNull()
    expect(leadingCommand('please /code-review', { skills })).toBeNull()
    expect(leadingCommand('/nope x', { skills })).toBeNull()
  })

  it('builds the message exactly as typed', () => {
    expect(commandMessage({ kind: 'skill', name: 'code-review' }, 'check the parser')).toBe('/code-review check the parser')
    expect(commandMessage({ kind: 'manager', name: 'interview' }, '')).toBe('/interview')
  })
})
