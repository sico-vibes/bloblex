// Motion equations ported from the reference selectors. Provider labels and the
// catalog's dynamic range remain owned by Bloblex.
export const CLAUDE_SPRING = { stiffness: 920, damping: 40, maxFrameSeconds: 0.032 } as const
export const OUTLINE_SPRING = { stiffness: 845, damping: 58.5, maxStep: 1 / 120, sigma: 1.12 } as const
export const CODEX_SNAP_DURATION = 380
export const OUTLINE_CARD_Y_SPRING = { stiffness: 430, damping: 41, maxFrameSeconds: 0.032 } as const
export const OUTLINE_CARD_HEIGHT_SPRING = { stiffness: 460, damping: 43, maxFrameSeconds: 0.032 } as const
const CODEX_BASE = [3, 113, 221] as const
const CODEX_FINAL = [[46,97,212],[165,123,253],[139,115,243]] as const

export function applyClaudeMagnet(value: number) {
  const nearest = Math.round(value)
  const delta = value - nearest
  const distance = Math.abs(delta)
  if (distance < 0.001 || distance > 0.5) return value
  const t = 1 - distance / 0.5
  return value - delta * (0.68 + 0.42 * t) * t * t
}

export function claudePointerVelocity(samples: Array<{ time: number; value: number }>) {
  if (samples.length < 2) return 0
  const first = samples[0]
  const last = samples[samples.length - 1]
  const elapsed = Math.max((last.time - first.time) / 1000, 0.016)
  return Math.max(-8, Math.min(8, (last.value - first.value) / elapsed))
}

export function codexDragPosition(clientX: number, rectLeft: number, rectWidth: number, trackWidth: number, knobDiameter: number) {
  if (!(rectWidth > 0) || !(trackWidth > knobDiameter)) return null
  const fraction = (clientX - rectLeft) / rectWidth
  // Reference maps coordinates through the measured track/knob geometry.
  return Math.min(1, Math.max(0, (fraction * trackWidth - knobDiameter / 2) / (trackWidth - knobDiameter)))
}

export function codexSnapProgress(elapsedMs: number) {
  // Reference CSS linear() spring curve sampled at its authored progress points.
  const points: Array<[number, number]> = [[0,0],[.034,.062],[.075,.24],[.125,.51],[.179,.76],[.224,.905],[.272,.997],[.324,1.038],[.374,1.05],[.427,1.044],[.492,1.028],[.569,1.012],[.657,1.003],[.76,.999],[1,1]]
  const t = Math.max(0, Math.min(1, elapsedMs / CODEX_SNAP_DURATION))
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i][0]) {
      const [t0, v0] = points[i - 1]
      const [t1, v1] = points[i]
      return v0 + (v1 - v0) * ((t - t0) / (t1 - t0))
    }
  }
  return 1
}

export function codexGradientAt(index:number,count:number) {
  const t=count<2?0:Math.max(0,Math.min(1,index/(count-1)))
  return CODEX_FINAL.map((end)=>CODEX_BASE.map((start,channel)=>start+(end[channel]-start)*t)) as [number[],number[],number[]]
}

export function codexRgb(value:number[]) { return `rgb(${value.map((channel)=>Math.round(channel)).join(' ')})` }

export function outlineTickInfluence(index: number, floatIndex: number) {
  const distance = index - floatIndex
  return Math.exp(-(distance * distance) / (2 * OUTLINE_SPRING.sigma * OUTLINE_SPRING.sigma))
}

export function stepOutlineSpring(value: number, velocity: number, target: number, deltaSeconds: number) {
  const dt = Math.max(0, Math.min(1, deltaSeconds))
  const steps = Math.max(1, Math.ceil(dt / OUTLINE_SPRING.maxStep))
  const step = dt / steps
  for (let i = 0; i < steps; i++) {
    velocity += ((target - value) * OUTLINE_SPRING.stiffness - velocity * OUTLINE_SPRING.damping) * step
    value += velocity * step
  }
  return { value, velocity }
}

export function stepOutlineCardSpring(y:number,yVelocity:number,targetY:number,height:number,heightVelocity:number,targetHeight:number,deltaSeconds:number) {
  const dt=Math.max(0,Math.min(OUTLINE_CARD_Y_SPRING.maxFrameSeconds,deltaSeconds))
  const yAcceleration=(targetY-y)*OUTLINE_CARD_Y_SPRING.stiffness-yVelocity*OUTLINE_CARD_Y_SPRING.damping
  const heightAcceleration=(targetHeight-height)*OUTLINE_CARD_HEIGHT_SPRING.stiffness-heightVelocity*OUTLINE_CARD_HEIGHT_SPRING.damping
  yVelocity+=yAcceleration*dt;heightVelocity+=heightAcceleration*dt
  y+=yVelocity*dt;height+=heightVelocity*dt
  return {y,yVelocity,height,heightVelocity}
}
