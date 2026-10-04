// Bloblex welcome greeting: timeline, pose equations, seeded particle
// rings/streaks, halo, hands and badge in a 640×150 reference space. The body is
// a sphere with capsule eyes in the agent colour; the notch collapse strip is
// omitted because the companion window shell owns that transition.

import type { RGB } from './blobEngine'
import { BADGE_OFFSET } from './blobGeometry'
import { drawWardrobe } from './wardrobeDrawing'
import { resolveOutfit, type Outfit } from './outfit'

export const GREETING_REFERENCE = { width: 640, height: 150 } as const

const T = {
  grow: 0.45, squint0: 0.6, squint1: 0.82, dip0: 1.25, dip1: 1.4, pop0: 1.36, pop1: 1.52,
  content0: 2.45, content1: 2.58, tuck0: 2.58, tuck1: 2.8, badge: 2.72, down0: 2.85, down1: 3.2,
  blink2: 3.8, tint0: 3.85, tint1: 4.15, end: 4.6,
}

export const GREETING_END_MS = T.end * 1000

const C0 = { x: 320, y: 90 }
const HB = 58
const CARD = { x: 10, y: 36, w: 620, h: 104 }
const CARD_R = 20
/** Sphere radius as a fraction of the source body height. */
const SPHERE = 0.56

const E = {
  out: (t: number) => 1 - Math.pow(1 - t, 3),
  easeIn: (t: number) => t * t * t,
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  back: (t: number) => {
    const c1 = 1.70158
    const c3 = c1 + 1
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
  },
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1)

type EyeType = 'dot' | 'happy' | 'content'

export interface ScenePose {
  hb: number; x: number; y: number; sx: number; sy: number; tilt: number
  eye: EyeType; open: number; eyeRoll: number
  lookX: number; lookY: number
  handL: number; handR: number; wave: number
  badge: number; tint: number; halo: number; haloBlue: number
  card: number
}

export function greetPose(t: number): ScenePose {
  const gg = E.back(seg(t, 0.02, T.grow))
  const hb = lerp(3, HB, gg)
  let x = C0.x
  let y = lerp(16, C0.y, E.out(seg(t, 0.02, T.grow)))
  let sx = 1
  let sy = 1
  let tilt = 0

  if (t >= T.dip0 && t < T.pop1) {
    const k = Math.sin(Math.PI * seg(t, T.dip0, T.pop1))
    y += hb * 0.22 * k
    sy = 1 - 0.06 * k
    sx = 1 + 0.04 * k
  }
  if (t >= T.pop1 && t < T.tuck1) {
    const w = t - T.pop1
    const fade = 1 - seg(t, T.tuck0, T.tuck1)
    x += Math.sin(w * 2 * Math.PI * 0.9) * hb * 1.34 * 0.05 * fade
    tilt = Math.sin(w * 2 * Math.PI * 0.9 + 0.6) * 0.05 * fade
    y += Math.sin(w * 2 * Math.PI * 1.8) * 0.8 * fade
  }
  if (t >= T.tuck0 && t < T.down1) y += hb * 0.12 * Math.sin(Math.PI * seg(t, T.tuck0, T.down1))

  let eye: EyeType = 'dot'
  if (t >= T.squint0 && t < T.squint1) eye = 'happy'
  if (t >= T.content0 && t < T.content1) eye = 'content'
  if (t >= T.down0 && t < T.down1) eye = 'content'
  let eyeRoll = 0
  if (t >= T.dip0 && t < T.pop1) eyeRoll = Math.sin(Math.PI * seg(t, T.dip0, T.pop1))
  const blink = (tb: number) => {
    const k = seg(t, tb, tb + 0.12)
    return k > 0 && k < 1 ? 1 - Math.sin(Math.PI * k) * 0.94 : 1
  }
  const open = Math.min(blink(1.95), blink(T.blink2))

  let lookX = 0
  let lookY = 0
  if (t >= T.squint1 && t < T.dip0) lookY = -0.2
  if (t >= T.pop1 && t < T.content0) { lookX = 0.55; lookY = -0.45 }
  if (t >= T.content0 && t < T.down1) { lookX = -0.3; lookY = 0.6 }
  if (t >= T.down1) {
    const k = E.inOut(seg(t, T.down1, T.down1 + 0.35))
    lookX = lerp(-0.3, 0, k)
    lookY = lerp(0.6, 0, k)
  }

  const handL = t < T.tuck0 ? E.back(seg(t, T.pop0, T.pop0 + 0.14)) : 1 - E.easeIn(seg(t, T.tuck0, T.tuck1 - 0.03))
  const handR = t < T.tuck0 ? E.back(seg(t, T.pop0 + 0.04, T.pop0 + 0.18)) : 1 - E.easeIn(seg(t, T.tuck0 + 0.03, T.tuck1))
  const wave = t >= T.pop1 && t < T.tuck0 ? t - T.pop1 : -1

  return {
    hb, x, y, sx, sy, tilt, eye, open, eyeRoll, lookX, lookY, handL, handR, wave,
    badge: E.back(seg(t, T.badge, T.badge + 0.28)),
    tint: 0.6 * E.inOut(seg(t, T.tint0, T.tint1)),
    halo: E.out(seg(t, 0.3, 0.7)),
    haloBlue: seg(t, T.tint0, T.tint1),
    card: seg(t, 0.18, 0.45),
  }
}

