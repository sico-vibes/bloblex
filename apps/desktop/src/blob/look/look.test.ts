import { describe, expect, it } from 'vitest'
import {
  BLOB_SHAPES, MASCOT_LOOK, agentLook, controlsFor, draftLook, normalizeLook, resolveForm, sameLook,
  shuffleLook, traitPosition, withTrait, randomBot, BOT_SHAPES, defaultBotShape, type BlobLook,
} from '.'
import { formReach, turnEye, eyeAnchor } from './paint'
import { layoutForm, type FormLayout, type Pt } from './forms'
import { traits } from './seed'

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
  it('offers exactly the eight target shapes', () => {
    expect([...BLOB_SHAPES]).toEqual(['circle', 'pebble', 'squircle', 'capsule', 'triangle', 'hexagon', 'cloud', 'droplet'])
  })

  it('keeps the complete silhouette fixed and mirror symmetric, with mirrored vertical eyes at rest', () => {
    for (const shape of BLOB_SHAPES) {
      const baseline = resolveForm({ shape, seed: seeds[0] })
      for (const seed of seeds.slice(0, 12)) {
        const form = resolveForm({ shape, seed })
        expect(form.outline, `${shape} outline`).toEqual(baseline.outline)
        expect(form.petals, `${shape} petals`).toEqual(baseline.petals)
        expect(form.extras, `${shape} extras`).toEqual(baseline.extras)
        for (const outline of [form.outline, ...form.extras]) {
          for (const [x, y] of outline) {
            const distance = Math.min(...outline.map(([mx, my]) => Math.hypot(mx - (100 - x), my - y)))
            expect(distance, `${shape} reflected point`).toBeLessThan(0.00001)
          }
        }
        for (const petal of form.petals) {
          expect(form.petals.some((other) => Math.abs(other.cx + petal.cx - 100) < 0.00001 && Math.abs(other.cy - petal.cy) < 0.00001 && other.r === petal.r)).toBe(true)
        }
        const [left, right] = form.eyes
        expect(left.cx + right.cx).toBeCloseTo(100, 8)
        expect({ ...left, cx: right.cx }).toEqual(right)
        expect(left.rot).toBe(0)
        expect(left.ry / left.rx).toBeGreaterThanOrEqual(2)
        expect(left.n).toBeGreaterThanOrEqual(2.4)
        expect(left.n).toBeLessThanOrEqual(3.6)
      }
    }
  })

  it('makes the eyes visibly squarer across the full Squareness range', () => {
    for (const shape of BLOB_SHAPES) {
      const rounder = resolveForm({ shape, seed: 'squareness', traits: { 'eye.n': 0 } })
      const squarer = resolveForm({ shape, seed: 'squareness', traits: { 'eye.n': 0.999999 } })
      for (let i = 0; i < 2; i++) {
        expect(rounder.eyes[i].n).toBe(2.4)
        expect(squarer.eyes[i].n).toBeCloseTo(3.6, 5)
        expect(squarer.eyes[i].n - rounder.eyes[i].n).toBeGreaterThan(1.19)
      }
    }
  })

  it('migrates every old stored name while retaining seed, traits and robot styling', () => {
    const migrations = { round: 'circle', organic: 'pebble', boxy: 'squircle', sun: 'circle', cat: 'pebble' }
    for (const [old, shape] of Object.entries(migrations)) {
      expect(normalizeLook({ shape: old, seed: 'saved', traits: { 'eye.gap': 0.3 }, bot: { shape: 'hexagon' } })).toEqual({ shape, seed: 'saved', traits: { 'eye.gap': 0.3 }, bot: { shape: 'hexagon' } })
    }
    expect(normalizeLook({ shape: 'constructor' })).toBeNull()
    expect(normalizeLook({ shape: '__proto__' })).toBeNull()
    for (const shape of BLOB_SHAPES) expect(normalizeLook({ shape })?.shape).toBe(shape)
  })

  it('ignores old tilt, body and asymmetric-eye pins even at the trait extremes', () => {
    for (const shape of BLOB_SHAPES) {
      const baseline = layoutForm(shape, traits('saved'))
      for (const position of [0, 0.999999]) {
        const form = layoutForm(shape, traits('saved', Object.fromEntries([
          'body.r', 'body.n', 'body.ratio', 'body.rot', 'poly.round', 'cloud.n', 'cloud.r0',
          'droplet.tip', 'capsule.squat', 'eye.scale', 'eye.stretch', 'eye.lean', 'eye.lean2', 'eye.dy', 'gaze.x',
        ].map((key) => [key, position]))))
        expect(form).toEqual(baseline)
        const tuned = resolveForm({ shape, traits: Object.fromEntries(['eye.rx', 'eye.ratio', 'eye.gap', 'eye.n', 'gaze.y'].map((key) => [key, position])) })
        expect(eyesInsideFace(tuned), `${shape} ${position}`).toBe(true)
        expect(tuned.eyes[0].rot).toBe(0)
        expect(tuned.eyes[1]).toEqual({ ...tuned.eyes[0], cx: 100 - tuned.eyes[0].cx })
      }
    }
  })

  it('keeps each robot outline when randomizing colours, including inferred outlines', () => {
    for (const shape of BOT_SHAPES) expect(randomBot(shape, () => 0.5).shape).toBe(shape)
    expect(defaultBotShape('circle')).toBe('circle')
    expect(defaultBotShape('pebble')).toBe('circle')
    expect(defaultBotShape('squircle')).toBe('square')
  })
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
    const a = resolveForm({ shape: 'squircle', seed: 'Alain' })
    expect(resolveForm({ shape: 'squircle', seed: ' alain ' }).eyes).toEqual(a.eyes)
    expect(resolveForm({ shape: 'squircle', seed: 'alaim' }).eyes).not.toEqual(a.eyes)
    const look: BlobLook = { shape: 'squircle', seed: 'alain' }
    const before = traitPosition(look, 'eye.lean')
    const pinned = withTrait(look, 'eye.gap', 0.9)
    expect(traitPosition(pinned, 'eye.gap')).toBeCloseTo(0.9)
    expect(traitPosition(pinned, 'eye.lean')).toBe(before)
    expect(traitPosition(withTrait(look, ['eye.scale', 'eye.stretch'], 4), 'eye.stretch')).toBeLessThan(1)
  })

  it('draws the mascot as a symmetric round with tall eyes above the middle', () => {
    const form = resolveForm(MASCOT_LOOK)
    expect(form.shape).toBe('circle')
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
    expect(normalizeLook({ shape: 'sun', seed: '', traits: { 'sun.n': 2, Bad: 0.2, 'eye.rx': Number.NaN, 'eye.gap': 0.3 } })).toEqual({ shape: 'circle', traits: { 'sun.n': 0.999999, 'eye.gap': 0.3 } })
    expect(agentLook({ id: 'agent-1' })).toEqual({ shape: 'circle', seed: 'agent-1', traits: undefined })
    expect(agentLook({ id: 'agent-1', look: { shape: 'cat' } }).seed).toBe('agent-1')
    expect(draftLook({ look: null }, 'agent-2').seed).toBe('agent-2')
    expect(draftLook({ look: { shape: 'cloud', seed: 'mine' } }, 'agent-2')).toEqual({ shape: 'cloud', seed: 'mine' })
    expect(sameLook({ shape: 'pebble', seed: 'a', traits: { x: 0.1, y: 0.2 } }, { shape: 'pebble', seed: 'a', traits: { y: 0.2, x: 0.1 } })).toBe(true)
  })

  it('shuffles only the eyes and retains the silhouette and alternate robot style', () => {
    for (const shape of BLOB_SHAPES) {
      const look: BlobLook = { shape, seed: 'a', traits: { 'eye.rx': 0.2 }, bot: { shape: 'hexagon', shell: '#112233' } }
      const next = shuffleLook(look, () => 0.25)
      expect(next.seed).not.toBe('a')
      expect(next.shape).toBe(shape)
      expect(next.traits).toBeUndefined()
      expect(next.bot).toEqual(look.bot)
      expect(resolveForm(next).eyes).not.toEqual(resolveForm(look).eyes)
    }
  })

  it('offers only the controls a silhouette reads', () => {
    const labels = (shape: BlobLook['shape']) => controlsFor(shape).flatMap((group) => group.controls.map((control) => control.label))
    for (const shape of BLOB_SHAPES) {
      expect(labels(shape)).not.toContain('Tilt')
      expect(labels(shape)).not.toContain('Asymmetry')
      expect(labels(shape)).not.toContain('Corner rounding')
    }
    expect(labels('droplet')).not.toContain('Tip length')
    expect(labels('circle')).not.toContain('Proportion')
    expect(controlsFor('circle').map((group) => group.title)).toEqual(['Eyes'])
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
