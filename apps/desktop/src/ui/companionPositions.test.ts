import { describe, expect, it } from 'vitest'
import { forgetCompanionPosition, MAX_COMPANION_POSITIONS, normalizeCompanionPositions, positionsFromSettings, rememberCompanionPosition, type CompanionPositions } from './companionPositions'

describe('normalizeCompanionPositions', () => {
  it('keeps only numeric { x, y } entries under a display name', () => {
    expect(normalizeCompanionPositions({ '\\\\.\\DISPLAY1': { x: 10.6, y: -4.2 } })).toEqual({ '\\\\.\\DISPLAY1': { x: 11, y: -4 } })
    expect(normalizeCompanionPositions({ A: { x: 1, y: 2 }, B: { x: '3', y: 4 }, C: { x: NaN, y: 0 }, D: null, E: [1, 2] })).toEqual({ A: { x: 1, y: 2 } })
  })

  it('rejects a non-object and caps the count at eight', () => {
    expect(normalizeCompanionPositions(null)).toEqual({})
    expect(normalizeCompanionPositions('x')).toEqual({})
    expect(normalizeCompanionPositions([{ x: 1, y: 2 }])).toEqual({})
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`M${index}`, { x: index, y: index }]))
    expect(Object.keys(normalizeCompanionPositions(many))).toHaveLength(MAX_COMPANION_POSITIONS)
  })

  it('ignores an over-long display name', () => {
    expect(normalizeCompanionPositions({ ['n'.repeat(201)]: { x: 1, y: 2 } })).toEqual({})
  })

  it('reads either settings payload shape', () => {
    expect(positionsFromSettings({ settings: { 'companion.positions': { M: { x: 5, y: 6 } } } })).toEqual({ M: { x: 5, y: 6 } })
    expect(positionsFromSettings({ 'companion.positions': { M: { x: 5, y: 6 } } })).toEqual({ M: { x: 5, y: 6 } })
    expect(positionsFromSettings({})).toEqual({})
  })
})

describe('rememberCompanionPosition and forgetCompanionPosition', () => {
  it('moves an existing display to the newest slot', () => {
    const positions = rememberCompanionPosition(rememberCompanionPosition({}, 'A', { x: 1, y: 1 }), 'B', { x: 2, y: 2 })
    expect(Object.keys(positions)).toEqual(['A', 'B'])
    expect(Object.keys(rememberCompanionPosition(positions, 'A', { x: 9, y: 9 }))).toEqual(['B', 'A'])
  })

  it('drops the oldest once the cap is reached', () => {
    let positions: CompanionPositions = {}
    for (let index = 0; index < MAX_COMPANION_POSITIONS + 2; index++) positions = rememberCompanionPosition(positions, `M${index}`, { x: index, y: index })
    expect(Object.keys(positions)).toEqual(['M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'])
  })

  it('ignores an invalid point or name and forgets only the named display', () => {
    const positions = { A: { x: 1, y: 1 }, B: { x: 2, y: 2 } }
    expect(rememberCompanionPosition(positions, '', { x: 1, y: 1 })).toBe(positions)
    expect(rememberCompanionPosition(positions, 'C', { x: NaN, y: 1 })).toBe(positions)
    expect(forgetCompanionPosition(positions, 'A')).toEqual({ B: { x: 2, y: 2 } })
    expect(forgetCompanionPosition(positions, 'Z')).toBe(positions)
  })
})
