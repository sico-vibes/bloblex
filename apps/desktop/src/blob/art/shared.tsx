import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { BlobCanvasProps } from '../BlobCanvas'
import { moodWithFileReference, type BlobMood } from '../characterState'
import { GREETING_REFERENCE } from '../greetingScene'
import { artMoodFor, type ArtMood } from './art'

/** A short welcome, matching the 3D robot's hop rather than the long blob scene. */
export const ART_GREETING_MS = 2600

/** Read once per render; the CSS media query is the real guard. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

export function useArtMood({ mood = 'idle', fileStage, greeting = false, onGreetingComplete }: Pick<BlobCanvasProps, 'mood' | 'fileStage' | 'greeting' | 'onGreetingComplete'>): { artMood: ArtMood; effectiveMood: BlobMood } {
  const effectiveMood = moodWithFileReference(mood, fileStage)
  const [greetingActive, setGreetingActive] = useState(false)
  const completion = useRef(onGreetingComplete)
  const done = useRef(false)
  useEffect(() => { completion.current = onGreetingComplete }, [onGreetingComplete])
  useEffect(() => {
    if (!greeting) {
      done.current = false
      setGreetingActive(false)
      return
    }
    if (done.current) return
    if (prefersReducedMotion()) {
      done.current = true
      setGreetingActive(false)
      completion.current?.()
      return
    }
    setGreetingActive(true)
    const timer = window.setTimeout(() => {
      done.current = true
      setGreetingActive(false)
      completion.current?.()
    }, ART_GREETING_MS)
    return () => window.clearTimeout(timer)
  }, [greeting])
  return { artMood: greetingActive ? 'happy' : artMoodFor(effectiveMood), effectiveMood }
}

export function artBox(size: number, greeting: boolean) {
  return greeting
    ? { width: size * GREETING_REFERENCE.width / 100, height: size * GREETING_REFERENCE.height / 100 }
    : { width: size, height: size }
}

export function artAria(decorative: boolean | undefined, label: string, mood: BlobMood) {
  return decorative ? { 'aria-hidden': true as const } : { role: 'img' as const, 'aria-label': `${label}, ${mood}` }
}

export function ArtFrame({ art, width, height, className = '', dragRegion = false, mini = false, children }: {
  art: string
  width: number
  height: number
  className?: string
  dragRegion?: boolean
  mini?: boolean
  children: ReactNode
}) {
  return <span
    className={`blob-canvas-frame art-frame art-${art} ${className}`}
    style={{ width, height, position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', verticalAlign: 'top', overflow: 'visible' }}
    data-tauri-drag-region={dragRegion ? '' : undefined}
    data-art={art}
    data-mini={mini || undefined}
  >{children}</span>
}
