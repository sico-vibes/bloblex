// Bloblex character engine: a blob body in one of the look silhouettes, tinted
// with the agent colour, with superellipse eyes, a ring badge and a state table
// (idle, online, listening, typing, tool, file stages, offline, budget).
// Tween/lock system, blink cadence, squash/slap, roll, badge swap, particles,
// mailbox morph and the yaw/pitch turn of the eyes across the face. Scheduled
// actions run inside update() instead of setTimeout, and a reduced-motion mode
// is supported.

import { Ease, lerp, type EaseFn } from './engine/core/anim'
import { BADGE_OFFSET, BADGE_RADIUS } from './blobGeometry'
export { BADGE_OFFSET } from './blobGeometry'
import { MASCOT_LOOK, resolveForm, type BlobLook, type FormLayout } from './look'
import { eyeAnchor, eyePath, formReach, traceForm, turnEye, UNITS_PER_RADIUS } from './look/paint'

export type RGB = readonly [number, number, number]

export type EyeShape =
  | 'pill' | 'wide' | 'dot' | 'line' | 'flat' | 'happy' | 'closed'
  | 'spiral' | 'heart' | 'star' | 'tired' | 'wink' | 'cup'

export type BadgeKind = 'dots' | 'bang' | 'question' | 'dot' | 'clip' | 'arrow'

export interface Badge { kind: BadgeKind; color: RGB }

export type EngineState =
  | 'idle' | 'online' | 'listening' | 'working' | 'thinking' | 'searching'
  | 'approval' | 'question' | 'error' | 'finished' | 'ratelimit' | 'sleeping'
  | 'dizzy' | 'offline' | 'budget' | 'upload' | 'chewing' | 'fileReady'
  | 'fileSending' | 'fileError'

export type Emote = 'love' | 'surprised' | 'happy' | 'annoyed'

type TweenKey = readonly [target: number, durationMs: number, ease: EaseFn]
type PropKey = 'yaw' | 'pitch' | 'roll' | 'tilt' | 'open' | 'sx' | 'sy' | 'oy' | 'ox' | 'tint' | 'morph' | 'blush' | 'es' | 'badgeS'

interface Tween { keys: readonly TweenKey[]; index: number; from: number; startMs: number; onComplete?: () => void }

interface StateCfg {
  color: RGB
  tint: number
  eye: EyeShape
  badge: Badge | null
  bounces: boolean
  scans: boolean
  breathes: boolean
  zz: boolean
  sweat: boolean
  look: readonly [number, number] | null
  tilt: number
  morph: number
  dim: number
}

/** One eye, placed on the face for this frame. Sizes are in pixels. */
export interface EyeFrame {
  x: number; y: number; rx: number; ry: number; n: number; rot: number
  lean: number; fx: number; fy: number; visible: boolean; sd: -1 | 1
}

interface Particle {
  type: 'heart' | 'star' | 'spark' | 'sweat' | 'z'
  x: number; y: number; vx: number; vy: number
  age: number; life: number; rot: number; size: number
}

const INK = 'rgb(14,14,16)'
const SPINNING_SHAPES = new Set<string>(['boxy', 'hexagon', 'sun', 'triangle'])
const LIGHT_INK = 'rgb(240,242,246)'

const C = {
  idle: [0.902, 0.914, 0.933] as RGB,
  online: [0.329, 0.835, 0.596] as RGB,
  working: [0.231, 0.62, 1] as RGB,
  thinking: [0.545, 0.361, 0.965] as RGB,
  searching: [0.388, 0.396, 0.949] as RGB,
  approval: [0.961, 0.647, 0.141] as RGB,
  question: [0.133, 0.827, 0.933] as RGB,
  error: [0.957, 0.314, 0.369] as RGB,
  finished: [0.204, 0.831, 0.6] as RGB,
  ratelimit: [0.984, 0.573, 0.235] as RGB,
  sleeping: [0.58, 0.635, 0.722] as RGB,
  dizzy: [0.957, 0.447, 0.714] as RGB,
  file: [0.353, 0.694, 0.839] as RGB,
}

const base: Omit<StateCfg, 'color' | 'tint' | 'eye' | 'badge'> = {
  bounces: false, scans: false, breathes: false, zz: false, sweat: false, look: null, tilt: 0, morph: 0, dim: 0,
}

export const ENGINE_STATES: Record<EngineState, StateCfg> = {
  idle: { ...base, color: C.idle, tint: 0, eye: 'pill', badge: null },
  online: { ...base, color: C.online, tint: 0, eye: 'pill', badge: { kind: 'dot', color: C.online } },
  listening: { ...base, color: C.question, tint: 0.4, eye: 'pill', badge: { kind: 'dots', color: C.question }, look: [0, -0.5] },
  working: { ...base, color: C.working, tint: 0.72, eye: 'pill', badge: { kind: 'dots', color: C.working } },
  thinking: { ...base, color: C.thinking, tint: 0.72, eye: 'pill', badge: { kind: 'dots', color: C.thinking }, look: [0.55, 0.55] },
  searching: { ...base, color: C.searching, tint: 0.72, eye: 'pill', badge: { kind: 'dots', color: C.searching }, scans: true },
  approval: { ...base, color: C.approval, tint: 0.78, eye: 'wide', badge: { kind: 'bang', color: C.approval }, bounces: true },
  question: { ...base, color: C.question, tint: 0.75, eye: 'pill', badge: { kind: 'question', color: C.question }, tilt: 0.17 },
  error: { ...base, color: C.error, tint: 0.78, eye: 'flat', badge: { kind: 'dot', color: C.error } },
  finished: { ...base, color: C.finished, tint: 0.35, eye: 'happy', badge: { kind: 'dot', color: C.finished } },
  ratelimit: { ...base, color: C.ratelimit, tint: 0.72, eye: 'tired', badge: { kind: 'dot', color: C.ratelimit }, sweat: true },
  sleeping: { ...base, color: C.sleeping, tint: 0.32, eye: 'closed', badge: null, breathes: true, zz: true },
  dizzy: { ...base, color: C.dizzy, tint: 0.7, eye: 'spiral', badge: null },
  offline: { ...base, color: C.sleeping, tint: 0.2, eye: 'flat', badge: null, look: [0, -0.3], dim: 0.38 },
  budget: { ...base, color: C.approval, tint: 0.6, eye: 'wide', badge: { kind: 'bang', color: C.approval } },
  upload: { ...base, color: C.file, tint: 0.5, eye: 'cup', badge: null, morph: 1 },
  chewing: { ...base, color: C.file, tint: 0.5, eye: 'happy', badge: null, morph: 1 },
  fileReady: { ...base, color: C.file, tint: 0.45, eye: 'pill', badge: { kind: 'clip', color: C.file } },
  fileSending: { ...base, color: C.working, tint: 0.6, eye: 'pill', badge: { kind: 'arrow', color: C.working }, look: [0.3, 0.45] },
  fileError: { ...base, color: C.error, tint: 0.7, eye: 'flat', badge: { kind: 'bang', color: C.error } },
}

