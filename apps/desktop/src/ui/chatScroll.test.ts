import { describe, expect, it } from 'vitest'
import { CHAT_STICK_THRESHOLD, earlierWindow, isNearBottom, metricsOf, type ScrollSource } from './chatScroll'

const element = (scrollTop: number, scrollHeight: number, clientHeight: number): ScrollSource => ({ scrollTop, scrollHeight, clientHeight })

describe('isNearBottom', () => {
  it('follows at the bottom and inside the threshold', () => {
    expect(isNearBottom(metricsOf(element(400, 500, 100)))).toBe(true)
    expect(isNearBottom(metricsOf(element(500 - 100 - CHAT_STICK_THRESHOLD, 500, 100)))).toBe(true)
  })

  it('stops following once the person has scrolled up past the threshold', () => {
    expect(isNearBottom(metricsOf(element(0, 500, 100)))).toBe(false)
    expect(isNearBottom(metricsOf(element(500 - 100 - CHAT_STICK_THRESHOLD - 1, 500, 100)))).toBe(false)
  })

  it('treats a missing or unmeasurable element as at the bottom', () => {
    expect(isNearBottom(null)).toBe(true)
    expect(metricsOf(null)).toBeNull()
    expect(metricsOf(element(NaN, 500, 100))).toBeNull()
  })
})

describe('earlierWindow', () => {
  it('shows the requested count, offers more until the top, and caps at the total', () => {
    expect(earlierWindow(8, 20)).toEqual({ shown: 8, canLoad: true, next: 16 })
    expect(earlierWindow(16, 20)).toEqual({ shown: 16, canLoad: true, next: 20 })
    expect(earlierWindow(20, 20)).toEqual({ shown: 20, canLoad: false, next: 20 })
    expect(earlierWindow(8, 8)).toEqual({ shown: 8, canLoad: false, next: 8 })
    expect(earlierWindow(8, 3)).toEqual({ shown: 3, canLoad: false, next: 3 })
    expect(earlierWindow(0, 3)).toEqual({ shown: 0, canLoad: true, next: 3 })
  })
})
