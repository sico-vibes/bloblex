// The ten blob silhouettes and the face that fits inside each one.
//
// Adapted from blobatar (https://github.com/Alain00/blobatar, packages/blobatar
// src/shape.ts, src/styles/shapes.ts, src/styles/compose.ts and
// src/styles/blob.ts at a7fd546), MIT License, Copyright (c) 2026 Alain. See
// THIRD_PARTY_NOTICES.md. The trait keys, ranges and silhouette parameters are
// kept as published so a seed reads the same way; the outlines are sampled into
// point lists instead of SVG path strings, because the Bloblex engine draws on
// a canvas and morphs the outline (the mailbox state) point by point.

import type { Traits } from './seed'

export const BLOB_SHAPES = ['round', 'organic', 'boxy', 'capsule', 'cloud', 'droplet', 'hexagon', 'sun', 'triangle', 'cat'] as const
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

interface Body extends Ellipse { n: number; rot: number; radii: number[]; sides?: number; round?: number }

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

/** Radii around a circle joined by a closed Catmull-Rom spline. */
function blobPath(cx: number, cy: number, rx: number, ry: number, radii: number[], rot = 0): Pt[] {
  const n = radii.length
  const t0 = (rot * Math.PI) / 180
  const p = radii.map((m, i): Pt => {
    const a = t0 + (2 * Math.PI * i) / n
    return [cx + rx * m * Math.cos(a), cy + ry * m * Math.sin(a)]
  })
  const at = (i: number) => p[((i % n) + n) % n]
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const [x0, y0] = at(i - 1)
    const [x1, y1] = at(i)
    const [x2, y2] = at(i + 1)
    const [x3, y3] = at(i + 2)
    if (i === 0) out.push([x1, y1])
    cubic(out, [x1, y1], [x1 + (x2 - x0) / 6, y1 + (y2 - y0) / 6], [x2 - (x3 - x1) / 6, y2 - (y3 - y1) / 6], [x2, y2], 10)
  }
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
  /** Replaces the fitted eyes, for silhouettes with their own face (the cat). */
  eyes?(t: Traits, face: Ellipse): FormEye[]
  features?(t: Traits, b: Body, face: Ellipse): CatFeatures
  body?(t: Traits, b: Body): void
  face?(b: Body): Ellipse
  decorate?(t: Traits, b: Body, petals: Circle[], extras: Pt[][]): void
  path?(b: Body): Pt[]
}

const poly = (b: Body) => polygon(b)
const spline = (b: Body) => blobPath(b.cx, b.cy, b.rx, b.ry, b.radii, b.rot)
const shrunk = (k: number) => (b: Body): Ellipse => ({ cx: b.cx, cy: b.cy, rx: b.rx * k, ry: b.ry * k })
const splineFace = (b: Body): Ellipse => shrunk(Math.min(...b.radii) * 0.95)(b)

