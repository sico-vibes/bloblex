import { describe, expect, it } from 'vitest'
import {
  BLOB_SHAPES, MASCOT_LOOK, agentLook, controlsFor, draftLook, normalizeLook, resolveForm, sameLook,
  shuffleLook, traitPosition, withTrait, type BlobLook,
} from '.'
import { formReach, turnEye, eyeAnchor } from './paint'
import type { FormLayout, Pt } from './forms'

const seeds = Array.from({ length: 60 }, (_, i) => `seed-${i}`)

function area(points: readonly Pt[]) {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[(i + 1) % points.length]
    sum += x0 * y1 - x1 * y0
  }
  return sum / 2
}

/** Every point of an eye's bounding ellipse stays inside the face ellipse. */
function eyesInsideFace(form: FormLayout) {
  return form.eyes.every((eye) => {
    const reach = Math.hypot(eye.rx, eye.ry)
    const dx = (Math.abs(eye.cx - form.face.cx) + reach) / form.face.rx
    const dy = (Math.abs(eye.cy - form.face.cy) + reach) / form.face.ry
    return Math.hypot(dx, dy) <= 1.0001
  })
}

describe('blob looks', () => {
  it('keeps both eyes inside the face, every outline clockwise and the figure on the canvas, for every shape', () => {
    for (const shape of BLOB_SHAPES) {
      for (const seed of seeds) {
        const form = resolveForm({ shape, seed })
        expect(form.shape).toBe(shape)
        expect(form.eyes).toHaveLength(2)
        expect(eyesInsideFace(form), `${shape} ${seed}`).toBe(true)
        expect(area(form.outline)).toBeGreaterThan(0)
        for (const extra of form.extras) expect(area(extra)).toBeGreaterThan(0)
        expect(formReach(form)).toBeLessThan(1.25)
      }
    }
  })

  it('is deterministic per seed, independent per trait, and pinned traits move only their own key', () => {
    const a = resolveForm({ shape: 'boxy', seed: 'Alain' })
    expect(resolveForm({ shape: 'boxy', seed: ' alain ' }).eyes).toEqual(a.eyes)
    expect(resolveForm({ shape: 'boxy', seed: 'alaim' }).eyes).not.toEqual(a.eyes)
    const look: BlobLook = { shape: 'boxy', seed: 'alain' }
    const before = traitPosition(look, 'eye.lean')
    const pinned = withTrait(look, 'eye.gap', 0.9)
    expect(traitPosition(pinned, 'eye.gap')).toBeCloseTo(0.9)
    expect(traitPosition(pinned, 'eye.lean')).toBe(before)
    expect(traitPosition(withTrait(look, ['eye.scale', 'eye.stretch'], 4), 'eye.stretch')).toBeLessThan(1)
  })

  it('draws the mascot as a symmetric round with tall eyes above the middle', () => {
    const form = resolveForm(MASCOT_LOOK)
    expect(form.shape).toBe('round')
    const [left, right] = form.eyes
    expect(left.cx + right.cx).toBeCloseTo(100, 1)
    expect(left.cy).toBeCloseTo(right.cy, 1)
    expect(left.cy).toBeLessThan(50)
    expect(left.ry / left.rx).toBeGreaterThan(2)
    expect(form.face.rx).toBeCloseTo(38, 0)
  })

  it('normalizes stored looks and fills defaults from the blob id', () => {
    expect(normalizeLook(null)).toBeNull()
    expect(normalizeLook({ shape: 'star' })).toBeNull()
    expect(normalizeLook({ shape: 'sun', seed: '', traits: { 'sun.n': 2, Bad: 0.2, 'eye.rx': Number.NaN, 'eye.gap': 0.3 } })).toEqual({ shape: 'sun', traits: { 'sun.n': 0.999999, 'eye.gap': 0.3 } })
    expect(agentLook({ id: 'agent-1' })).toEqual({ shape: 'round', seed: 'agent-1', traits: undefined })
    expect(agentLook({ id: 'agent-1', look: { shape: 'cat' } }).seed).toBe('agent-1')
    expect(draftLook({ look: null }, 'agent-2').seed).toBe('agent-2')
    expect(draftLook({ look: { shape: 'cloud', seed: 'mine' } }, 'agent-2')).toEqual({ shape: 'cloud', seed: 'mine' })
    expect(sameLook({ shape: 'cat', seed: 'a', traits: { x: 0.1, y: 0.2 } }, { shape: 'cat', seed: 'a', traits: { y: 0.2, x: 0.1 } })).toBe(true)
  })

  it('shuffles to a new seed, optionally a new shape, and drops pinned tweaks', () => {
    const values = [0.25, 0.97]
    const next = shuffleLook({ shape: 'round', seed: 'a', traits: { 'eye.rx': 0.2 } }, true, () => values.shift() ?? 0)
    expect(next.seed).not.toBe('a')
    expect(next.shape).toBe('cat')
    expect(next.traits).toBeUndefined()
    expect(shuffleLook({ shape: 'hexagon', seed: 'a' }).shape).toBe('hexagon')
  })

  it('offers only the controls a silhouette reads', () => {
    const labels = (shape: BlobLook['shape']) => controlsFor(shape).flatMap((group) => group.controls.map((control) => control.label))
    expect(labels('sun')).toContain('Petals')
    expect(labels('round')).not.toContain('Petals')
    expect(labels('round')).not.toContain('Tilt')
    expect(labels('triangle')).toContain('Corner rounding')
    expect(labels('droplet')).not.toContain('Tip length')
    expect(labels('round')).not.toContain('Proportion')
    expect(controlsFor('round').map((group) => group.title)).toEqual(['Eyes'])
  })

  it('turns eyes across the face and hides them past the edge', () => {
    const form = resolveForm(MASCOT_LOOK)
    const anchor = eyeAnchor(form.eyes[1], form)
    const rest = turnEye(anchor, 0, 0)
    expect(rest.x).toBeCloseTo(anchor.x)
    expect(rest.fx).toBeCloseTo(1)
    expect(turnEye(anchor, 0.5, 0).x).toBeGreaterThan(rest.x)
    expect(turnEye(anchor, 0, 0.4).y).toBeGreaterThan(rest.y)
    expect(turnEye(anchor, 0, Math.PI).z).toBeLessThan(0)
  })
})
