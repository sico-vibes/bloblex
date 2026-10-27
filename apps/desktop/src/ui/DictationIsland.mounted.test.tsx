// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { DictationIsland } from './DictationIsland'

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = null; host = null })

function show(props: Partial<Parameters<typeof DictationIsland>[0]>) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(<DictationIsland phase="listening" level={0.1} since={Date.now()} {...props} />))
  return host
}

// The owner asked for the recorder bubble only (25 October 2026): FIX43's live words and "Words appear when you stop." note are gone for every engine.
describe('dictation island is a recorder only', () => {
  it('shows the timer and level bars while listening, with no words and no note', () => {
    const island = show({})
    expect(island.querySelector('.dictation-island-time')).not.toBeNull()
    expect(island.querySelector('.dictation-island-wave')).not.toBeNull()
    expect(island.querySelector('.dictation-island-text')).toBeNull()
    expect(island.querySelector('.dictation-island')?.classList.contains('is-expanded')).toBe(false)
    expect(island.textContent).not.toMatch(/Words appear/)
  })

  it('does not accept or show a transcript, whatever the phase', () => {
    for (const phase of ['listening', 'processing', 'done', 'silent'] as const) {
      act(() => root?.unmount()); host?.remove()
      // A stray `text` prop (an old caller) must change nothing.
      const island = show({ phase, ...({ text: 'Hello there, this is' } as object) })
      expect(island.textContent).not.toContain('Hello there')
      expect(island.querySelector('.dictation-island-text')).toBeNull()
    }
  })

  it('keeps its notes for loading, finished and silent recordings', () => {
    expect(show({ warming: true }).textContent).toContain('Getting ready')
    act(() => root!.render(<DictationIsland phase="done" level={0} since={Date.now() - 4000} stoppedAt={Date.now()} />))
    expect(host!.textContent).toContain('Added to your message')
    act(() => root!.render(<DictationIsland phase="silent" level={0} since={Date.now() - 4000} stoppedAt={Date.now()} />))
    expect(host!.textContent).toContain('Nothing heard')
  })

  it('still explains an error and expands only for that', () => {
    const island = show({ phase: 'error', errorText: 'No microphone is available.' })
    expect(island.querySelector('.dictation-island-text.error')?.textContent).toBeTruthy()
    expect(island.querySelector('.dictation-island')?.classList.contains('is-expanded')).toBe(true)
  })
})