// Seeded LCG (seed = 7) so the ring/streak field is identical every launch.
const PARTICLES = (() => {
  let seed = 7
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const rings = [0.1, 0.2, 0.3, 0.45, 0.6].map((t0) => ({
    t0,
    dots: Array.from({ length: 170 }, () => ({ a: rnd() * Math.PI * 2, j: (rnd() - 0.5) * 0.22, s: 0.7 + rnd() * 0.9, al: 0.45 + rnd() * 0.55 })),
  }))
  const cols = ['#3B9EFF', '#F29B38', '#FF5A4E', '#2EC4A0', '#A78BFA']
  const streaks = Array.from({ length: 16 }, (_, i) => ({
    a: (i / 16) * Math.PI * 2 + (rnd() - 0.5) * 0.3,
    sp: 230 + rnd() * 260,
    len: 6 + rnd() * 9,
    t0: 0.08 + rnd() * 0.14,
    col: cols[i % 5],
  }))
  return { rings, streaks }
})()

function rr(x: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, R: number) {
  const r = Math.max(0, Math.min(R, W / 2, H / 2))
  x.beginPath()
  x.moveTo(X + r, Y)
  x.lineTo(X + W - r, Y)
  x.quadraticCurveTo(X + W, Y, X + W, Y + r)
  x.lineTo(X + W, Y + H - r)
  x.quadraticCurveTo(X + W, Y + H, X + W - r, Y + H)
  x.lineTo(X + r, Y + H)
  x.quadraticCurveTo(X, Y + H, X, Y + H - r)
  x.lineTo(X, Y + r)
  x.quadraticCurveTo(X, Y, X + r, Y)
  x.closePath()
}

