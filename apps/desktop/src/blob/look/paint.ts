// Canvas tracing for blob looks. Coordinates are centred on the frame (the
// 100×100 layout's 50,50) and scaled by `unit` pixels per layout unit.

import { superellipse, type FormEye, type FormLayout, type Pt } from './forms'

/** Layout units per body radius: a full-size round blob is 38 units across its radius. */
export const UNITS_PER_RADIUS = 38

/** Ray → rounded-rect boundary intersection, for the mailbox morph. */
export function rrPoint(ca: number, sa: number, W: number, H: number, cr: number) {
  const eps = 1e-6
  const kx = ca >= 0 ? 1 : -1
  const ky = sa >= 0 ? 1 : -1
  const cx = kx * (W - cr)
  const cy = ky * (H - cr)
  const dot = ca * cx + sa * cy
  const disc = dot * dot - (cx * cx + cy * cy - cr * cr)
  if (disc >= 0) {
    const t = dot + Math.sqrt(disc)
    if (t > eps) {
      const px = ca * t
      const py = sa * t
      if (Math.abs(px) >= W - cr - eps && Math.abs(py) >= H - cr - eps) return { x: px, y: py }
    }
  }
  if (Math.abs(sa) > eps) {
    const t = (ky * H) / sa
    if (t > eps && Math.abs(ca * t) <= W - cr + eps) return { x: ca * t, y: ky * H }
  }
  if (Math.abs(ca) > eps) {
    const t = (kx * W) / ca
    if (t > eps && Math.abs(sa * t) <= H - cr + eps) return { x: kx * W, y: sa * t }
  }
  return { x: kx * W, y: ky * H }
}

function polyline(ctx: CanvasRenderingContext2D, points: readonly Pt[], unit: number, R: number, morph: number) {
  for (let i = 0; i < points.length; i++) {
    let x = (points[i][0] - 50) * unit
    let y = (points[i][1] - 50) * unit
    if (morph > 0.001) {
      const a = Math.atan2(y, x)
      const box = rrPoint(Math.cos(a), Math.sin(a), R, R * 0.94, R * 0.42)
      x += (box.x - x) * morph
      y += (box.y - y) * morph
    }
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

/**
 * Adds the whole silhouette (core, petals and extras) as clockwise subpaths,
 * so one non-zero fill or clip covers the union. `morph` eases it into the
 * rounded mailbox box of half-width `R`; the petals shrink away as it does.
 */
export function traceForm(ctx: CanvasRenderingContext2D, form: FormLayout, unit: number, R: number, morph = 0) {
  ctx.beginPath()
  polyline(ctx, form.outline, unit, R, morph)
  for (const extra of form.extras) polyline(ctx, extra, unit, R, morph)
  const keep = 1 - morph
  if (keep > 0.01) {
    for (const petal of form.petals) {
      const x = (petal.cx - 50) * unit * keep
      const y = (petal.cy - 50) * unit * keep
      const r = petal.r * unit * keep
      ctx.moveTo(x + r, y)
      ctx.arc(x, y, r, 0, Math.PI * 2)
    }
  }
}

/** The extent of a look from its centre, in body radii, for fitting it into a frame. */
const reaches = new WeakMap<FormLayout, number>()

export function formReach(form: FormLayout) {
  const known = reaches.get(form)
  if (known !== undefined) return known
  let reach = 0
  for (const [x, y] of [...form.outline, ...form.extras.flat()]) reach = Math.max(reach, Math.hypot(x - 50, y - 50))
  for (const petal of form.petals) reach = Math.max(reach, Math.hypot(petal.cx - 50, petal.cy - 50) + petal.r)
  reach /= UNITS_PER_RADIUS
  reaches.set(form, reach)
  return reach
}

const eyeCache = new Map<string, Pt[]>()

/** A superellipse eye centred on the origin, `rx` × `ry` pixels, leaned by `rot` degrees. */
export function eyePath(ctx: CanvasRenderingContext2D, rx: number, ry: number, n: number, rot: number) {
  const key = `${n.toFixed(2)}`
  let unitEye = eyeCache.get(key)
  if (!unitEye) {
    unitEye = superellipse({ cx: 0, cy: 0, rx: 1, ry: 1, n }, 6)
    eyeCache.set(key, unitEye)
  }
  const t = (rot * Math.PI) / 180
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  ctx.beginPath()
  for (let i = 0; i < unitEye.length; i++) {
    const x = unitEye[i][0] * rx
    const y = unitEye[i][1] * ry
    const px = x * cos - y * sin
    const py = x * sin + y * cos
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
}

/** Where an eye sits on the face, as a point on the face's ellipsoid. */
export interface EyeAnchor { x: number; y: number; z: number }

export function eyeAnchor(eye: FormEye, form: FormLayout): EyeAnchor {
  const x = Math.max(-0.95, Math.min(0.95, (eye.cx - form.face.cx) / form.face.rx))
  const y = Math.max(-0.95, Math.min(0.95, -(eye.cy - form.face.cy) / form.face.ry))
  return { x, y, z: Math.sqrt(Math.max(0.05, 1 - x * x - y * y)) }
}

/**
 * Turns an eye across the face: pitch (looking up, and the roll) about the
 * horizontal axis, then yaw about the vertical one. Returns the screen
 * position on the unit face, a depth for back-face culling, and the
 * foreshortening relative to the resting pose (1 at rest).
 */
export function turnEye(anchor: EyeAnchor, yaw: number, pitch: number) {
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const y1 = anchor.y * cp + anchor.z * sp
  const z1 = -anchor.y * sp + anchor.z * cp
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const x2 = anchor.x * cy + z1 * sy
  const z2 = -anchor.x * sy + z1 * cy
  const fx = Math.max(0.18, Math.min(1.1, Math.sqrt(Math.max(0, 1 - x2 * x2)) / Math.sqrt(Math.max(0.05, 1 - anchor.x * anchor.x))))
  const fy = Math.max(0.18, Math.min(1.1, Math.sqrt(Math.max(0, 1 - y1 * y1)) / Math.sqrt(Math.max(0.05, 1 - anchor.y * anchor.y))))
  return { x: x2, y: y1, z: z2, fx, fy, lean: x2 * y1 * 0.6 - anchor.x * anchor.y * 0.6 }
}
