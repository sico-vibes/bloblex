import { describe, expect, it } from 'vitest'
import { companionWindowSize, COUCOU_SOURCE_GEOMETRY } from './companionLayout'

describe('floating companion shell geometry', () => {
  it('uses source Coucou geometry for the expanded island and a floating compact bar', () => {
    expect(COUCOU_SOURCE_GEOMETRY).toEqual({ compactWidth: 288, expandedWidth: 640, overviewHeight: 160, greetingHeight: 150 })
    expect(companionWindowSize('petit')).toEqual({ width: 344, height: 62 })
    expect(companionWindowSize('coucou')).toEqual({ width: 640, height: 160 })
    expect(companionWindowSize('home')).toEqual({ width: 640, height: 160 })
    expect(companionWindowSize('home-chat')).toEqual({ width: 640, height: 264 })
  })
})