const rgb = (c: RGB, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`
const mix = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
const WHITE: RGB = [1, 1, 1]
const BLACK: RGB = [0, 0, 0]

function sphereFill(x: CanvasRenderingContext2D, r: number, color: RGB) {
  const g = x.createRadialGradient(-r * 0.38, -r * 0.48, r * 0.05, -r * 0.1, -r * 0.1, r * 1.45)
  g.addColorStop(0, rgb(mix(color, WHITE, 0.62)))
  g.addColorStop(0.55, rgb(mix(color, WHITE, 0.12)))
  g.addColorStop(1, rgb(mix(color, BLACK, 0.2)))
  return g
}

function drawHandL(x: CanvasRenderingContext2D, hw: number, hh: number, p: ScenePose, color: RGB) {
  const k = p.handL
  if (k <= 0.01) return
  const hb = hh * 2
  const r = hb * 0.15 * k
  const rx = lerp(-hw * 0.35, -hw - hb * 0.22, k)
  let ry = lerp(hh * 0.85, hh * 0.62, k)
  if (p.wave >= 0) ry += Math.sin(p.wave * 6) * hb * 0.02
  x.save()
  x.translate(rx, ry)
  x.beginPath()
  x.arc(0, 0, r, 0, Math.PI * 2)
  x.fillStyle = sphereFill(x, r, color)
  x.fill()
  x.strokeStyle = 'rgba(0,0,0,0.08)'
  x.lineWidth = 0.8
  x.stroke()
  x.restore()
}

function drawHandR(x: CanvasRenderingContext2D, hw: number, hh: number, p: ScenePose, color: RGB) {
  const k = p.handR
  if (k <= 0.01) return
  const hb = hh * 2
  const L = hb * 0.4 * k
  const T2 = hb * 0.22 * k
  let rx = lerp(hw * 0.35, hw + hb * 0.2, k)
  let ry = lerp(hh * 0.85, hh * 0.2, k)
  let ang = -0.61
  if (p.wave >= 0) {
    const w = p.wave * 2 * Math.PI * 2.5
    ang += Math.sin(w) * 0.21
    ry += Math.sin(w + 0.8) * hb * 0.04
    rx += Math.cos(w) * hb * 0.015
  }
  x.save()
  x.translate(rx, ry)
  x.rotate(ang)
  rr(x, -L / 2, -T2 / 2, L, T2, T2 / 2)
  x.fillStyle = sphereFill(x, L / 2, color)
  x.fill()
  x.strokeStyle = 'rgba(0,0,0,0.08)'
  x.lineWidth = 0.8
  x.stroke()
  x.restore()
}

function drawCharacter(x: CanvasRenderingContext2D, p: ScenePose, color: RGB, outfit: Outfit, createdAt?: string | null) {
  const r = p.hb * SPHERE
  if (r <= 0.4) return

  if (p.halo > 0) {
    const bl = p.haloBlue
    const cr = Math.round(lerp(232, 59, bl))
    const cg = Math.round(lerp(195, 158, bl))
    const cb = Math.round(lerp(154, 255, bl))
    for (const [R, alpha] of [[r * 1.34 * 2.6, 0.18], [r * 1.34 * 4.2, 0.07]] as const) {
      const g = x.createRadialGradient(p.x, p.y, 0, p.x, p.y, R)
      g.addColorStop(0, `rgba(${cr},${cg},${cb},${alpha * p.halo})`)
      g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`)
      x.fillStyle = g
      x.beginPath()
      x.arc(p.x, p.y, R, 0, Math.PI * 2)
      x.fill()
    }
  }

  x.save()
  x.translate(p.x, p.y)
  x.rotate(p.tilt)
  x.scale(p.sx, p.sy)

  drawHandL(x, r * 1.05, r, p, color)
  drawHandR(x, r * 1.05, r, p, color)

  const body = () => { x.beginPath(); x.arc(0, 0, r, 0, Math.PI * 2) }
  body()
  x.fillStyle = sphereFill(x, r, color)
  x.fill()

  if (p.tint > 0) {
    const g = x.createLinearGradient(0, r, 0, -r * 0.1)
    g.addColorStop(0, `rgba(127,180,234,${p.tint})`)
    g.addColorStop(1, 'rgba(127,180,234,0)')
    body()
    x.fillStyle = g
    x.fill()
  }

  const hl = x.createRadialGradient(-r * 0.36, -r * 0.5, 0, -r * 0.36, -r * 0.5, r * 0.55)
  hl.addColorStop(0, 'rgba(255,255,255,0.5)')
  hl.addColorStop(1, 'rgba(255,255,255,0)')
  body()
  x.fillStyle = hl
  x.fill()

  x.save()
  if (typeof x.clip === 'function') { body(); x.clip() }
  x.fillStyle = 'rgb(14,14,16)'
  x.strokeStyle = 'rgb(14,14,16)'
  const w = r * 0.24
  const h = r * 0.56
  const er = r * 0.13
  const sp = r * 0.31
  const lx = p.lookX * r * 0.42
  const ly = -r * 0.13 + p.lookY * r * 0.28 + p.eyeRoll * r * 1.25
  for (const sd of [-1, 1]) {
    x.save()
    x.translate(sd * sp + lx, ly)
    if (p.eye === 'happy') {
      x.lineWidth = er * 0.95
      x.lineCap = 'round'
      x.beginPath()
      x.arc(0, er * 0.6, er * 1.25, Math.PI * 1.15, Math.PI * 1.85)
      x.stroke()
    } else if (p.eye === 'content') {
      x.lineWidth = er * 0.95
      x.lineCap = 'round'
      x.beginPath()
      x.arc(0, -er * 0.5, er * 1.25, Math.PI * 0.15, Math.PI * 0.85)
      x.stroke()
    } else {
      const hh = Math.max(h * p.open, w * 0.32)
      rr(x, -w / 2, -hh / 2, w, hh, w / 2)
      x.fill()
    }
    x.restore()
  }
  x.restore()

  drawWardrobe(x, resolveOutfit(outfit, new Date(), createdAt), r, [-1, 1].map((sd) => ({
    x: sd * sp + lx, y: ly, width: w, height: h, rotation: 0, visible: true,
  })), p.open)

  if (p.badge > 0.01) {
    x.save()
    x.translate(r * BADGE_OFFSET.x, r * BADGE_OFFSET.y)
    x.scale(p.badge, p.badge)
    x.fillStyle = '#0b0b0d'
    x.beginPath(); x.arc(0, 0, r * 0.34, 0, Math.PI * 2); x.fill()
    x.fillStyle = '#3BA0F5'
    x.beginPath(); x.arc(0, 0, r * 0.27, 0, Math.PI * 2); x.fill()
    x.fillStyle = '#06142e'
    for (const i of [-1, 0, 1]) {
      x.beginPath(); x.arc(i * r * 0.12, 0, r * 0.045, 0, Math.PI * 2); x.fill()
    }
    x.restore()
  }
  x.restore()
}

