import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OUTFITS, type Outfit } from './outfit'
import { drawWardrobe, drawWardrobeBehind, fitOutfitToCanvas, mapBodyBoxToCircle } from './wardrobeDrawing'
import { BlobEngine, hexToRGB } from './blobEngine'

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
    if (outfit === 'party-hat' || outfit === 'witch-hat') expect(calls.some((call) => call.name === 'lineTo')).toBe(true)
    if (outfit === 'crown') expect(calls.some((call) => call.name === 'arc')).toBe(true)
    if (outfit === 'sunglasses' || outfit === 'round-glasses') expect(calls.some((call) => call.name === 'arc' || call.name === 'arcTo')).toBe(true)
    if (outfit === 'bunny-ears') expect(calls.some((call) => call.name === 'ellipse')).toBe(true)
  })

  it('maps the source body box to a circle with a single scale mapping', () => {
    const { ctx, calls } = canvasRecorder()
    mapBodyBoxToCircle(ctx, { R: 40, rx: 45.6, ry: 35.2, view: 0, yaw: 0, pitch: 0, phys: { dx: 0, dy: 0 }, eyes: [], presence: 1, roll: 0 }, () => undefined)
    expect(calls.find((call) => call.name === 'scale')?.args[0]).toBeCloseTo(1 / 1.14)
    expect(calls.find((call) => call.name === 'scale')?.args[1]).toBeCloseTo(1 / 0.88)
  })

  it('keeps every accessory silhouette inside square canvases at all preview and compact sizes', () => {
    const bounds: Partial<Record<Outfit, { left: number; right: number; top: number; bottom: number }>> = {
      'party-hat': { left: -0.8, right: 0.95, top: -2.75, bottom: 1 },
      beanie: { left: -1.2, right: 1.2, top: -1.65, bottom: 1 },
      crown: { left: -1.15, right: 1.15, top: -1.2, bottom: 1 },
      sunglasses: { left: -1.2, right: 1.2, top: -1.05, bottom: 1 },
      'round-glasses': { left: -1.2, right: 1.2, top: -1.05, bottom: 1 },
      bow: { left: -1, right: 1, top: -1.18, bottom: 1 },
      scarf: { left: -1.05, right: 1.05, top: -1, bottom: 1.65 },
      'witch-hat': { left: -1.6, right: 1.6, top: -2.15, bottom: 1 },
      pumpkin: { left: -1.1, right: 1.1, top: -1.42, bottom: 1 },
      'santa-hat': { left: -1.3, right: 1.3, top: -1.9, bottom: 1 },
      'bunny-ears': { left: -0.86, right: 0.86, top: -1.9, bottom: 1 },
      none: { left: -1, right: 1, top: -1, bottom: 1 },
    }
    const sizes = [30, 48, 64, 96, 144, 192]
    const views = [-0.58, 0, 0.58]
    for (const outfit of OUTFITS.filter((value) => value !== 'auto')) {
      const extent = bounds[outfit]
      expect(extent, `${outfit} has a canvas fit envelope`).toBeDefined()
      for (const size of sizes) {
        const radius = Math.min(size, size) * 0.4
        const fit = fitOutfitToCanvas(outfit, size, size, radius)
        const left = fit.offsetX + extent!.left * radius * fit.scale
        const right = fit.offsetX + extent!.right * radius * fit.scale
        const top = fit.offsetY + extent!.top * radius * fit.scale
        const bottom = fit.offsetY + extent!.bottom * radius * fit.scale
        expect(left, `${outfit} left safety margin at ${size}px`).toBeGreaterThanOrEqual(-size / 2 + 1)
        expect(right, `${outfit} right safety margin at ${size}px`).toBeLessThanOrEqual(size / 2 - 1)
        expect(top, `${outfit} top safety margin at ${size}px`).toBeGreaterThanOrEqual(-size / 2 + 1)
        expect(bottom, `${outfit} bottom safety margin at ${size}px`).toBeLessThanOrEqual(size / 2 - 1)
        for (const yaw of views) {
          const { ctx, calls } = canvasRecorder()
          drawWardrobeBehind(ctx, outfit, radius, eyes(radius), 0, 0, yaw, 0, 0, 1, false)
          drawWardrobe(ctx, outfit, radius, eyes(radius), 1, 0, 0, yaw, 0, 1, 0, false)
          if (outfit !== 'none') expect(calls.some((call) => call.name === 'fill' || call.name === 'stroke'), `${outfit} renders at yaw ${yaw}`).toBe(true)
        }
      }
    }
  })

  it('renders all outfits and blob colours at compact, medium and preview sizes in left, front and right views', () => {
    const colors = ['#e6e9ee', '#7db6ff', '#ff9bd0']
    const sizes = [30, 64, 192]
    const yaws = [-0.58, 0, 0.58]
    for (const outfit of OUTFITS.filter((value) => value !== 'auto')) {
      for (const color of colors) for (const size of sizes) for (const yaw of yaws) {
        const { ctx, calls } = canvasRecorder()
        const engine = new BlobEngine()
        engine.bodyColor = hexToRGB(color)
        engine.setOutfit(outfit, false)
        engine.yaw = yaw
        engine.draw(ctx, size, size)
        const outerScale = calls.find((call) => call.name === 'scale')?.args
        expect(outerScale?.[0], `${outfit} x body scale at ${size}px, yaw ${yaw}`).toBeCloseTo(outerScale?.[1] ?? Number.NaN)
        expect(calls.some((call) => call.name === 'fill'), `${outfit}, ${color}, ${size}px, yaw ${yaw}`).toBe(true)
      }
    }
  })

  it('retains every stable client outfit identifier', () => {
    const drawable: Outfit[] = ['none', 'party-hat', 'beanie', 'crown', 'sunglasses', 'round-glasses', 'bow', 'scarf', 'witch-hat', 'pumpkin', 'santa-hat', 'bunny-ears']
    expect(OUTFITS.filter((value) => value !== 'auto')).toEqual(drawable)
  })

  it('keeps the white brim continuous when no badge is rendered and reserves clearance when one is active', () => {
    const withoutBadge = canvasRecorder()
    const withBadge = canvasRecorder()
    drawWardrobe(withoutBadge.ctx, 'santa-hat', 36, eyes(36), 1, 0, 0, 0, 0, 1, 0, false)
    drawWardrobe(withBadge.ctx, 'santa-hat', 36, eyes(36), 1, 0, 0, 0, 0, 1, 0, true)
    const clipsWithoutBadge = withoutBadge.calls.filter((call) => call.name === 'clip').length
    const clipsWithBadge = withBadge.calls.filter((call) => call.name === 'clip').length
    expect(clipsWithBadge).toBe(clipsWithoutBadge + 1)
  })
})
