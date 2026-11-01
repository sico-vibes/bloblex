import { GREETING_END_MS } from './greetingScene'

/** Lifecycle shared by the canvas so a reduced-motion greeting still settles. */
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
    if (!this.active || (!reducedMotion && this.age(now) < GREETING_END_MS)) return false
    this.lastAge = reducedMotion ? GREETING_END_MS : Math.min(this.age(now), GREETING_END_MS)
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
