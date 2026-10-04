import type { Outfit } from './outfit'
import { clearAccessoryOfBadge } from './blobGeometry'

export interface WardrobeEyeFrame { x: number; y: number; width: number; height: number; rotation: number; visible: boolean }

const ink = '#202027'
const cream = '#fff0cc'
const red = '#da5b59'
const gold = '#edbd54'
export const HAT_BOUNDS = { halfWidth: 0.70, halfHeight: 0.44 } as const
function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2))
}

function band(ctx: CanvasRenderingContext2D, R: number, color: string, y = -0.7, thickness = 0.15) {
  ctx.save()
  ctx.beginPath()
  ctx.ellipse(0, y * R, Math.sqrt(1 - y * y) * R * 0.94, thickness * R, 0, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  ctx.strokeStyle = 'rgba(32,32,39,.32)'
  ctx.lineWidth = Math.max(0.7, R * 0.025)
  ctx.stroke()
  ctx.restore()
}

function drawHat(ctx: CanvasRenderingContext2D, outfit: Outfit, R: number, x: number, y: number) {
  const detail = R >= 14
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(1, 0.34)
  ctx.rotate(-0.12)
  if (outfit === 'beanie') {
    ctx.fillStyle = '#627f78'
    ctx.beginPath(); ctx.ellipse(0, 0, 0.62 * R, 0.28 * R, 0, Math.PI, Math.PI * 2); ctx.fill()
    ctx.fillStyle = cream
    ctx.beginPath(); ctx.ellipse(0, 0.08 * R, 0.63 * R, 0.11 * R, 0, 0, Math.PI * 2); ctx.fill()
    ctx.strokeStyle = 'rgba(32,32,39,.32)'; ctx.lineWidth = Math.max(0.7, R * 0.025); ctx.stroke()
    if (detail) { ctx.fillStyle = cream; ctx.beginPath(); ctx.arc(0, -0.3 * R, 0.11 * R, 0, Math.PI * 2); ctx.fill() }
  } else if (outfit === 'crown') {
    ctx.fillStyle = gold
    ctx.strokeStyle = '#86642c'
    ctx.lineWidth = Math.max(0.8, R * 0.035)
    ctx.beginPath(); ctx.moveTo(-0.53 * R, 0.12 * R); ctx.lineTo(-0.5 * R, -0.33 * R); ctx.lineTo(-0.19 * R, -0.08 * R); ctx.lineTo(0, -0.48 * R); ctx.lineTo(0.2 * R, -0.08 * R); ctx.lineTo(0.51 * R, -0.34 * R); ctx.lineTo(0.53 * R, 0.12 * R); ctx.closePath(); ctx.fill(); ctx.stroke()
    rounded(ctx, -0.54 * R, 0.02 * R, 1.08 * R, 0.2 * R, 0.07 * R); ctx.fill(); ctx.stroke()
    if (detail) { ctx.fillStyle = red; for (const dx of [-0.29, 0, 0.29]) { ctx.beginPath(); ctx.arc(dx * R, 0.11 * R, 0.055 * R, 0, Math.PI * 2); ctx.fill() } }
  } else {
    const witch = outfit === 'witch-hat'
    const santa = outfit === 'santa-hat'
    const party = outfit === 'party-hat'
    ctx.fillStyle = witch ? '#565276' : santa ? red : '#6b82a2'
    ctx.strokeStyle = 'rgba(32,32,39,.75)'
    ctx.lineWidth = Math.max(0.8, R * 0.035)
    ctx.beginPath()
    if (party) {
      ctx.moveTo(-0.36 * R, 0.12 * R); ctx.lineTo(0, -0.82 * R); ctx.lineTo(0.36 * R, 0.12 * R)
      ctx.quadraticCurveTo(0, 0.2 * R, -0.36 * R, 0.12 * R)
    } else {
      ctx.moveTo(-0.52 * R, 0.08 * R)
      ctx.quadraticCurveTo(-0.12 * R, 0.2 * R, 0.51 * R, 0.07 * R)
      ctx.lineTo(witch ? 0.17 * R : 0.12 * R, -0.78 * R)
      ctx.quadraticCurveTo(0.06 * R, -0.95 * R, -0.07 * R, -0.78 * R)
    }
    ctx.closePath(); ctx.fill(); ctx.stroke()
    ctx.fillStyle = witch ? '#28253f' : santa || party ? cream : '#a9c1cf'
    ctx.beginPath(); ctx.ellipse(0, 0.08 * R, 0.58 * R, 0.12 * R, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    if (santa && detail) { ctx.fillStyle = cream; ctx.beginPath(); ctx.arc(0.1 * R, -0.77 * R, 0.13 * R, 0, Math.PI * 2); ctx.fill() }
    if (outfit === 'party-hat' && detail) {
      ctx.fillStyle = '#f3cf70'
      for (const [dx, dy] of [[-0.22, -0.22], [0.14, -0.45], [0.24, -0.02]]) { ctx.beginPath(); ctx.arc(dx * R, dy * R, 0.05 * R, 0, Math.PI * 2); ctx.fill() }
    }
  }
  ctx.restore()
}

function drawGlasses(ctx: CanvasRenderingContext2D, outfit: Outfit, R: number, eyes: WardrobeEyeFrame[], blink: number) {
  const sunglasses = outfit === 'sunglasses'
  const lineWidth = Math.max(0.8, R * 0.055)
  const visibleEyes = eyes.filter((eye) => eye.visible)
  const dimensions = visibleEyes.map((eye) => {
    const width = eye.width * (sunglasses ? 1.45 : 1.32)
    const height = Math.max(R * 0.07, eye.height * (sunglasses ? 0.65 : 0.72) * blink)
    const absCos = Math.abs(Math.cos(eye.rotation))
    const absSin = Math.abs(Math.sin(eye.rotation))
    return {
      eye, width, height,
      halfWidth: absCos * width / 2 + absSin * height / 2 + lineWidth / 2,
      halfHeight: absSin * width / 2 + absCos * height / 2 + lineWidth / 2,
    }
  })
  if (!dimensions.length) return
  const minX = Math.min(...dimensions.map(({ eye, halfWidth }) => eye.x - halfWidth))
  const maxX = Math.max(...dimensions.map(({ eye, halfWidth }) => eye.x + halfWidth))
  const minY = Math.min(...dimensions.map(({ eye, halfHeight }) => eye.y - halfHeight))
  const maxY = Math.max(...dimensions.map(({ eye, halfHeight }) => eye.y + halfHeight))
  const group = clearAccessoryOfBadge({ x: (minX + maxX) / 2, y: (minY + maxY) / 2, halfWidth: (maxX - minX) / 2, halfHeight: (maxY - minY) / 2 }, R)
  const groupShiftX = group.x - (minX + maxX) / 2
  const groupShiftY = group.y - (minY + maxY) / 2
  ctx.save()
  ctx.strokeStyle = ink
  ctx.lineWidth = lineWidth
  ctx.lineCap = 'round'
  const lensCenters: Array<{ x: number; y: number }> = []
  for (const { eye, width: w, height: h, halfWidth, halfHeight } of dimensions) {
    const lens = clearAccessoryOfBadge({ x: eye.x + groupShiftX, y: eye.y + groupShiftY, halfWidth, halfHeight }, R)
    lensCenters.push({ x: lens.x, y: lens.y })
    ctx.save()
    ctx.translate(lens.x, lens.y)
    ctx.rotate(eye.rotation)
    ctx.fillStyle = sunglasses ? 'rgba(38,48,61,.94)' : 'rgba(252,248,238,.28)'
    rounded(ctx, -w / 2, -h / 2, w, h, sunglasses ? R * 0.12 : h / 2)
    ctx.fill(); ctx.stroke()
    if (sunglasses && R >= 13) {
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = Math.max(0.5, R * 0.018)
      ctx.beginPath(); ctx.moveTo(-w * 0.22, -h * 0.18); ctx.lineTo(w * 0.08, -h * 0.18); ctx.stroke()
    }
    ctx.restore()
  }
  if (lensCenters.length === 2) {
    ctx.beginPath(); ctx.moveTo(lensCenters[0].x + eyes[0].width * 0.58, lensCenters[0].y); ctx.lineTo(lensCenters[1].x - eyes[1].width * 0.58, lensCenters[1].y); ctx.stroke()
  }
  ctx.restore()
}

export function drawWardrobe(ctx: CanvasRenderingContext2D, outfit: Outfit, R: number, eyes: WardrobeEyeFrame[], blink: number, lagX = 0, lagY = 0, yaw = 0, pitch = 0) {
  if (outfit === 'auto' || outfit === 'none' || R < 2) return
  if (['party-hat', 'beanie', 'crown', 'witch-hat', 'santa-hat'].includes(outfit)) {
    const offsetX = Math.sin(yaw) * R * 0.12
    const offsetY = Math.sin(pitch) * R * 0.08
    const scaleX = Math.max(0.68, Math.cos(yaw))
    const scaleY = Math.max(0.76, Math.cos(pitch))
    const requestedX = 0.3 * R + lagX * R
    const requestedY = -0.98 * R + lagY * R
    const safe = clearAccessoryOfBadge({ x: offsetX + requestedX * scaleX, y: offsetY + requestedY * scaleY, halfWidth: HAT_BOUNDS.halfWidth * R * scaleX, halfHeight: HAT_BOUNDS.halfHeight * R * scaleY }, R)
    ctx.save()
    ctx.translate(offsetX, offsetY)
    ctx.scale(scaleX, scaleY)
    drawHat(ctx, outfit, R, (safe.x - offsetX) / scaleX, (safe.y - offsetY) / scaleY)
    ctx.restore()
  }
  if (outfit === 'sunglasses' || outfit === 'round-glasses') drawGlasses(ctx, outfit, R, eyes, blink)
  if (outfit === 'bow') {
    const safe = clearAccessoryOfBadge({ x: 0, y: 0.47 * R, halfWidth: 0.68 * R, halfHeight: 0.45 * R }, R)
    ctx.save(); ctx.translate(safe.x, safe.y + 0.06 * R); ctx.rotate(-0.08)
    ctx.fillStyle = '#c75c79'; ctx.strokeStyle = ink; ctx.lineWidth = Math.max(0.7, R * 0.03)
    ctx.beginPath(); ctx.moveTo(-0.11 * R, 0); ctx.quadraticCurveTo(-0.62 * R, -0.5 * R, -0.55 * R, 0.02 * R); ctx.quadraticCurveTo(-0.5 * R, 0.38 * R, -0.11 * R, 0.08 * R); ctx.closePath(); ctx.fill(); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0.11 * R, 0); ctx.quadraticCurveTo(0.62 * R, -0.5 * R, 0.55 * R, 0.02 * R); ctx.quadraticCurveTo(0.5 * R, 0.38 * R, 0.11 * R, 0.08 * R); ctx.closePath(); ctx.fill(); ctx.stroke()
    ctx.fillStyle = gold; ctx.beginPath(); ctx.arc(0, 0.035 * R, 0.13 * R, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore()
  }
  if (outfit === 'scarf') {
    const wrap = clearAccessoryOfBadge({ x: 0, y: 0.69 * R, halfWidth: 0.70 * R, halfHeight: 0.21 * R }, R)
    ctx.save(); ctx.translate(wrap.x, wrap.y - 0.69 * R); band(ctx, R, red, 0.69, 0.19); ctx.restore()
    if (R >= 11) {
      const tail = clearAccessoryOfBadge({ x: 0.38 * R, y: 1.05 * R, halfWidth: 0.18 * R, halfHeight: 0.36 * R }, R)
      ctx.save(); ctx.translate(tail.x, tail.y - 0.3 * R); ctx.rotate(0.22)
      ctx.fillStyle = red; ctx.strokeStyle = 'rgba(32,32,39,.5)'; ctx.lineWidth = Math.max(0.7, R * 0.025)
      rounded(ctx, -0.16 * R, -0.02 * R, 0.31 * R, 0.64 * R, 0.08 * R); ctx.fill(); ctx.stroke()
      ctx.restore()
    }
  }
}
