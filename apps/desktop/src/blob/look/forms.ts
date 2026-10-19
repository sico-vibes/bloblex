// The eight symmetric blob silhouettes and the face that fits inside each one.
//
// Adapted from blobatar (https://github.com/Alain00/blobatar, packages/blobatar
// src/shape.ts, src/styles/shapes.ts, src/styles/compose.ts and
// src/styles/blob.ts at a7fd546), MIT License, Copyright (c) 2026 Alain. See
// docs/legal/third-party-notices.md. Eye trait keys retain stored tuning; body geometry
// is now fixed and symmetric. The outlines are sampled into
// point lists instead of SVG path strings, because the Bitbots engine draws on
// a canvas and morphs the outline (the mailbox state) point by point.

import type { Traits } from './seed'

export const BLOB_SHAPES = ['circle', 'pebble', 'squircle', 'capsule', 'triangle', 'hexagon', 'cloud', 'droplet'] as const
export type BlobShape = typeof BLOB_SHAPES[number]

export type Pt = readonly [number, number]
export interface Circle { cx: number; cy: number; r: number }
export interface Ellipse { cx: number; cy: number; rx: number; ry: number }
export interface FormEye extends Ellipse { n: number; rot: number }

/** A resolved look in the 100×100 frame the geometry is defined in. */
export interface FormLayout {
  shape: BlobShape
  /** The core silhouette, clockwise on screen. */
  outline: Pt[]
  /** Circles unioned with the core (capsule ends, nubs, cloud lobes, sun petals). */
  petals: Circle[]
  /** Extra outlines unioned with the core (the droplet's taper), clockwise. */
  extras: Pt[][]
  /** The region the eyes stay inside, and the surface they turn across. */
  face: Ellipse
  eyes: FormEye[]
  /** Eyes carry a specular glint (the cat's glossy eyes). */
  glint?: boolean
  /** Character details drawn over the body (the cat's ears, muzzle and whiskers). */
  features?: CatFeatures
}

/** Cat details, in frame units. Muzzle, nose, mouth and whiskers turn with the face. */
export interface CatFeatures {
  innerEars: Pt[][]
  muzzle: Ellipse
  nose: { cx: number; cy: number; r: number }
  /** Centre and half-width of the ω mouth under the nose. */
  mouth: { cx: number; cy: number; w: number }
  whiskers: Array<[Pt, Pt]>
  stripes: Array<[Pt, Pt]>
}

interface Body extends Ellipse { n: number; rot: number; sides?: number; round?: number }

// ---------------------------------------------------------------------------
// Sampled primitives.

function cubic(out: Pt[], p0: Pt, c1: Pt, c2: Pt, p3: Pt, steps: number) {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1],
    ])
  }
}

function quad(out: Pt[], p0: Pt, c: Pt, p2: Pt, steps: number) {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    out.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p2[1]])
  }
}

function line(out: Pt[], a: Pt, b: Pt, steps: number) {
  for (let i = 1; i <= steps; i++) out.push([a[0] + (b[0] - a[0]) * (i / steps), a[1] + (b[1] - a[1]) * (i / steps)])
}

/** |x/a|^n + |y/b|^n = 1, one cubic per quadrant through the exact 45° point. */
export function superellipse({ cx, cy, rx, ry, n = 4, rot = 0 }: Ellipse & { n?: number; rot?: number }, steps = 14): Pt[] {
  const k = Math.min(1, (8 * Math.pow(2, -1 / n) - 4) / 3)
  const a = rx
  const b = ry
  const ak = a * k
  const bk = b * k
  const raw: Pt[] = [
    [a, 0],
    [a, bk], [ak, b], [0, b],
    [-ak, b], [-a, bk], [-a, 0],
    [-a, -bk], [-ak, -b], [0, -b],
    [ak, -b], [a, -bk], [a, 0],
  ]
  const t = (rot * Math.PI) / 180
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  const p = raw.map(([x, y]): Pt => [cx + x * cos - y * sin, cy + x * sin + y * cos])
  const out: Pt[] = [p[0]]
  for (let i = 1; i < 13; i += 3) cubic(out, p[i - 1], p[i], p[i + 1], p[i + 2], steps)
  out.pop()
  return out
}

