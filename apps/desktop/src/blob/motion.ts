import { GREETING_END_MS } from './greetingScene'

export const greetingDurationMs = GREETING_END_MS

/** Lifecycle shared by the canvas and shell callback so an interrupted or
 * reduced-motion greeting cannot leave the companion in its launch state. */
export class GreetingLifecycle {
  private startedAt = 0
  private lastAge = 0
  active = false
  hasRun = false

  begin(now: number) {
    this.startedAt = now
    this.lastAge = 0
    this.active = true
    this.hasRun = true
  }

  age(now: number) {
    if (!this.active) return this.lastAge
    return Math.max(0, now - this.startedAt)
  }

  finishIfDue(now: number, reducedMotion = false) {
    if (!this.active || (!reducedMotion && this.age(now) < greetingDurationMs)) return false
    this.lastAge = reducedMotion ? greetingDurationMs : Math.min(this.age(now), greetingDurationMs)
    this.active = false
    return true
  }

  interrupt(_now: number) {
    if (!this.active) return false
    this.lastAge = greetingDurationMs
    this.active = false
    return true
  }

  reset() {
    this.startedAt = 0
    this.lastAge = 0
    this.active = false
    this.hasRun = false
  }
}

/** Deadline is intentionally independent of the canvas effect lifetime. */
export class DizzyRecoveryDeadline {
  private timer: ReturnType<typeof setTimeout> | null = null

  restart(recover: () => void, delayMs = 3300) {
    this.cancel()
    this.timer = setTimeout(() => {
      this.timer = null
      recover()
    }, delayMs)
  }

  cancel() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}
