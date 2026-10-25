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
  act(() => root!.render(<DictationIsland phase="listening" level={0.1} since={Date.now()} text="" {...props} />))
  return host
}

describe('dictation island words', () => {
  it('shows the words as they arrive, finals and the current partial together', () => {
    const island = show({ text: 'Hello there, this is' })
    expect(island.querySelector('.dictation-island-text')?.textContent).toBe('Hello there, this is')
    expect(island.querySelector('.dictation-island-text.note')).toBeNull()
  })

  it('says plainly that ChatGPT transcription shows its words when you stop, instead of showing nothing', () => {
    const island = show({ engine: { engine: 'chatgpt', fallback: false } })
    expect(island.querySelector('.dictation-island-text.note')?.textContent).toBe('Words appear when you stop.')
  })

  it('leaves an on-device engine that has not heard words yet without a note, and drops the note once words arrive', () => {
    expect(show({ engine: { engine: 'on-device', fallback: false } }).querySelector('.dictation-island-text')).toBeNull()
    act(() => root!.render(<DictationIsland phase="listening" level={0.1} since={Date.now()} text="" engine={{ engine: 'chatgpt', fallback: false }} warming />))
    expect(host!.querySelector('.dictation-island-text')).toBeNull()
    act(() => root!.render(<DictationIsland phase="listening" level={0.1} since={Date.now()} text="One two" engine={{ engine: 'chatgpt', fallback: false }} />))
    expect(host!.querySelector('.dictation-island-text')?.textContent).toBe('One two')
    expect(host!.querySelector('.dictation-island-text.note')).toBeNull()
  })
})