/** A regular polygon with corners cut back by `round` and joined through the vertex. */
function polygon({ cx, cy, rx, ry, sides = 6, round = 0.3, rot = 0 }: Body): Pt[] {
  const k = round > 0 ? (round < 1 ? round / 2 : 0.5) : 0
  const t0 = (rot * Math.PI) / 180 - Math.PI / 2
  const v = Array.from({ length: sides }, (_, i): Pt => {
    const a = t0 + (2 * Math.PI * i) / sides
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]
  })
  const at = (i: number) => v[((i % sides) + sides) % sides]
  const cut = (i: number, j: number): Pt => {
    const [x0, y0] = at(i)
    const [x1, y1] = at(j)
    return [x0 + (x1 - x0) * k, y0 + (y1 - y0) * k]
  }
  const out: Pt[] = [cut(0, -1)]
  for (let i = 0; i < sides; i++) {
    quad(out, out[out.length - 1], at(i), cut(i, i + 1), 10)
    if (k < 0.5) line(out, out[out.length - 1], cut(i + 1, i), 6)
  }
  out.pop()
  return out
}

/** The straight run of a capsule; its two end circles come from the petals. */
function box(cx: number, cy: number, rx: number, ry: number): Pt[] {
  const corners: Pt[] = [[cx - rx, cy - ry], [cx + rx, cy - ry], [cx + rx, cy + ry], [cx - rx, cy + ry]]
  const out: Pt[] = [corners[0]]
  for (let i = 0; i < 4; i++) line(out, corners[i], corners[(i + 1) % 4], 12)
  out.pop()
  return out
}

/** The two tangents from an apex to the body ellipse: a droplet's taper. */
function taper(cx: number, cy: number, rx: number, ry: number, tip: number): Pt[] {
  const t = Math.max(1.05, tip)
  const tx = rx * Math.sqrt(1 - 1 / (t * t))
  const ty = cy - ry / t
  const apex = cy - t * ry
  const px = tx * 0.14
  const py = ty + 0.86 * (apex - ty)
  const out: Pt[] = [[cx - tx, ty]]
  line(out, [cx - tx, ty], [cx - px, py], 8)
  quad(out, [cx - px, py], [cx, apex], [cx + px, py], 8)
  line(out, [cx + px, py], [cx + tx, ty], 8)
  line(out, [cx + tx, ty], [cx - tx, ty], 8)
  out.pop()
  return out
}

/** Positive when the outline runs clockwise on screen (y down). */
function signedArea(points: readonly Pt[]) {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[(i + 1) % points.length]
    sum += x0 * y1 - x1 * y0
  }
  return sum / 2
}

/** Canvas fills the union with the non-zero rule only if every piece winds the same way. */
function clockwise(points: Pt[]): Pt[] {
  return signedArea(points) < 0 ? points.reverse() : points
}

// ---------------------------------------------------------------------------
// The silhouettes.

interface ShapeDef {
  core: number
  body?(b: Body): void
  face?(b: Body): Ellipse
  decorate?(b: Body, petals: Circle[], extras: Pt[][]): void
  path?(b: Body): Pt[]
}

const shrunk = (k: number) => (b: Body): Ellipse => ({ cx: b.cx, cy: b.cy, rx: b.rx * k, ry: b.ry * k })