const SHAPES: Record<BlobShape, ShapeDef> = {
  round: { core: 1 },
  organic: { core: 0.98, path: spline, face: splineFace },
  boxy: {
    core: 0.86,
    body: (t, b) => { b.n = t.num('body.n', 3.4, 6); b.rot = t.num('body.rot', -20, 20) },
  },
  capsule: {
    core: 1.02,
    body: (t, b) => { b.ry *= t.num('capsule.squat', 0.55, 0.68) },
    face: shrunk(0.94),
    decorate: (_t, b, petals) => { for (const s of [-1, 1]) petals.push({ cx: b.cx + s * (b.rx - b.ry), cy: b.cy, r: b.ry }) },
    path: (b) => box(b.cx, b.cy, b.rx - b.ry, b.ry),
  },
  cloud: {
    core: 0.78, face: splineFace, path: spline,
    decorate: (t, b, petals) => {
      const count = t.int('cloud.n', 4, 6)
      for (let i = 0; i < count; i++) {
        const a = Math.PI + (Math.PI * (i + 0.5)) / count
        petals.push({ cx: b.cx + Math.cos(a) * b.rx * 0.8, cy: b.cy + Math.sin(a) * b.rx * 0.5, r: b.rx * t.num(`cloud.r${i}`, 0.44, 0.62) })
      }
    },
  },
  droplet: {
    core: 0.78,
    body: (_t, b) => { b.cy += 0.22 * b.ry; b.n = 2 },
    face: (b) => ({ cx: b.cx, cy: b.cy + b.ry * 0.05, rx: b.rx * 0.88, ry: b.ry * 0.88 }),
    decorate: (t, b, _petals, extras) => { extras.push(taper(b.cx, b.cy, b.rx, b.ry, t.num('droplet.tip', 1.4, 1.65))) },
  },
  hexagon: {
    core: 1.05, path: poly, face: shrunk(0.84),
    body: (t, b) => { b.sides = 6; b.rot = t.num('body.rot', -12, 12); b.round = t.num('poly.round', 0.24, 0.5) },
  },
  sun: {
    core: 0.7,
    decorate: (t, b, petals) => {
      const count = t.int('sun.n', 6, 9)
      const dist = b.rx * t.num('sun.dist', 1.0, 1.08)
      const pr = b.rx * t.num('sun.r', 0.2, 0.26)
      const off = t.num('sun.rot', 0, 2 * Math.PI)
      for (let i = 0; i < count; i++) {
        const a = off + (2 * Math.PI * i) / count
        petals.push({ cx: b.cx + Math.cos(a) * dist, cy: b.cy + Math.sin(a) * dist, r: pr })
      }
    },
  },
  triangle: {
    core: 1.15, path: poly,
    body: (t, b) => { b.sides = 3; b.rot = t.num('body.rot', -5, 5); b.round = t.num('poly.round', 0.24, 0.5) },
    face: (b) => ({ cx: b.cx, cy: b.cy + b.ry * 0.1, rx: b.rx * 0.54, ry: b.ry * 0.36 }),
  },
  cat: {
    core: 0.9,
    // A wide dome sitting low, leaving room for the ears above it.
    body: (_t, b) => { b.rx *= 1.12; b.ry *= 0.9; b.cy += b.ry * 0.16; b.n = 2.35 },
    face: (b) => ({ cx: b.cx, cy: b.cy + b.ry * 0.08, rx: b.rx * 0.82, ry: b.ry * 0.72 }),
    decorate: (t, b, _petals, extras) => {
      const lean = t.num('cat.ear', -0.06, 0.06)
      for (const s of [-1, 1]) extras.push(roundedTriangle(earPoints(b, s, lean), 0.42))
    },
    eyes: (t, face) => {
      const rx = face.rx * t.num('eye.rx', 0.19, 0.22)
      const ry = rx * t.num('eye.ratio', 1.04, 1.16)
      const gap = face.rx * t.num('eye.gap', 0.4, 0.44)
      const cy = face.cy - face.ry * t.num('gaze.y', 0.06, 0.16)
      return [-1, 1].map((s) => ({ cx: face.cx + s * gap, cy, rx, ry, n: 2, rot: 0 }))
    },
    features: (t, b, face) => {
      const lean = t.num('cat.ear', -0.06, 0.06)
      const noseY = face.cy + face.ry * 0.2
      const whiskers: Array<[Pt, Pt]> = []
      for (const s of [-1, 1]) {
        for (const k of [-1, 0, 1]) {
          const x0 = face.cx + s * face.rx * 0.5
          const y0 = noseY + face.ry * (0.1 + k * 0.1)
          whiskers.push([[x0, y0], [x0 + s * face.rx * 0.62, y0 + face.ry * k * 0.16 - face.ry * 0.02]])
        }
      }
      const top = b.cy - b.ry
      const stripes: Array<[Pt, Pt]> = [-1, 0, 1].map((k): [Pt, Pt] => [[b.cx + k * b.rx * 0.2, top + b.ry * 0.02], [b.cx + k * b.rx * 0.17, top + b.ry * (k === 0 ? 0.3 : 0.24)]])
      return {
        innerEars: [-1, 1].map((s) => roundedTriangle(shrinkTowards(earPoints(b, s, lean), 0.52, 0.18), 0.5)),
        muzzle: { cx: face.cx, cy: noseY + face.ry * 0.14, rx: face.rx * 0.46, ry: face.ry * 0.36 },
        nose: { cx: face.cx, cy: noseY, r: face.rx * 0.075 },
        mouth: { cx: face.cx, cy: noseY + face.ry * 0.12, w: face.rx * 0.13 },
        whiskers,
        stripes: t('cat.stripes') < 0.75 ? stripes : [],
      }
    },
  },
}

/** An ear: inner base on the crown, outer base on the shoulder, apex up and out. */
function earPoints(b: Body, s: number, lean: number): [Pt, Pt, Pt] {
  const top = b.cy - b.ry
  return [
    [b.cx + s * b.rx * 0.2, top + b.ry * 0.06],
    [b.cx + s * b.rx * (0.66 + lean), top - b.ry * 0.5],
    [b.cx + s * b.rx * 0.9, b.cy - b.ry * 0.5],
  ]
}

/** Moves a triangle's corners toward its centroid by `k`, then down by `drop` of its height. */
function shrinkTowards(points: [Pt, Pt, Pt], k: number, drop: number): [Pt, Pt, Pt] {
  const cx = (points[0][0] + points[1][0] + points[2][0]) / 3
  const cy = (points[0][1] + points[1][1] + points[2][1]) / 3
  const height = Math.max(...points.map((p) => p[1])) - Math.min(...points.map((p) => p[1]))
  return points.map(([x, y]): Pt => [cx + (x - cx) * k, cy + (y - cy) * k + height * drop]) as [Pt, Pt, Pt]
}