function drawParticles(x: CanvasRenderingContext2D, t: number, p: ScenePose) {
  if (p.card <= 0) return
  for (const ring of PARTICLES.rings) {
    const k = seg(t, ring.t0, ring.t0 + 1.35)
    if (k <= 0 || k >= 1) continue
    const rx = lerp(14, 380, E.out(k))
    const ry = rx * 0.34
    const fade = (1 - k) * (k < 0.08 ? k / 0.08 : 1) * p.card
    for (const dot of ring.dots) {
      const r = 1 + dot.j
      x.fillStyle = `rgba(255,255,255,${dot.al * fade})`
      x.fillRect(C0.x + Math.cos(dot.a) * rx * r, C0.y + Math.sin(dot.a) * ry * r, dot.s, dot.s)
    }
  }
  for (const s of PARTICLES.streaks) {
    const k = seg(t, s.t0, s.t0 + 0.6)
    if (k <= 0 || k >= 1) continue
    const dist = s.sp * E.out(k) * 0.9 + 10
    x.strokeStyle = s.col + Math.round((1 - k) * 255).toString(16).padStart(2, '0')
    x.lineWidth = 1.6
    x.lineCap = 'round'
    x.beginPath()
    x.moveTo(C0.x + Math.cos(s.a) * (dist - s.len), C0.y + Math.sin(s.a) * (dist - s.len) * 0.42)
    x.lineTo(C0.x + Math.cos(s.a) * dist, C0.y + Math.sin(s.a) * dist * 0.42)
    x.stroke()
  }
}

/** Draws the welcome scene for `ageMs` into a `W`×`H` CSS-pixel canvas. */
export function drawGreetingScene(x: CanvasRenderingContext2D, W: number, H: number, ageMs: number, color: RGB, outfit: Outfit = 'auto', createdAt?: string | null) {
  const t = Math.max(0, Math.min(ageMs, GREETING_END_MS)) / 1000
  const scale = Math.min(W / GREETING_REFERENCE.width, H / GREETING_REFERENCE.height)
  const p = greetPose(t)
  x.clearRect(0, 0, W, H)
  x.save()
  x.translate((W - GREETING_REFERENCE.width * scale) / 2, (H - GREETING_REFERENCE.height * scale) / 2)
  x.scale(scale, scale)
  if (p.card > 0) {
    x.save()
    x.globalAlpha = p.card
    rr(x, CARD.x, CARD.y, CARD.w, CARD.h, CARD_R)
    x.fillStyle = '#141518'
    x.fill()
    x.restore()
    x.save()
    rr(x, CARD.x, CARD.y, CARD.w, CARD.h, CARD_R)
    if (typeof x.clip === 'function') x.clip()
    drawParticles(x, t, p)
    x.restore()
  }
  drawCharacter(x, p, color, outfit, createdAt)
  x.restore()
}