// Body parameters never read the seed: shuffling only changes the face.
const SHAPES: Record<BlobShape, ShapeDef> = {
  circle: { core: 1 },
  pebble: {
    core: 1,
    body: (b) => { b.ry *= 0.84; b.n = 2.6 },
  },
  squircle: {
    core: 0.86,
    body: (b) => { b.n = 4.6 },
  },
  capsule: {
    core: 1.02,
    body: (b) => { b.ry *= 0.615 },
    face: shrunk(0.94),
    decorate: (b, petals) => { for (const s of [-1, 1]) petals.push({ cx: b.cx + s * (b.rx - b.ry), cy: b.cy, r: b.ry }) },
    path: (b) => box(b.cx, b.cy, b.rx - b.ry, b.ry),
  },
  triangle: {
    core: 1.15, path: polygon,
    body: (b) => { b.sides = 3; b.round = 0.37 },
    face: (b) => ({ cx: b.cx, cy: b.cy + b.ry * 0.1, rx: b.rx * 0.54, ry: b.ry * 0.36 }),
  },
  hexagon: {
    core: 1.05, path: polygon, face: shrunk(0.84),
    body: (b) => { b.sides = 6; b.round = 0.37 },
  },
  cloud: {
    core: 0.78,
    body: (b) => { b.ry *= 0.72; b.n = 3 },
    face: shrunk(0.94),
    decorate: (b, petals) => {
      for (const s of [-1, 1]) petals.push({ cx: b.cx + s * b.rx * 0.65, cy: b.cy - b.rx * 0.35, r: b.rx * 0.5 })
      petals.push({ cx: b.cx, cy: b.cy - b.rx * 0.6, r: b.rx * 0.6 })
    },
  },
  droplet: {
    core: 0.78,
    body: (b) => { b.cy += 0.22 * b.ry },
    face: (b) => ({ cx: b.cx, cy: b.cy + b.ry * 0.05, rx: b.rx * 0.88, ry: b.ry * 0.88 }),
    decorate: (b, _petals, extras) => { extras.push(taper(b.cx, b.cy, b.rx, b.ry, 1.525)) },
  },
}

/** Fits the eye cluster against the silhouette's face region on both axes. */
function faceFit(t: Traits, b: Body, face: Ellipse): FormEye[] {
  const er0 = t.num('eye.rx', 0.075, 0.12) * b.rx
  const ratio = t.num('eye.ratio', 2.2, 3.2)
  const clearance = t.num('eye.gap', 0.1, 0.24) * b.rx
  const gap0 = er0 + b.rx * 0.03 + clearance
  const gy = t.num('gaze.y', -0.2, 0.08) * face.ry
  const reach = Math.hypot(er0, er0 * ratio)
  const need = Math.hypot((gap0 + reach) / face.rx, (Math.abs(gy) + reach) / face.ry)
  const fit = need > 0.9 ? 0.9 / need : 1
  const rx = er0 * fit
  const cy = face.cy + gy * fit
  // Both eyes share the same tuning and mirror around the face centre.
  // Legacy asymmetry, lean and gaze-x pins are intentionally ignored at rest.
  return [-1, 1].map((s) => ({ cx: face.cx + s * gap0 * fit, cy, rx, ry: rx * ratio, n: t.num('eye.n', 2.4, 3.6), rot: 0 }))
}

/** A fixed, upright silhouette with a seed-tuned, mirrored face. */
export function layoutForm(shape: BlobShape, t: Traits): FormLayout {
  const def = SHAPES[shape]
  const r = 38 * def.core
  const body: Body = { cx: 50, cy: 50, rx: r, ry: r, n: 2, rot: 0 }
  def.body?.(body)
  const face = def.face?.(body) ?? { cx: body.cx, cy: body.cy, rx: body.rx, ry: body.ry }
  const petals: Circle[] = []
  const extras: Pt[][] = []
  def.decorate?.(body, petals, extras)
  return {
    shape,
    outline: clockwise(def.path ? def.path(body) : superellipse(body)),
    petals,
    extras: extras.map(clockwise),
    face,
    eyes: faceFit(t, body, face),
  }
}
