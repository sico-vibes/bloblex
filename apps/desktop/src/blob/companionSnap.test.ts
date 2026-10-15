import { describe, expect, it } from 'vitest'
import { snapPosition, type Rect } from './companionSnap'

const area: Rect = { x: 0, y: 0, width: 1920, height: 1080 }
const rect = (x: number, y: number, width = 344, height = 62): Rect => ({ x, y, width, height })

// Flush-with-margin coordinates on this work area.
const left = 8
const right = 1920 - 344 - 8
const top = 8
const bottom = 1080 - 62 - 8

describe('snapPosition', () => {
  const cases: Array<{ name: string; input: Rect; expected: { x: number; y: number }; area?: Rect }> = [
    { name: 'snaps to the left edge when dropped within 16 px', input: rect(left + 10, 500), expected: { x: left, y: 500 } },
    { name: 'snaps to the right edge', input: rect(right - 12, 400), expected: { x: right, y: 400 } },
    { name: 'snaps to the top edge', input: rect(900, top + 4), expected: { x: 900, y: top } },
    { name: 'snaps to the bottom edge', input: rect(900, bottom - 16), expected: { x: 900, y: bottom } },
    { name: 'leaves a window in open space alone', input: rect(900, 500), expected: { x: 900, y: 500 } },
    { name: 'does not snap an axis 17 px from the edge', input: rect(left + 17, 500), expected: { x: left + 17, y: 500 } },
    { name: 'snaps both axes within 40 px of a corner', input: rect(left + 30, top + 25), expected: { x: left, y: top } },
    { name: 'snaps to a bottom-right corner', input: rect(right - 35, bottom - 20), expected: { x: right, y: bottom } },
    { name: 'chooses the nearer vertical edge within the corner band', input: rect(left + 5, top + 30), expected: { x: left, y: top } },
    { name: 'respects a non-zero work-area origin', input: rect(1920 + left + 6, 700), expected: { x: 1920 + left, y: 700 }, area: { x: 1920, y: 0, width: 1920, height: 1080 } },
  ]
  for (const item of cases) {
    it(item.name, () => {
      expect(snapPosition(item.input, item.area ?? area)).toEqual(item.expected)
    })
  }

  it('uses the given margin', () => {
    expect(snapPosition(rect(20, 500), area, 16, 24)).toEqual({ x: 24, y: 500 })
  })

  it('widens the axis search with a larger threshold', () => {
    expect(snapPosition(rect(left + 30, 500), area, 40)).toEqual({ x: left, y: 500 })
  })
})
