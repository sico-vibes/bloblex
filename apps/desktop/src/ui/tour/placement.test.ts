import { describe, expect, it } from 'vitest'
import { inflate, placeCard, rectsEqual } from './placement'

const viewport = { width: 1000, height: 700 }
const card = { width: 320, height: 160 }

describe('placeCard', () => {
  it('uses the preferred side when it has room and centres on the target', () => {
    const result = placeCard({ x: 400, y: 200, width: 100, height: 40 }, card, viewport, 'bottom')
    expect(result.placement).toBe('bottom')
    expect(result.y).toBe(200 + 40 + 14)
    expect(result.x).toBe(450 - 160)
    expect(result.arrowOffset).toBe(160)
    expect(result.overlapping).toBe(false)
  })

  it('flips to the opposite side when the preferred side would leave the window', () => {
    const result = placeCard({ x: 400, y: 600, width: 100, height: 40 }, card, viewport, 'bottom')
    expect(result.placement).toBe('top')
    expect(result.y).toBe(600 - 160 - 14)
  })

  it('clamps into the viewport and keeps the arrow on the target', () => {
    const result = placeCard({ x: 8, y: 300, width: 40, height: 40 }, card, viewport, 'bottom')
    expect(result.x).toBe(12)
    // Target centre is 28, card starts at 12, so the arrow sits 16 px in, held to the 20 px inset.
    expect(result.arrowOffset).toBe(20)
  })

  it('places a sidebar target to its right', () => {
    const result = placeCard({ x: 0, y: 100, width: 280, height: 400 }, card, viewport, 'right')
    expect(result.placement).toBe('right')
    expect(result.x).toBe(280 + 14)
    expect(result.y).toBe(300 - 80)
  })

  it('falls back to the side with the least overflow in a tiny window', () => {
    const tiny = { width: 360, height: 240 }
    const result = placeCard({ x: 20, y: 20, width: 320, height: 200 }, card, tiny, 'bottom')
    expect(result.x).toBeGreaterThanOrEqual(12)
    expect(result.y).toBeGreaterThanOrEqual(12)
    expect(result.x + card.width).toBeLessThanOrEqual(tiny.width - 12)
    expect(result.y + card.height).toBeLessThanOrEqual(tiny.height - 12)
  })
})

describe('geometry helpers', () => {
  it('inflates a rect symmetrically', () => {
    expect(inflate({ x: 10, y: 10, width: 20, height: 20 }, 4)).toEqual({ x: 6, y: 6, width: 28, height: 28 })
  })
  it('compares rects with sub-pixel tolerance', () => {
    expect(rectsEqual({ x: 1, y: 1, width: 5, height: 5 }, { x: 1.2, y: 1, width: 5, height: 5.3 })).toBe(true)
    expect(rectsEqual({ x: 1, y: 1, width: 5, height: 5 }, { x: 3, y: 1, width: 5, height: 5 })).toBe(false)
    expect(rectsEqual(null, null)).toBe(true)
    expect(rectsEqual(null, { x: 0, y: 0, width: 1, height: 1 })).toBe(false)
  })
})
