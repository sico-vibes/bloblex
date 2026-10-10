import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { blobCanvasSize, engineStateFor } from './BlobCanvas'
import { BADGE_OFFSET, BODY_RADIUS, BlobEngine, ENGINE_STATES } from './blobEngine'
import { GREETING_END_MS, greetPose } from './greetingScene'
import type { BlobMood } from './characterState'

let clock = 0
beforeEach(() => {
  clock = 1_000
  vi.stubGlobal('performance', { now: () => clock })
})
afterEach(() => vi.unstubAllGlobals())

function step(engine: BlobEngine, ms: number, frame = 16) {
  for (let elapsed = 0; elapsed < ms; elapsed += frame) {
    clock += frame
    engine.update(frame / 1000)
  }
}

describe('Bloblex character engine', () => {
  it('maps every Bloblex mood to an engine state', () => {
    const moods: BlobMood[] = ['idle', 'online', 'thinking', 'working', 'tool_activity', 'file_activity', 'file_drop', 'file_preparing', 'file_ready', 'file_sending', 'file_error', 'permission', 'success', 'error', 'offline', 'listening', 'rate_limited', 'sleeping']
    for (const mood of moods) expect(ENGINE_STATES[engineStateFor(mood)]).toBeDefined()
    expect(engineStateFor('permission')).toBe('approval')
    expect(engineStateFor('success')).toBe('finished')
    expect(engineStateFor('file_drop')).toBe('upload')
  })

  it('keeps the ring badge inside the canvas at the upper-left of the sphere', () => {
    const size = 100
    const R = size * BODY_RADIUS
    const x = R * BADGE_OFFSET.x
    const y = R * BADGE_OFFSET.y
    const ring = R * 0.34
    expect(x).toBeLessThan(0)
    expect(y).toBeLessThan(0)
    expect(x - ring).toBeGreaterThan(-size / 2)
    expect(y - ring).toBeGreaterThan(-size / 2)
  })

  it('follows the cursor by turning the eyes toward it', () => {
    const engine = new BlobEngine()
    engine.lookX = 0.8
    engine.lookY = 0.6
    step(engine, 600)
    expect(engine.yaw).toBeGreaterThan(0.3)
    expect(engine.pitch).toBeGreaterThan(0.2)
  })

  it('squashes on a poke, squints, and recovers', () => {
    const engine = new BlobEngine()
    engine.slap()
    step(engine, 80)
    expect(engine.sy).toBeLessThan(0.9)
    expect(engine.sx).toBeGreaterThan(1.05)
    expect(engine.eyeOverride).toBe('line')
    step(engine, 1000)
    expect(engine.sy).toBeCloseTo(1, 2)
    expect(engine.eyeOverride).toBeNull()
  })

  it('swaps the silhouette with a squash, and snaps under reduced motion', () => {
    const engine = new BlobEngine()
    expect(engine.form.shape).toBe('round')
    engine.setLook({ shape: 'sun', seed: 'a' })
    expect(engine.form.shape).toBe('sun')
    step(engine, 60)
    expect(engine.sy).toBeLessThan(0.95)
    step(engine, 600)
    expect(engine.sy).toBeCloseTo(1, 2)
    const form = engine.form
    engine.setLook({ shape: 'sun', seed: 'a' })
    expect(engine.form).toBe(form)
    engine.reducedMotion = true
    engine.setLook({ shape: 'triangle', seed: 'a' })
    expect(engine.form.shape).toBe('triangle')
    expect(engine.busy).toBe(false)
  })

  it('rolls once and sparks on completion, but not when mounted already finished', () => {
    const fresh = new BlobEngine()
    fresh.setState('finished', { force: true, silent: true })
    step(fresh, 100)
    expect(fresh.roll).toBe(0)

    const engine = new BlobEngine()
    engine.setState('working')
    engine.setState('finished')
    step(engine, 480)
    expect(engine.roll).toBeGreaterThan(1)
    step(engine, 600)
    expect(engine.roll).toBe(0)
  })

  it('morphs into the mailbox on file drop and back afterwards', () => {
    const engine = new BlobEngine()
    engine.setState('upload')
    step(engine, 700)
    expect(engine.morph).toBeCloseTo(1, 2)
    expect(engine.slotH).toBeGreaterThan(0.1)
    engine.setState('chewing')
    engine.setState('fileReady')
    step(engine, 900)
    expect(engine.morph).toBeCloseTo(0, 2)
  })

  it('snaps choreography in reduced motion instead of animating it', () => {
    const engine = new BlobEngine()
    engine.reducedMotion = true
    engine.setState('working')
    engine.setState('error')
    engine.update(0.016)
    expect(engine.ox).toBe(0)
    expect(engine.busy).toBe(false)
  })

  it('sizes the greeting stage to the 640×150 reference', () => {
    expect(blobCanvasSize(100, true)).toEqual({ width: 640, height: 150 })
    expect(blobCanvasSize(40, false)).toEqual({ width: 40, height: 40 })
  })

  it('follows the source greeting timeline: grow, squint, dip/pop, two-hand wave, tuck, badge, tint', () => {
    expect(GREETING_END_MS).toBe(4600)
    expect(greetPose(0).hb).toBeLessThan(5)
    expect(greetPose(0.45).hb).toBeCloseTo(58, 0)
    expect(greetPose(0.7).eye).toBe('happy')
    expect(greetPose(1.385).sy).toBeLessThan(1)
    expect(greetPose(1.385).eyeRoll).toBeGreaterThan(0.9)
    expect(greetPose(1.6).handL).toBeGreaterThan(0.9)
    expect(greetPose(1.6).handR).toBeGreaterThan(0.9)
    expect(greetPose(1.6).wave).toBeGreaterThan(0)
    expect(greetPose(2.5).eye).toBe('content')
    expect(greetPose(2.85).handL).toBeLessThan(0.05)
    expect(greetPose(3.1).badge).toBeGreaterThan(0.9)
    expect(greetPose(2.01).open).toBeLessThan(0.1)
    expect(greetPose(4.2).tint).toBeCloseTo(0.6, 2)
  })
})
