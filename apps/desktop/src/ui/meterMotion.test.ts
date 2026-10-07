import { describe, expect, it } from 'vitest'
import { applyClaudeMagnet, claudePointerVelocity, codexDragPosition, codexGradientAt, codexSnapProgress, outlineTickInfluence, stepOutlineSpring, stepOutlineCardSpring } from './meterMotion'

describe('reference motion ports', () => {
  it('matches Claude magnet strength and 90ms velocity clamp', () => {
    expect(applyClaudeMagnet(.25)).toBeCloseTo(.194375, 8)
    expect(claudePointerVelocity([{ time:100, value:0 }, { time:150, value:.5 }])).toBe(8)
    expect(claudePointerVelocity([{ time:100, value:.5 }, { time:150, value:0 }])).toBe(-8)
  })

  it('maps Codex drag through knob geometry and reproduces its 380ms overshoot curve', () => {
    expect(codexDragPosition(160, 0, 320, 320, 32)).toBeCloseTo(.5, 10)
    expect(codexSnapProgress(142.12)).toBeCloseTo(1.05, 8)
    expect(codexSnapProgress(380)).toBe(1)
  })

  it('interpolates Codex source blue into its five-stop Ultra gradient endpoints', () => {
    expect(codexGradientAt(0,5)).toEqual([[3,113,221],[3,113,221],[3,113,221]])
    expect(codexGradientAt(1,5)).toEqual([[13.75,109,218.75],[43.5,115.5,229],[37,113.5,226.5]])
    expect(codexGradientAt(2,5)).toEqual([[24.5,105,216.5],[84,118,237],[71,114,232]])
    expect(codexGradientAt(4,5)).toEqual([[46,97,212],[165,123,253],[139,115,243]])
    expect(codexGradientAt(1,1)).toEqual([[3,113,221],[3,113,221],[3,113,221]])
  })

  it('uses the outline Gaussian and semi-implicit spring subdivision constants', () => {
    expect(outlineTickInfluence(2, 2)).toBe(1)
    expect(outlineTickInfluence(3, 2)).toBeCloseTo(Math.exp(-1/(2*1.12*1.12)), 12)
    const state = stepOutlineSpring(0, 0, 1, 1/60)
    expect(state.value).toBeCloseTo(.1439914882, 8)
    expect(state.velocity).toBeCloseTo(10.237, 2)
  })

  it('ports the reference preview-card independent y and height springs with a 32ms frame cap',()=>{
    const full=stepOutlineCardSpring(0,0,100,0,0,80,.032)
    expect(full.y).toBeCloseTo(44.032,12)
    expect(full.yVelocity).toBe(1376)
    expect(full.height).toBeCloseTo(37.6832,12)
    expect(full.heightVelocity).toBeCloseTo(1177.6,12)
    expect(stepOutlineCardSpring(0,0,100,0,0,80,.1)).toEqual(full)
  })
})
