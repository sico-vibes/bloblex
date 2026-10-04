import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OUTFITS, type Outfit } from './outfit'
import { drawWardrobe, drawWardrobeBehind, mapBodyBoxToCircle } from './wardrobeDrawing'

class PathMock {
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  bezierCurveTo() {}
  closePath() {}
  ellipse() {}
  arc() {}
  arcTo() {}
  rect() {}
  addPath() {}
}

interface DrawCall { name: string; args: number[]; fillStyle: unknown }
function canvasRecorder() {
  const calls: DrawCall[] = []
  const ctx: Record<string, unknown> = { fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', globalAlpha: 1 }
  const methods = ['save', 'restore', 'beginPath', 'closePath', 'fill', 'stroke', 'clip', 'fillRect']
  const numericMethods = ['moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'roundRect', 'arcTo', 'arc', 'ellipse', 'translate', 'rotate', 'scale']
  for (const name of methods) ctx[name] = (...args: unknown[]) => calls.push({ name, args: args.filter((v): v is number => typeof v === 'number'), fillStyle: ctx.fillStyle })
  for (const name of numericMethods) ctx[name] = (...args: number[]) => calls.push({ name, args, fillStyle: ctx.fillStyle })
  for (const name of ['createLinearGradient', 'createRadialGradient']) ctx[name] = () => ({ addColorStop() {} })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

const eyes = (radius: number) => [
  { x: -0.31 * radius, y: -0.13 * radius, width: 0.24 * radius, height: 0.56 * radius, rotation: 0, visible: true },
  { x: 0.31 * radius, y: -0.13 * radius, width: 0.24 * radius, height: 0.56 * radius, rotation: 0, visible: true },
]

beforeEach(() => vi.stubGlobal('Path2D', PathMock))
afterEach(() => vi.unstubAllGlobals())

describe('projected outfit drawing', () => {
  it.each(OUTFITS)('%s dispatches through the outfit renderer', (outfit) => {
    const { ctx, calls } = canvasRecorder()
    drawWardrobeBehind(ctx, outfit, 36, eyes(36), 0.1, -0.05, 0.45, 0.2, 0.8)
    drawWardrobe(ctx, outfit, 36, eyes(36), 1, 0.1, -0.05, 0.45, 0.2)
    if (outfit === 'none' || outfit === 'auto') {
      expect(calls).toHaveLength(0)
      return
    }
    expect(calls.some((call) => call.name === 'fill' || call.name === 'stroke')).toBe(true)
    if (outfit === 'beanie' || outfit === 'santa-hat') expect(calls.some((call) => call.name === 'arc')).toBe(true)
    if (outfit === 'party-hat' || outfit === 'witch-hat' || outfit === 'crown') expect(calls.some((call) => call.name === 'lineTo')).toBe(true)
    if (outfit === 'sunglasses' || outfit === 'round-glasses') expect(calls.some((call) => call.name === 'arc' || call.name === 'arcTo')).toBe(true)
    if (outfit === 'bunny-ears') expect(calls.some((call) => call.name === 'ellipse')).toBe(true)
  })

  it('maps the source body box to a circle with a single scale mapping', () => {
    const { ctx, calls } = canvasRecorder()
    mapBodyBoxToCircle(ctx, { R: 40, rx: 45.6, ry: 35.2, view: 0, yaw: 0, pitch: 0, phys: { dx: 0, dy: 0 }, eyes: [], presence: 1, roll: 0 }, () => undefined)
    expect(calls.find((call) => call.name === 'scale')?.args).toEqual([1 / 1.14, 1 / 0.88])
  })

  it('retains every stable client outfit identifier', () => {
    const drawable: Outfit[] = ['none', 'party-hat', 'beanie', 'crown', 'sunglasses', 'round-glasses', 'bow', 'scarf', 'witch-hat', 'pumpkin', 'santa-hat', 'bunny-ears']
    expect(OUTFITS.filter((value) => value !== 'auto')).toEqual(drawable)
  })
})