/** A triangle with each corner cut back by `round` and joined through the vertex. */
function roundedTriangle(v: [Pt, Pt, Pt], round: number): Pt[] {
  const k = round / 2
  const cut = (i: number, j: number): Pt => [v[i][0] + (v[j][0] - v[i][0]) * k, v[i][1] + (v[j][1] - v[i][1]) * k]
  const out: Pt[] = [cut(0, 2)]
  for (let i = 0; i < 3; i++) {
    quad(out, out[out.length - 1], v[i], cut(i, (i + 1) % 3), 8)
    line(out, out[out.length - 1], cut((i + 1) % 3, i), 6)
  }
  out.pop()
  return clockwise(out)
}

/**
 * Seed bands for a random silhouette: rounds and pebbles are everyday, the
 * louder shapes stay finds. Each midpoint is what a shape tile writes.
 */
const BANDS: ReadonlyArray<readonly [BlobShape, number]> = [
  ['round', 0.22], ['organic', 0.46], ['boxy', 0.58], ['capsule', 0.68], ['cloud', 0.77],
  ['droplet', 0.84], ['hexagon', 0.89], ['sun', 0.93], ['triangle', 0.96], ['cat', 1],
]

export function shapeForPosition(value: number): BlobShape {
  return (BANDS.find(([, upTo]) => value < upTo) ?? BANDS[BANDS.length - 1])[0]
}

/** Fits the eye cluster against the silhouette's face region on both axes. */
function faceFit(t: Traits, b: Body, face: Ellipse): FormEye[] {
  const rx = b.rx
  const er0 = t.num('eye.rx', 0.075, 0.105) * rx
  const ratio = t.num('eye.ratio', 1.9, 3.2)
  const scale = t.num('eye.scale', 0.78, 1.24)
  const stretch = t.num('eye.stretch', 0.85, 1.18)
  const clearance = t.num('eye.gap', 0.1, 0.24) * rx
  const wide = er0 * Math.max(1, scale)
  const tall = er0 * ratio * Math.max(1, scale * stretch)
  const gap0 = wide + rx * 0.03 + clearance

  const gx = t.jitter('gaze.x', 0.09) * face.rx
  const gy = t.num('gaze.y', -0.2, 0.08) * face.ry
  const dy = t.jitter('eye.dy', 0.04) * face.ry
  const reach = Math.hypot(wide, tall)
  const need = Math.hypot((Math.abs(gx) + gap0 + reach) / face.rx, (Math.abs(gy) + Math.abs(dy) + reach) / face.ry)
  const fit = need > 0.9 ? 0.9 / need : 1

  const er = er0 * fit
  const eyeRy = er * ratio
  const gap = gap0 * fit
  const room = Math.max(0, Math.min(1, clearance / tall))
  const bound = Math.min(12, (Math.asin(room) * 180) / Math.PI)
  const lean = t.num('eye.lean', -1, 1) * bound
  const lean2 = Math.max(-12, Math.min(12, lean + t.jitter('eye.lean2', 3.5)))

  const cx = face.cx + gx * fit
  const cy = face.cy + gy * fit
  return [
    { cx: cx - gap, cy, rx: er, ry: eyeRy, n: t.num('eye.n', 3.5, 6), rot: lean },
    { cx: cx + gap, cy: cy + dy * fit, rx: er * scale, ry: eyeRy * scale * stretch, n: t.num('eye.n', 3.5, 6), rot: lean2 },
  ]
}

/**
 * The layout for one silhouette. The body is centred in the frame (blobatar
 * jitters it by up to 1.5 units; a moving character does not need that).
 */
export function layoutForm(shape: BlobShape, t: Traits): FormLayout {
  const def = SHAPES[shape]
  const r = t.num('body.r', 31, 38) * def.core
  const body: Body = {
    cx: 50,
    cy: 50,
    rx: r,
    ry: r * t.num('body.ratio', 0.92, 1.08),
    n: t.num('body.n', 1.9, 2.5),
    rot: 0,
    radii: Array.from({ length: t.int('body.pts', 6, 8) }, (_, i) => 1 + t.jitter(`body.r${i}`, 0.16)),
  }
  def.body?.(t, body)
  const face = def.face?.(body) ?? { cx: body.cx, cy: body.cy, rx: body.rx, ry: body.ry }
  const petals: Circle[] = []
  const extras: Pt[][] = []
  def.decorate?.(t, body, petals, extras)
  return {
    shape,
    outline: clockwise(def.path ? def.path(body) : superellipse(body)),
    petals,
    extras: extras.map(clockwise),
    face,
    eyes: def.eyes ? def.eyes(t, face) : faceFit(t, body, face),
    ...(def.features ? { glint: true, features: def.features(t, body, face) } : {}),
  }
}
