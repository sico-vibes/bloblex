import { describe, expect, it } from 'vitest'
import { BlobEngine, type EngineState } from './blobEngine'
import { OUTFITS } from './outfit'
import { BADGE_CLEARANCE, BADGE_OFFSET, BADGE_RADIUS, badgeBoundsAreClear } from './blobGeometry'
import { drawWardrobe, HAT_BOUNDS } from './wardrobeDrawing'

interface DrawCall { name: string; args: number[]; fillStyle?: string; strokeStyle?: string }

function canvasRecorder() {
  const calls: DrawCall[] = []
  const ctx: Record<string, unknown> = { fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt' }
  const pathMethods = ['save', 'restore', 'beginPath', 'closePath', 'fill', 'stroke']
  const numericMethods = ['moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'roundRect', 'arc', 'ellipse', 'translate', 'rotate', 'scale']
  for (const name of pathMethods) ctx[name] = () => calls.push({ name, args: [], fillStyle: String(ctx.fillStyle), strokeStyle: String(ctx.strokeStyle) })
  for (const name of numericMethods) ctx[name] = (...args: number[]) => calls.push({ name, args })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

const eyes = (radius: number) => [
  { x: -0.31 * radius, y: -0.13 * radius, width: 0.24 * radius, height: 0.56 * radius, rotation: 0, visible: true },
  { x: 0.31 * radius, y: -0.13 * radius, width: 0.24 * radius, height: 0.56 * radius, rotation: 0, visible: true },
]

const signatures: Partial<Record<(typeof OUTFITS)[number], { style: string; path: string; pathCalls?: number }>> = {
  'party-hat': { style: '#f3cf70', path: 'lineTo' },
  beanie: { style: '#627f78', path: 'ellipse' },
  crown: { style: '#edbd54', path: 'lineTo' },
  sunglasses: { style: 'rgba(38,48,61,.94)', path: 'roundRect' },
  'round-glasses': { style: 'rgba(252,248,238,.28)', path: 'roundRect' },
  bow: { style: '#c75c79', path: 'quadraticCurveTo', pathCalls: 4 },
  scarf: { style: '#da5b59', path: 'ellipse' },
  'witch-hat': { style: '#565276', path: 'lineTo' },
  'santa-hat': { style: '#da5b59', path: 'lineTo' },
}

const tinySignatures: Partial<Record<(typeof OUTFITS)[number], { style: string; path: string; pathCalls?: number }>> = {
  'party-hat': { style: '#6b82a2', path: 'lineTo' },
  beanie: { style: '#627f78', path: 'ellipse' },
  crown: { style: '#edbd54', path: 'lineTo' },
  sunglasses: { style: 'rgba(38,48,61,.94)', path: 'roundRect' },
  'round-glasses': { style: 'rgba(252,248,238,.28)', path: 'roundRect' },
  bow: { style: '#c75c79', path: 'quadraticCurveTo', pathCalls: 4 },
  scarf: { style: '#da5b59', path: 'ellipse' },
  'witch-hat': { style: '#565276', path: 'lineTo' },
  'santa-hat': { style: '#da5b59', path: 'lineTo' },
}

describe('procedural outfit drawing', () => {
  it.each(OUTFITS)('%s draws its own shape at avatar size', (outfit) => {
    const { ctx, calls } = canvasRecorder()
    drawWardrobe(ctx, outfit, 24, eyes(24), 1)
    if (outfit === 'auto' || outfit === 'none') {
      expect(calls).toHaveLength(0)
      return
    }
    const signature = signatures[outfit]!
    expect(calls.some((call) => call.name === 'fill' && call.fillStyle === signature.style)).toBe(true)
    const outfitPaths = calls.filter((call) => call.name === signature.path)
    if (signature.pathCalls !== undefined) expect(outfitPaths).toHaveLength(signature.pathCalls)
    else expect(outfitPaths.length).toBeGreaterThan(0)
    if (outfit === 'santa-hat') expect(calls.filter((call) => call.name === 'arc').length).toBeGreaterThan(0)
    if (outfit === 'crown') expect(calls.filter((call) => call.name === 'arc').length).toBeGreaterThan(0)
  })

  it.each(OUTFITS.filter((outfit) => outfit !== 'auto' && outfit !== 'none'))('%s keeps its silhouette at the 15px peer size', (outfit) => {
    const { ctx, calls } = canvasRecorder()
    drawWardrobe(ctx, outfit, 6, eyes(6), 1)
    const signature = tinySignatures[outfit]!
    expect(calls.some((call) => call.name === 'fill' && call.fillStyle === signature.style)).toBe(true)
    const outfitPaths = calls.filter((call) => call.name === signature.path)
    if (signature.pathCalls !== undefined) expect(outfitPaths).toHaveLength(signature.pathCalls)
    else expect(outfitPaths.length).toBeGreaterThan(0)
    if (outfit === 'scarf') expect(calls.some((call) => call.name === 'roundRect')).toBe(false)
    if (outfit === 'santa-hat' || outfit === 'crown' || outfit === 'beanie' || outfit === 'party-hat') {
      expect(calls.some((call) => call.name === 'arc')).toBe(false)
    }
    expect(calls.some((call) => call.strokeStyle === 'rgba(255,255,255,.55)')).toBe(false)
  })

  it.each(['working', 'approval'] as EngineState[])('%s eyewear clears the actual badge disk at an upper-left gaze', (state) => {
    const radius = 32
    const engine = new BlobEngine()
    engine.setState(state, { force: true, silent: true })
    engine.lookX = -1
    engine.lookY = 1
    engine.update(0.5)
    const frames = engine.wardrobeEyeFrames(radius)
    const leftEye = frames[0]
    for (const outfit of ['sunglasses', 'round-glasses'] as const) {
      const sunglasses = outfit === 'sunglasses'
      const lineWidth = Math.max(0.8, radius * 0.055)
      const lensBounds = (eye: typeof leftEye) => {
        const width = eye.width * (sunglasses ? 1.45 : 1.32)
        const height = Math.max(radius * 0.07, eye.height * (sunglasses ? 0.65 : 0.72) * engine.open)
        const absCos = Math.abs(Math.cos(eye.rotation))
        const absSin = Math.abs(Math.sin(eye.rotation))
        return {
          x: eye.x,
          y: eye.y,
          halfWidth: absCos * width / 2 + absSin * height / 2 + lineWidth / 2,
          halfHeight: absSin * width / 2 + absCos * height / 2 + lineWidth / 2,
        }
      }
      expect(badgeBoundsAreClear(lensBounds(leftEye), radius)).toBe(false)

      const { ctx, calls } = canvasRecorder()
      drawWardrobe(ctx, outfit, radius, frames, engine.open, 0, 0, engine.yaw, engine.pitch)
      const lensDraws = calls.filter((call) => call.name === 'translate').slice(0, 2)
      expect(lensDraws).toHaveLength(2)
      expect(lensDraws[0].args[0]).toBeGreaterThan(leftEye.x)
      for (const [index, lens] of lensDraws.entries()) {
        const expectedBounds = lensBounds(frames[index])
        expect(badgeBoundsAreClear({ ...expectedBounds, x: lens.args[0], y: lens.args[1] }, radius)).toBe(true)
      }
    }
    expect(BADGE_CLEARANCE).toBeGreaterThan(0)
  })

  it('keeps the drawn hat edge to the right of the actual ring edge', () => {
    const radius = 32
    const { ctx, calls } = canvasRecorder()
    drawWardrobe(ctx, 'party-hat', radius, eyes(radius), 1)
    const translations = calls.filter((call) => call.name === 'translate')
    const hatCenterX = translations[1].args[0]
    const hatLeft = hatCenterX - HAT_BOUNDS.halfWidth * radius
    const badgeRight = (BADGE_OFFSET.x + BADGE_RADIUS) * radius
    expect(hatLeft).toBeGreaterThan(badgeRight)
  })
})
