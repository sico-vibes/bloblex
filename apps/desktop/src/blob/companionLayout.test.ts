import { describe, expect, it } from 'vitest'
import { companionWindowSize, ISLAND_GEOMETRY } from './companionLayout'

describe('floating companion shell geometry', () => {
  it('uses the island geometry for the expanded island and a floating compact bar', () => {
    expect(ISLAND_GEOMETRY).toEqual({ compactWidth: 288, expandedWidth: 640, overviewHeight: 160, greetingHeight: 150 })
    expect(companionWindowSize('petit')).toEqual({ width: 344, height: 62 })
    expect(companionWindowSize('welcome')).toEqual({ width: 640, height: 160 })
    expect(companionWindowSize('home')).toEqual({ width: 640, height: 160 })
    expect(companionWindowSize('home-chat')).toEqual({ width: 640, height: 264 })
  })
})
