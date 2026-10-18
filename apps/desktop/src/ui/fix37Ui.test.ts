// FIX37 G2: the sidebar logo sits on the name's line, the side-conversation
// badge shadow falls below it, and every tooltip is clamped to the window.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { placeTooltip } from './tooltipPosition'

const css = (name: string) => readFileSync(resolve(process.cwd(), 'src/ui', name), 'utf8')

describe('sidebar bot row runtime logo', () => {
  const team = css('team.css')
  it('centres the logo on the name line in both looks', () => {
    expect(team).toMatch(/\.team-row-name \{[^}]*gap: 5px/)
    expect(team).toMatch(/\.team-row-name \.runtime-mark-tip \{[^}]*align-self: center/)
    expect(team).toMatch(/\.team-row-name \.runtime-mark-tip \{[^}]*display: inline-flex/)
  })
  it('closes the gap between the logo and the name', () => {
    expect(team).toMatch(/\.team-row-name \.runtime-mark-tip \{[^}]*margin-right: 0/)
  })
})

describe('side conversation badge', () => {
  const team = css('team.css')
  it('floats above the message-list fade so its shadow is not clipped', () => {
    // The conversation frame's top fade is z-index 3 (team.css / shell.css).
    expect(team).toMatch(/\.side-header \{[^}]*z-index: 4/)
  })
  it('casts a downward shadow that stays under the badge', () => {
    expect(team).toMatch(/\.side-header-pill \{[^}]*box-shadow: 0 10px 24px -6px/)
  })
})

describe('tooltip placement', () => {
  const view = { width: 400, height: 300 }
  it('shifts a bubble inside the window and keeps its preferred side when there is room', () => {
    const placed = placeTooltip({ left: 380, top: 140, right: 400, bottom: 160, width: 20, height: 20 }, { width: 200, height: 60 }, 'top', { viewport: view })
    expect(placed.left).toBe(view.width - 200 - 8)
    expect(placed.top).toBe(140 - 8 - 60)
    expect(placed.side).toBe('top')
  })
  it('flips below when the trigger is too close to the top', () => {
    const placed = placeTooltip({ left: 40, top: 4, right: 60, bottom: 24, width: 20, height: 20 }, { width: 200, height: 60 }, 'top', { viewport: view })
    expect(placed.side).toBe('bottom')
    expect(placed.top).toBe(24 + 8)
  })
  it('never lets a bubble leave the window', () => {
    const placed = placeTooltip({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }, { width: 500, height: 400 }, 'bottom', { viewport: view })
    expect(placed.left).toBeGreaterThanOrEqual(8)
    expect(placed.top).toBeGreaterThanOrEqual(8)
    expect(placed.left + placed.width).toBeLessThanOrEqual(view.width - 8)
    expect(placed.top + placed.height).toBeLessThanOrEqual(view.height - 8)
  })
})
