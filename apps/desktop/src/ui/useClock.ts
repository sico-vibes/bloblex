import { useEffect, useState } from 'react'

/** Re-renders on an interval so time-based blob moods (happy, idle, asleep) settle on their own. */
export function useClock(intervalMs = 10_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}