const EMOTE_EYE: Record<Emote, EyeShape> = { love: 'heart', surprised: 'dot', happy: 'happy', annoyed: 'line' }

export function hexToRGB(hex: string): RGB {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((digit) => digit + digit).join('') : h
  const v = Number.parseInt(full, 16)
  if (!Number.isFinite(v)) return C.idle
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

const rgba = (c: RGB, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`
const mix3 = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
const WHITE: RGB = [1, 1, 1]
const BLACK: RGB = [0, 0, 0]

function roundRectPath(x: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, R: number) {
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

function heartPath(x: CanvasRenderingContext2D, s: number) {
  x.beginPath()
  x.moveTo(0, s * 0.38)
  x.bezierCurveTo(-s * 1.05, -s * 0.15, -s * 0.5, -s * 0.95, 0, -s * 0.38)
  x.bezierCurveTo(s * 0.5, -s * 0.95, s * 1.05, -s * 0.15, 0, s * 0.38)
  x.closePath()
}

function starPath(x: CanvasRenderingContext2D, ro: number, ri: number) {
  x.beginPath()
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? ri : ro
    const a = -Math.PI / 2 + (i * Math.PI) / 5
    x.lineTo(Math.cos(a) * r, Math.sin(a) * r)
  }
  x.closePath()
}

const FONT = 'system-ui, "Segoe UI Variable Text", "Segoe UI", sans-serif'
const secondsNow = () => performance.now() / 1000

/** Fraction of the canvas width used as the sphere radius. */
export const BODY_RADIUS = 0.4

/** Badge centre relative to the body centre, in units of the body radius. */
export class BlobEngine {
  isMini = false
  reducedMotion = false
  bodyColor: RGB = C.idle
  /** The resolved silhouette and face. */
  form: FormLayout = resolveForm(MASCOT_LOOK)

  yaw = 0; pitch = 0; roll = 0; tilt = 0; open = 1
  sx = 1; sy = 1; oy = 0; ox = 0
  tint = 0; morph = 0; blush = 0; es = 1; badgeS = 0

  tgYaw = 0; tgPitch = 0; tgTilt = 0; tgSy = 1; tgSx = 1; tgEs = 1

  slotH = 0; slotHTarget = 0; slotHVel = 0; isChewing = false

  col: RGB = C.idle
  colT: RGB = C.idle
  state: EngineState = 'idle'
  cfg: StateCfg = ENGINE_STATES.idle

  eyeOverride: EyeShape | null = null
  eyeOverrideUntil = 0
  badge: Badge | null = null
  private badgeKey = 'none'

  lookX = 0
  lookY = 0

  private tweens = new Map<PropKey, Tween>()
  private locks = new Set<PropKey>()
  private particles: Particle[] = []
  private jobs: Array<{ at: number; run: () => void }> = []
  private t0 = secondsNow() - Math.random() * 5
  private nextBlink = secondsNow() + 1.5 + Math.random() * 2
  private lastAmbient = 0
  private miniLookTarget = { x: 0, y: 0 }
  private miniLookNextTime = 0

  /** Apply a state. `silent` skips entry choreography (used on first mount so
   * a remounted avatar does not replay a stale completion roll). */
  setState(next: EngineState, { force = false, silent = false } = {}) {
    if (this.state === next && !force) return
    const prev = this.state
    this.state = next
    this.cfg = ENGINE_STATES[next]
    this.colT = this.cfg.color
    if (!this.locks.has('tint')) this.tint = this.cfg.tint
    if (!this.locks.has('tilt')) this.tgTilt = this.cfg.tilt
    if (silent) {
      this.col = this.colT
      this.badge = this.cfg.badge
      this.badgeKey = badgeKeyOf(this.cfg.badge)
      this.badgeS = this.cfg.badge ? 1 : 0
      this.morph = this.cfg.morph
      this.isChewing = next === 'chewing'
      return
    }
    this.setBadge(this.cfg.badge)

    const wasBox = ENGINE_STATES[prev].morph > 0.5
    const isBox = this.cfg.morph > 0.5
    if (isBox && !wasBox) this.animateMorph(1)
    if (!isBox && wasBox) this.animateMorph(0)
    if (next === 'chewing' && prev === 'upload') this.gulp()
    this.isChewing = next === 'chewing'
    this.slotHTarget = next === 'upload' ? 0.32 : 0

    switch (next) {
      case 'finished':
        this.doRoll(950, 1)
        this.later(500, () => this.emit('spark', 5))
        break
      case 'error':
      case 'fileError':
        this.anim('ox', [[0.08, 50, Ease.out], [-0.08, 70, Ease.inOut], [0.05, 70, Ease.inOut], [0, 90, Ease.out]])
        break
      case 'approval':
      case 'budget':
        this.anim('oy', [[-0.2, 150, Ease.out], [0, 300, Ease.back]])
        break
      case 'dizzy':
        this.doRoll(1300, 2)
        break
      case 'question':
        this.blink()
        break
      case 'ratelimit':
        this.emit('sweat', 1)
        break
      case 'fileReady':
        this.triggerEmote('happy', 0.9)
        break
      default:
        if (prev !== 'idle' || next !== 'idle') this.blink()
    }
  }

  setBadge(b: Badge | null) {
    const key = badgeKeyOf(b)
    if (key === this.badgeKey) return
    this.badgeKey = key
    this.anim('badgeS', [[0, 90, Ease.inOut]])
    this.later(100, () => {
      if (key !== this.badgeKey) return
      this.badge = b
      if (b) this.anim('badgeS', [[1, 280, Ease.back]])
    })
  }

  blink() {
    if (this.locks.has('open')) return
    this.anim('open', [[0.06, 70, Ease.inOut], [1, 130, Ease.out]])
  }

  squash() {
    this.anim('sy', [[0.78, 70, Ease.out], [1.1, 130, Ease.out], [1, 170, Ease.inOut]])
    this.anim('sx', [[1.16, 70, Ease.out], [0.95, 130, Ease.out], [1, 170, Ease.inOut]])
  }

  /** Mailbox swallow — opens the slot, chews, then closes. */
  gulp() {
    this.slotHTarget = 0.42
    this.later(460, () => {
      this.slotHTarget = 0
      this.isChewing = true
      this.later(800, () => { this.isChewing = this.state === 'chewing' })
    })
    this.anim('sy', [[0.78, 80, Ease.out], [1.18, 130, Ease.out], [1, 220, Ease.back]])
    this.anim('sx', [[1.28, 80, Ease.out], [0.92, 130, Ease.out], [1, 220, Ease.back]])
    this.blink()
  }

  /** A single poke: squash and squint. The three-poke dizzy rule lives in the
   * canvas wrapper so its recovery deadline survives unmounting. */
  slap() {
    if (this.state === 'dizzy') return
    this.squash()
    this.eyeOverride = 'line'
    this.eyeOverrideUntil = secondsNow() + 0.8
  }

  doRoll(durationMs: number, turns: number) {
    this.roll = 0
    this.anim('roll', [[Math.PI * 2 * turns, durationMs, Ease.inOut]], () => { this.roll = 0 })
  }

  triggerEmote(emote: Emote, duration = 1.8) {
    const t = secondsNow()
    this.eyeOverride = EMOTE_EYE[emote]
    this.eyeOverrideUntil = t + duration
    switch (emote) {
      case 'love':
        this.anim('blush', [[1, 300, Ease.out], [1, (duration - 0.6) * 1000, Ease.lin], [0, 300, Ease.inOut]])
        this.emit('heart', 4)
        this.anim('oy', [[-0.1, 160, Ease.out], [0, 300, Ease.back]])
        break
      case 'surprised':
        this.anim('oy', [[-0.3, 140, Ease.out], [0, 380, Ease.back]])
        this.anim('es', [[1.25, 120, Ease.out], [1, 500, Ease.inOut]])
        break
      case 'happy':
        this.anim('blush', [[0.6, 200, Ease.out], [0, 600, Ease.inOut]])
        break
      case 'annoyed':
        this.eyeOverrideUntil = t + 0.8
        break
    }
  }

  emit(type: Particle['type'], count: number) {
    if (this.reducedMotion || this.isMini) return
    for (let i = 0; i < count; i++) {
      const isZ = type === 'z'
      this.particles.push({
        type,
        x: (Math.random() - 0.5) * 0.9 + (isZ ? 0.55 : 0),
        y: -0.7 - Math.random() * 0.2,
        vx: (Math.random() - 0.5) * 0.35 + (isZ ? 0.18 : 0),
        vy: -(0.45 + Math.random() * 0.35),
        age: -i * 0.14,
        life: 1.3 + Math.random() * 0.5,
        rot: Math.random() * Math.PI * 2,
        size: 0.15 + Math.random() * 0.08,
      })
    }
  }

  animateMorph(target: number, durationMs?: number) {
    this.anim('morph', [[target, durationMs ?? (target > 0.5 ? 550 : 650), Ease.inOut]])
  }

  /** Changes the silhouette. A new shape lands with a small squash so the swap reads as the blob's own move. */
  setLook(look: BlobLook | null | undefined, animated = true) {
    const next = resolveForm(look)
    if (next === this.form) return
    const reshaped = next.shape !== this.form.shape
    this.form = next
    if (animated && reshaped && !this.reducedMotion) this.squash()
  }

  /** True while anything is still moving or animating on screen. */
  get busy(): boolean {
    if (this.reducedMotion) return this.tweens.size > 0
    const animatedBadge = this.badge && this.badgeS > 0.01 && this.badge.kind === 'dots'
    return (
      this.tweens.size > 0 || this.jobs.length > 0 || this.particles.length > 0 || !!animatedBadge || this.isChewing ||
      this.cfg.bounces || this.cfg.scans || this.cfg.breathes || this.cfg.zz || this.cfg.sweat ||
      this.state === 'dizzy' || this.eyeOverride === 'spiral' || this.isMini ||
      Math.abs(this.tgYaw - this.yaw) > 0.002 || Math.abs(this.tgPitch - this.pitch) > 0.002 ||
      Math.abs(this.tgTilt - this.tilt) > 0.002 || Math.abs(this.tgSy - this.sy) > 0.002 ||
      Math.abs(this.tgSx - this.sx) > 0.002 || Math.abs(this.tgEs - this.es) > 0.002 ||
      this.slotH > 0.001 || Math.abs(this.slotHVel) > 0.001 ||
      Math.abs(this.col[0] - this.colT[0]) > 0.003 || Math.abs(this.col[1] - this.colT[1]) > 0.003 ||
      Math.abs(this.col[2] - this.colT[2]) > 0.003
    )
  }

  /** Milliseconds until the engine next needs a frame while otherwise idle. */
  get msUntilWake(): number {
    const n = secondsNow()
    let wake = this.nextBlink
    if (this.eyeOverride && Number.isFinite(this.eyeOverrideUntil)) wake = Math.min(wake, this.eyeOverrideUntil)
    for (const job of this.jobs) wake = Math.min(wake, job.at)
    return Math.max(0, (wake - n) * 1000)
  }

  anim(prop: PropKey, keys: readonly TweenKey[], onComplete?: () => void) {
    if (this.reducedMotion) {
      const last = keys[keys.length - 1]
      this[prop] = prop === 'roll' ? 0 : last[0]
      this.tweens.delete(prop)
      this.locks.delete(prop)
      onComplete?.()
      return
    }
    this.tweens.set(prop, { keys, index: 0, from: this[prop], startMs: performance.now(), onComplete })
    this.locks.add(prop)
  }

  later(delayMs: number, run: () => void) {
    if (this.reducedMotion) { run(); return }
    this.jobs.push({ at: secondsNow() + delayMs / 1000, run })
  }

  update(dt: number) {
    const n = secondsNow()
    const nowMs = performance.now()

    if (this.jobs.length) {
      const due = this.jobs.filter((job) => job.at <= n)
      this.jobs = this.jobs.filter((job) => job.at > n)
      for (const job of due) job.run()
    }

    for (const [prop, tw] of [...this.tweens.entries()]) {
      const k = tw.keys[tw.index]
      const p = Math.min(1, Math.max(0, (nowMs - tw.startMs) / k[1]))
      this[prop] = tw.from + (k[0] - tw.from) * k[2](p)
      if (p >= 1) {
        tw.from = k[0]
        tw.index += 1
        tw.startMs = nowMs
        if (tw.index >= tw.keys.length) {
          this.tweens.delete(prop)
          this.locks.delete(prop)
          tw.onComplete?.()
        }
      }
    }

    const t = n - this.t0
    let ty = this.lookX * 0.62
    let tp = this.lookY * 0.5
    if (this.cfg.look) {
      ty = ty * 0.35 + this.cfg.look[0] * 0.55
      tp = tp * 0.3 + this.cfg.look[1] * 0.5
    }
    const motion = !this.reducedMotion
    if (this.cfg.scans && motion) { ty = Math.sin(t * 2.6) * 0.6; tp = -0.06 }
    if (this.state === 'sleeping') { ty = 0; tp = -0.14 }
    if (this.state === 'dizzy' && motion) ty = Math.sin(t * 9) * 0.25

    if (this.isMini && !this.cfg.look && !this.cfg.scans && this.state !== 'sleeping' && this.state !== 'dizzy' && motion) {
      if (n > this.miniLookNextTime) {
        this.miniLookTarget = { x: -0.88 + Math.random() * 1.76, y: -0.55 + Math.random() * 1.0 }
        this.miniLookNextTime = n + 0.5 + Math.random() * 1.5
      }
      ty = this.miniLookTarget.x * 0.62
      tp = this.miniLookTarget.y * 0.5
    }

    this.tgYaw = ty
    this.tgPitch = tp
    this.tgTilt = this.cfg.tilt

    const bounce = this.cfg.bounces && motion ? -Math.abs(Math.sin(t * 5.2)) * 0.07 : 0
    const kGen = motion ? 1 - Math.pow(0.0008, dt) : 1
    if (!this.locks.has('oy')) this.oy += (bounce - this.oy) * kGen

    if (this.cfg.breathes && motion) {
      const amp = this.isMini ? 0.07 : 0.035
      this.tgSy = 1 + Math.sin(t * 1.8) * amp
      this.tgSx = 1 - Math.sin(t * 1.8) * amp * 0.57
    } else if (this.isChewing && motion) {
      this.tgSy = 1 + Math.sin(t * 14) * 0.035
      this.tgSx = 1 - Math.sin(t * 14) * 0.025
    } else if (this.isMini && motion) {
      this.tgSy = 1 + Math.sin(t * 2.2) * 0.04
      this.tgSx = 1 - Math.sin(t * 2.2) * 0.02
    } else {
      this.tgSy = 1
      this.tgSx = 1
    }

    const kLook = motion ? 1 - Math.pow(0.0025, dt) : 1
    if (!this.locks.has('yaw')) this.yaw += (this.tgYaw - this.yaw) * kLook
    if (!this.locks.has('pitch')) this.pitch += (this.tgPitch - this.pitch) * kLook
    if (!this.locks.has('tilt')) this.tilt += (this.tgTilt - this.tilt) * kGen
    if (!this.locks.has('sy')) this.sy += (this.tgSy - this.sy) * kGen
    if (!this.locks.has('sx')) this.sx += (this.tgSx - this.sx) * kGen
    if (!this.locks.has('es')) this.es += (this.tgEs - this.es) * kGen
    this.col = motion ? mix3(this.col, this.colT, 1 - Math.pow(0.002, dt)) : this.colT

    if (n > this.nextBlink) {
      if (motion && this.state !== 'sleeping' && this.state !== 'dizzy') {
        this.blink()
        if (Math.random() < 0.22) this.later(230, () => this.blink())
      }
      this.nextBlink = n + 2.2 + Math.random() * 3.2
    }

    if (this.eyeOverride && n > this.eyeOverrideUntil) this.eyeOverride = null

    if (n - this.lastAmbient > 1.3) {
      this.lastAmbient = n
      if (this.cfg.zz) this.emit('z', 1)
      if (this.cfg.sweat && Math.random() < 0.5) this.emit('sweat', 1)
    }

    for (const p of this.particles) p.age += dt
    this.particles = this.particles.filter((p) => p.age < p.life)

    // Mouth slot spring — ω₀ = 2π/0.25, ζ = 0.6
    const omega = (2 * Math.PI) / 0.25
    const acc = omega * omega * (this.slotHTarget - this.slotH) - 2 * 0.6 * omega * this.slotHVel
    this.slotHVel += acc * dt
    this.slotH = Math.max(0, this.slotH + this.slotHVel * dt)
    if (this.morph < 0.05 && this.slotHTarget === 0) { this.slotH = 0; this.slotHVel = 0 }
  }

  /** Eye colour with contrast against the body: light eyes on a dark body. */
  get ink() {
    const [r, g, b] = this.bodyColor
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.24 ? LIGHT_INK : INK
  }

  /** Pixels per layout unit. Every silhouette is fitted to the same footprint: its furthest point sits on R. */
  private unitFor(R: number) {
    return R / UNITS_PER_RADIUS / formReach(this.form)
  }

  /** Draw into a `W`×`H` CSS-pixel canvas (DPR transform already applied). */
  draw(x: CanvasRenderingContext2D, W: number, H: number) {
    const R = Math.min(W, H) * BODY_RADIUS
    const unit = this.unitFor(R)
    const cx = W / 2 + this.ox * R
    const cy = H / 2 + this.oy * R
    // Soft bodies roll backwards by turning their face over the top; the
    // cornered and spiky silhouettes spin as a whole.
    const spherical = !SPINNING_SHAPES.has(this.form.shape)

    x.save()
    x.translate(cx, cy)
    if (!spherical && Math.abs(this.roll) > 0.001) x.rotate(this.roll)
    if (this.tilt !== 0) x.rotate(this.tilt)
    x.scale(this.sx, this.sy)

    const body = () => traceForm(x, this.form, unit, R, this.morph)
    this.drawBody(x, body, R)
    this.drawCatFeatures(x, body, unit, spherical, 'under')
    const eyes = this.eyeFrames(R, unit, spherical)

    const blushVal = Math.max(this.blush, this.tint * 0.5 * (this.state === 'error' || this.state === 'dizzy' ? 1 : 0.4)) * (1 - this.morph)
    if (blushVal > 0.01 && typeof x.clip === 'function') {
      x.save()
      body(); x.clip()
      x.fillStyle = `rgba(255,120,150,${0.5 * blushVal})`
      const faceScale = this.form.face.rx * unit / R
      for (const eye of eyes) {
        if (!eye.visible) continue
        x.beginPath()
        x.ellipse(eye.x + eye.sd * R * 0.2 * faceScale, eye.y + eye.ry * 1.05 + R * 0.08 * faceScale, R * 0.17 * faceScale, R * 0.1 * faceScale, 0, 0, Math.PI * 2)
        x.fill()
      }
      x.restore()
    }

    this.drawEyes(x, body, eyes)
    this.drawCatFeatures(x, body, unit, spherical, 'over')
    if (this.morph > 0.05) this.drawMouth(x, body, R)
    if (this.cfg.dim > 0) {
      x.fillStyle = `rgba(16,18,22,${this.cfg.dim})`
      body(); x.fill()
    }
    x.restore()

    if (this.badge && this.badgeS > 0.01 && this.morph < 0.25) this.drawBadge(x, this.badge, R, cx, cy)
    this.drawParticles(x, R, cx, cy)
  }

  private drawBody(x: CanvasRenderingContext2D, body: () => void, R: number) {
    const c = this.bodyColor
    const g = x.createRadialGradient(-R * 0.38, -R * 0.48, R * 0.05, -R * 0.1, -R * 0.1, R * 1.45)
    if (this.isMini) {
      g.addColorStop(0, rgba(mix3(c, WHITE, 0.22)))
      g.addColorStop(1, rgba(mix3(c, BLACK, 0.12)))
    } else {
      g.addColorStop(0, rgba(mix3(c, WHITE, 0.62)))
      g.addColorStop(0.55, rgba(mix3(c, WHITE, 0.12)))
      g.addColorStop(1, rgba(mix3(c, BLACK, 0.2)))
    }
    x.fillStyle = g
    body(); x.fill()

    const effectiveTint = this.tint * (1 - this.morph * 0.5) * (this.isMini ? 0.5 : 0.85)
    if (effectiveTint > 0.01) {
      const tg = x.createLinearGradient(0, R, 0, -R * 0.2)
      tg.addColorStop(0, rgba(this.col, 0.72 * effectiveTint))
      tg.addColorStop(1, rgba(this.col, 0))
      x.fillStyle = tg
      body(); x.fill()
    }
    if (this.isMini) return

    const sh = x.createRadialGradient(0, 0, R * 0.15, 0, 0, R * 1.05)
    sh.addColorStop(0, 'rgba(0,0,0,0)')
    sh.addColorStop(0.7, 'rgba(0,0,0,0)')
    sh.addColorStop(1, 'rgba(0,0,0,0.16)')
    x.fillStyle = sh
    body(); x.fill()

    const hl = x.createRadialGradient(-R * 0.36, -R * 0.5, 0, -R * 0.36, -R * 0.5, R * 0.55)
    hl.addColorStop(0, 'rgba(255,255,255,0.5)')
    hl.addColorStop(1, 'rgba(255,255,255,0)')
    x.fillStyle = hl
    body(); x.fill()
  }

  /** Each eye turned across the face by the current yaw and pitch (and roll, on a round body). */
  eyeFrames(R: number, unit: number, spherical: boolean): EyeFrame[] {
    const f = this.form
    const pitch = this.pitch + (spherical ? this.roll : 0)
    const mult = this.isMini ? 1.15 : 1
    return f.eyes.map((eye, index) => {
      const turned = turnEye(eyeAnchor(eye, f), this.yaw, pitch)
      return {
        x: (f.face.cx - 50 + turned.x * f.face.rx) * unit,
        y: (f.face.cy - 50 - turned.y * f.face.ry) * unit + (this.morph > 0 ? R * 0.14 * this.morph : 0),
        rx: eye.rx * unit * this.es * mult,
        ry: eye.ry * unit * this.es * mult,
        n: eye.n,
        rot: eye.rot,
        lean: turned.lean,
        fx: lerp(turned.fx, 1, this.morph * 0.7),
        fy: lerp(turned.fy, 1, this.morph * 0.7),
        visible: turned.z > 0.04,
        sd: index === 0 ? -1 : 1,
      }
    })
  }

  /**
   * The cat's details. `under` paints what sits on the body below the eyes
   * (stripes, inner ears, muzzle); `over` paints the nose, mouth and whiskers.
   * Face details follow the face's turn, so they roll and glance with the eyes.
   */
  private drawCatFeatures(x: CanvasRenderingContext2D, body: () => void, unit: number, spherical: boolean, layer: 'under' | 'over') {
    const f = this.form.features
    if (!f) return
    const fade = 1 - Math.min(1, this.morph * 2.5)
    if (fade <= 0.01) return
    const c = this.bodyColor
    const at = (px: number, py: number) => [(px - 50) * unit, (py - 50) * unit] as const
    const anchor = eyeAnchor({ cx: f.nose.cx, cy: f.nose.cy, rx: 0, ry: 0, n: 2, rot: 0 }, this.form)
    const turned = turnEye(anchor, this.yaw, this.pitch + (spherical ? this.roll : 0))
    const dx = (turned.x - anchor.x) * this.form.face.rx * unit
    const dy = -(turned.y - anchor.y) * this.form.face.ry * unit
    const faceVisible = turned.z > 0.04
    const dark = this.ink === INK
    const stroke = dark ? rgba(mix3(c, [0.22, 0.11, 0.05], 0.86), 0.9) : 'rgba(240,242,246,0.85)'
    const canClip = typeof x.clip === 'function'
    x.save()
    x.globalAlpha *= fade
    x.lineCap = 'round'
    x.lineJoin = 'round'
    if (layer === 'under') {
      for (const ear of f.innerEars) {
        x.beginPath()
        ear.forEach(([px, py], index) => { const [ex, ey] = at(px, py); if (index === 0) x.moveTo(ex, ey); else x.lineTo(ex, ey) })
        x.closePath()
        x.fillStyle = rgba(mix3(c, [1, 0.6, 0.64], 0.62))
        x.fill()
      }
      if (canClip) { body(); x.clip() }
      x.strokeStyle = rgba(mix3(c, BLACK, 0.26), 0.55)
      x.lineWidth = Math.max(0.8, unit * 2.4)
      for (const [[x0, y0], [x1, y1]] of f.stripes) {
        const [ax, ay] = at(x0, y0)
        const [bx, by] = at(x1, y1)
        x.beginPath(); x.moveTo(ax, ay); x.lineTo(bx, by); x.stroke()
      }
      if (faceVisible) {
        const [mx, my] = at(f.muzzle.cx, f.muzzle.cy)
        const g = x.createRadialGradient(mx + dx, my + dy, 0, mx + dx, my + dy, f.muzzle.rx * unit)
        g.addColorStop(0, rgba(mix3(c, WHITE, 0.7), 0.95))
        g.addColorStop(0.65, rgba(mix3(c, WHITE, 0.55), 0.6))
        g.addColorStop(1, rgba(mix3(c, WHITE, 0.4), 0))
        x.fillStyle = g
        x.beginPath()
        x.ellipse(mx + dx, my + dy, f.muzzle.rx * unit, f.muzzle.ry * unit, 0, 0, Math.PI * 2)
        x.fill()
      }
      x.restore()
      return
    }
    if (!faceVisible) { x.restore(); return }
    x.translate(dx, dy)
    x.strokeStyle = stroke
    x.lineWidth = Math.max(0.6, unit * 0.9)
    for (const [[x0, y0], [x1, y1]] of f.whiskers) {
      const [ax, ay] = at(x0, y0)
      const [bx, by] = at(x1, y1)
      x.beginPath(); x.moveTo(ax, ay); x.quadraticCurveTo((ax + bx) / 2, (ay + by) / 2 - unit * 0.8, bx, by); x.stroke()
    }
    if (canClip) { body(); x.clip() }
    const [mx, my] = at(f.mouth.cx, f.mouth.cy)
    const w = f.mouth.w * unit
    x.lineWidth = Math.max(0.8, unit * 1.4)
    x.beginPath()
    x.arc(mx - w / 2, my, w / 2, 0.1 * Math.PI, 0.95 * Math.PI)
    x.moveTo(mx + w, my)
    x.arc(mx + w / 2, my, w / 2, 0.05 * Math.PI, 0.9 * Math.PI)
    x.stroke()
    x.beginPath(); x.moveTo(mx, my - w * 0.55); x.lineTo(mx, my); x.stroke()
    const [nx, ny] = at(f.nose.cx, f.nose.cy)
    const r = f.nose.r * unit
    x.fillStyle = '#ff8f8f'
    x.beginPath()
    x.moveTo(nx - r * 1.15, ny - r * 0.6)
    x.quadraticCurveTo(nx, ny - r * 1.05, nx + r * 1.15, ny - r * 0.6)
    x.quadraticCurveTo(nx + r * 0.9, ny + r * 0.35, nx, ny + r * 0.75)
    x.quadraticCurveTo(nx - r * 0.9, ny + r * 0.35, nx - r * 1.15, ny - r * 0.6)
    x.fill()
    x.fillStyle = 'rgba(255,255,255,0.7)'
    x.beginPath(); x.ellipse(nx - r * 0.3, ny - r * 0.45, r * 0.32, r * 0.18, -0.3, 0, Math.PI * 2); x.fill()
    x.restore()
  }

  private drawEyes(x: CanvasRenderingContext2D, body: () => void, eyes: readonly EyeFrame[]) {
    let shape: EyeShape = this.eyeOverride ?? this.cfg.eye
    if (this.morph > 0.5) {
      if (this.isChewing) shape = 'happy'
      else if (this.slotHTarget > 0.05 || this.slotH > 0.1) shape = 'cup'
    }
    const canClip = typeof x.clip === 'function'
    // Glossy eyes stay dark on any body; their catchlights carry the contrast.
    const ink = this.form.glint ? INK : this.ink
    x.save()
    if (canClip) { body(); x.clip() }
    x.fillStyle = ink
    x.strokeStyle = ink
    for (const eye of eyes) {
      if (!eye.visible) continue
      x.save()
      x.translate(eye.x, eye.y)
      // Lean the eye with the surface so a sideways glance reads as a turn.
      x.rotate(eye.lean)
      x.scale(eye.fx, eye.fy)
      // Big glossy eyes would make the expression shapes (arcs, lines, hearts) heavy.
      const expression = this.form.glint && shape !== 'pill' && shape !== 'wide' ? 0.68 : 1
      const w = eye.rx * 2 * expression
      const h = eye.ry * 2 * expression
      this.drawEyeShape(x, shape, w, h, h * 0.48, eye.sd, eye.n, eye.rot)
      if (this.form.glint && (shape === 'pill' || shape === 'wide') && this.open > 0.55) {
        // Glossy eyes: one big catchlight and one small one, fixed to the eye.
        x.fillStyle = 'rgba(255,255,255,0.92)'
        x.beginPath(); x.arc(w * 0.16, -h * 0.2, w * 0.17, 0, Math.PI * 2); x.fill()
        x.beginPath(); x.arc(-w * 0.14, h * 0.17, w * 0.07, 0, Math.PI * 2); x.fill()
        x.fillStyle = ink
      }
      x.restore()
    }
    x.restore()
  }

  private drawEyeShape(x: CanvasRenderingContext2D, shape: EyeShape, w: number, h: number, arcH: number, sd: number, n = 4.5, lean = 0) {
    const t = secondsNow()
    switch (shape) {
      case 'wide':
        this.drawEyeShape(x, 'pill', w * 1.16, h * 1.08, arcH, sd, n, lean)
        break
      case 'pill': {
        const hh = Math.max(h * this.open, w * 0.32)
        eyePath(x, w / 2, hh / 2, n, lean)
        x.fill()
        break
      }
      case 'dot':
        x.beginPath(); x.arc(0, 0, w * 0.62, 0, Math.PI * 2); x.fill()
        break
      case 'line':
        x.rotate(-sd * 0.2)
        roundRectPath(x, -w * 0.85, -w * 0.22, w * 1.7, w * 0.44, w * 0.22)
        x.fill()
        break
      case 'flat':
        roundRectPath(x, -w * 0.8, -w * 0.22, w * 1.6, w * 0.44, w * 0.22)
        x.fill()
        break
      case 'happy':
        x.lineWidth = w * 0.5
        x.lineCap = 'round'
        x.beginPath(); x.arc(0, arcH * 0.18, w * 0.82, Math.PI * 1.12, Math.PI * 1.88); x.stroke()
        break
      case 'closed':
        x.lineWidth = w * 0.36
        x.lineCap = 'round'
        x.beginPath(); x.arc(0, -arcH * 0.08, w * 0.78, Math.PI * 0.15, Math.PI * 0.85); x.stroke()
        break
      case 'spiral': {
        x.lineWidth = w * 0.22
        x.lineCap = 'round'
        x.beginPath()
        for (let a = 0; a < 4.4 * Math.PI; a += 0.2) {
          const r = w * 0.06 + a * w * 0.058
          const aa = a + t * 9 * sd
          if (a === 0) x.moveTo(Math.cos(aa) * r, Math.sin(aa) * r)
          else x.lineTo(Math.cos(aa) * r, Math.sin(aa) * r)
        }
        x.stroke()
        break
      }
      case 'heart':
        x.fillStyle = '#FF4D6D'
        heartPath(x, w * 1.2)
        x.fill()
        x.fillStyle = this.ink
        break
      case 'star':
        x.fillStyle = '#F7B32B'
        x.rotate(t * 1.5 * sd)
        starPath(x, w * 1.05, w * 0.46)
        x.fill()
        x.fillStyle = this.ink
        break
      case 'tired':
        roundRectPath(x, -w / 2, -arcH * 0.02, w, arcH * 0.5, w / 2)
        x.fill()
        roundRectPath(x, -w * 0.66, -arcH * 0.12, w * 1.32, w * 0.24, w * 0.12)
        x.fill()
        break
      case 'wink':
        if (sd < 0) this.drawEyeShape(x, 'pill', w, h, arcH, sd, n, lean)
        else this.drawEyeShape(x, 'happy', w, h, arcH, sd)
        break
      case 'cup': {
        const hh = Math.max(h * 0.55 * this.open, w * 0.3)
        const cr = Math.min(w / 2, hh / 2)
        x.beginPath()
        x.moveTo(-w / 2, -hh / 2)
        x.lineTo(w / 2, -hh / 2)
        x.lineTo(w / 2, hh / 2 - cr)
        x.quadraticCurveTo(w / 2, hh / 2, w / 2 - cr, hh / 2)
        x.lineTo(-w / 2 + cr, hh / 2)
        x.quadraticCurveTo(-w / 2, hh / 2, -w / 2, hh / 2 - cr)
        x.closePath()
        x.fill()
        break
      }
    }
  }

  /** Mailbox slot cut into the box face, with rim and lip highlights. */
  private drawMouth(x: CanvasRenderingContext2D, body: () => void, R: number) {
    const m = this.morph
    const hW = R * 1.6 * m
    const hH = this.slotH * R * m
    const boxTop = -R * (0.88 + 0.06 * m)
    const hY = boxTop + R * 0.1 * m
    x.save()
    if (typeof x.clip === 'function') { body(); x.clip() }
    x.strokeStyle = `rgba(255,255,255,${0.55 * m})`
    x.lineWidth = 1
    x.lineCap = 'round'
    x.beginPath(); x.moveTo(-R * 0.82 * m, boxTop + 1); x.lineTo(R * 0.82 * m, boxTop + 1); x.stroke()
    if (hH > 0.8) {
      const hR = Math.min(hW / 2, hH / 2)
      const g = x.createLinearGradient(0, hY, 0, hY + hH)
      g.addColorStop(0, 'rgb(7,8,10)')
      g.addColorStop(1, 'rgb(16,19,26)')
      roundRectPath(x, -hW / 2, hY, hW, hH, hR)
      x.fillStyle = g
      x.fill()
    }
    x.restore()
  }

  private drawBadge(x: CanvasRenderingContext2D, badge: Badge, R: number, cx: number, cy: number) {
    const bs = this.badgeS * (this.isMini ? 1.2 : 1)
    const bx = cx + R * BADGE_OFFSET.x * this.sx
    const by = cy + R * BADGE_OFFSET.y * this.sy
    const t = secondsNow()
    const col = rgba(badge.color)
    const ring = '#0b0b0d'
    x.save()
    x.translate(bx, by)
    x.scale(bs, bs)

    if (badge.kind === 'dot' || this.isMini) {
      const outer = R * (this.isMini ? 0.26 : 0.2)
      const inner = R * (this.isMini ? 0.18 : 0.14)
      let pulse = 1
      if (badge.kind === 'dots' && !this.reducedMotion) pulse = 1 + 0.2 * Math.sin(((t * 2.4) % 1) * Math.PI * 2)
      x.fillStyle = ring
      x.beginPath(); x.arc(0, 0, outer, 0, Math.PI * 2); x.fill()
      x.fillStyle = col
      x.beginPath(); x.arc(0, 0, inner * pulse, 0, Math.PI * 2); x.fill()
      x.restore()
      return
    }

    const outer = R * BADGE_RADIUS
    const inner = R * (BADGE_RADIUS * (0.27 / 0.34))
    x.fillStyle = ring
    x.beginPath(); x.arc(0, 0, outer, 0, Math.PI * 2); x.fill()
    x.fillStyle = col
    x.beginPath(); x.arc(0, 0, inner, 0, Math.PI * 2); x.fill()

    const glyph = '#06142e'
    switch (badge.kind) {
      case 'dots':
        for (let i = 0; i < 3; i++) {
          const phase = this.reducedMotion ? 0.25 : ((((t * 2.4 - i * 0.22) % 1) + 1) % 1)
          const lift = Math.max(0, Math.sin(phase * Math.PI * 2))
          x.fillStyle = glyph
          x.beginPath(); x.arc((i - 1) * R * 0.12, -lift * R * 0.04, R * 0.045 * (1 + 0.35 * lift), 0, Math.PI * 2); x.fill()
        }
        break
      case 'bang':
      case 'question':
        x.fillStyle = '#fff'
        x.font = `900 ${R * 0.34}px ${FONT}`
        x.textAlign = 'center'
        x.textBaseline = 'middle'
        x.fillText(badge.kind === 'bang' ? '!' : '?', 0, R * 0.02)
        break
      case 'clip': {
        const s = R * 0.09
        x.strokeStyle = '#fff'
        x.lineWidth = Math.max(1, R * 0.045)
        x.lineCap = 'round'
        x.beginPath()
        x.moveTo(s * 0.65, s * 0.55)
        x.quadraticCurveTo(s * 1.5, -s * 0.25, s * 0.55, -s * 0.95)
        x.quadraticCurveTo(-s * 0.1, -s * 1.45, -s * 0.75, -s * 0.75)
        x.lineTo(-s * 0.35, s * 0.55)
        x.quadraticCurveTo(0, s * 1.05, s * 0.65, s * 0.55)
        x.lineTo(s * 0.1, -s * 0.35)
        x.stroke()
        break
      }
      case 'arrow': {
        const lift = this.reducedMotion ? 0 : Math.sin(t * 6) * R * 0.025
        x.strokeStyle = '#fff'
        x.lineWidth = Math.max(1, R * 0.05)
        x.lineCap = 'round'
        x.lineJoin = 'round'
        x.beginPath()
        x.moveTo(0, R * 0.11 + lift); x.lineTo(0, -R * 0.1 + lift)
        x.moveTo(-R * 0.09, -R * 0.01 + lift); x.lineTo(0, -R * 0.11 + lift); x.lineTo(R * 0.09, -R * 0.01 + lift)
        x.stroke()
        break
      }
    }
    x.restore()
  }

  private drawParticles(x: CanvasRenderingContext2D, R: number, cx: number, cy: number) {
    for (const p of this.particles) {
      if (p.age <= 0) continue
      const k = p.age / p.life
      const a = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8
      const px = cx + (p.x + p.vx * p.age) * R * 1.3
      const py = cy + (p.y + p.vy * p.age) * R * 1.3
      const sz = R * p.size * (1 + k * 0.4)
      x.save()
      x.translate(px, py)
      x.globalAlpha = Math.min(1, Math.max(0, a))
      switch (p.type) {
        case 'heart':
          x.rotate(Math.sin(p.age * 6) * 0.3)
          x.fillStyle = '#FF4D6D'
          heartPath(x, sz)
          x.fill()
          break
        case 'star':
          x.rotate(p.rot + p.age * 2)
          x.fillStyle = '#F7B32B'
          starPath(x, sz, sz * 0.45)
          x.fill()
          break
        case 'spark':
          x.rotate(p.rot)
          x.fillStyle = '#fff'
          starPath(x, sz * 0.8, sz * 0.18)
          x.fill()
          break
        case 'sweat':
          x.fillStyle = '#7CC7FF'
          x.beginPath()
          x.moveTo(0, -sz)
          x.quadraticCurveTo(sz * 0.8, sz * 0.2, 0, sz * 0.6)
          x.quadraticCurveTo(-sz * 0.8, sz * 0.2, 0, -sz)
          x.fill()
          break
        case 'z':
          x.fillStyle = 'rgb(209,219,235)'
          x.font = `700 ${sz * 1.9}px ${FONT}`
          x.textAlign = 'center'
          x.textBaseline = 'middle'
          x.fillText('z', 0, 0)
          break
      }
      x.restore()
    }
  }
}

function badgeKeyOf(b: Badge | null) { return b ? `${b.kind}-${b.color.join(',')}` : 'none' }
