import { afterEach, describe, expect, it, vi } from 'vitest'
import { DizzyRecoveryDeadline, GreetingLifecycle, greetingDurationMs } from './motion'

afterEach(() => vi.useRealTimers())

describe('companion lifecycle helpers', () => {
  it('completes the production greeting once at 4.6 seconds and supports reduced motion', () => {
    const greeting = new GreetingLifecycle()
    greeting.begin(100)
    expect(greeting.active).toBe(true)
    expect(greeting.finishIfDue(100 + greetingDurationMs - 1)).toBe(false)
    expect(greeting.finishIfDue(100 + greetingDurationMs)).toBe(true)
    expect(greeting.finishIfDue(100 + greetingDurationMs + 50)).toBe(false)
    expect(greeting.age(9000)).toBe(greetingDurationMs)

    greeting.begin(300)
    expect(greeting.finishIfDue(301, true)).toBe(true)
    expect(greeting.active).toBe(false)
    expect(greeting.age(301)).toBe(greetingDurationMs)
  })

  it('finishes rather than strands a greeting when the user interrupts it', () => {
    const greeting = new GreetingLifecycle()
    greeting.begin(50)
    expect(greeting.interrupt(400)).toBe(true)
    expect(greeting.active).toBe(false)
    expect(greeting.age(401)).toBe(greetingDurationMs)
    expect(greeting.interrupt(402)).toBe(false)
  })

  it('keeps dizzy recovery on a deadline independent of canvas redraws and replaces stale deadlines', () => {
    vi.useFakeTimers()
    const deadline = new DizzyRecoveryDeadline()
    const recover = vi.fn()
    deadline.restart(recover, 3300)
    vi.advanceTimersByTime(3200)
    expect(recover).not.toHaveBeenCalled()
    deadline.restart(recover, 3300)
    vi.advanceTimersByTime(3299)
    expect(recover).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(recover).toHaveBeenCalledTimes(1)
  })
})
