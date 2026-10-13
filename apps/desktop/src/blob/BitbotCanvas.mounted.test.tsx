// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlobCanvas } from './BlobCanvas'
import { setBitbotsEnabled } from './bitbots'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => {
  if (root) act(() => root!.unmount())
  host?.remove(); root = null; host = null
  setBitbotsEnabled(false)
  vi.useRealTimers()
})

function mount(node: React.ReactNode) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(node))
  return host
}

describe('BlobCanvas in Bitbots mode', () => {
  it('draws a robot with the antenna off and speed one, in the outline the look asks for', () => {
    setBitbotsEnabled(true)
    const element = mount(<BlobCanvas color="#2b49a3" size={60} mood="thinking" label="Vex" look={{ shape: 'round', seed: 's', bot: { shape: 'hexagon' } }} />)
    const frame = element.querySelector('.bitbot-frame')!
    expect(frame.getAttribute('data-bitbot-shape')).toBe('hexagon')
    expect(frame.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Vex thinking')
    // Only the robot's own canvas: no classic blob canvas and no corner glyph elements.
    expect(element.querySelectorAll('canvas')).toHaveLength(1)
    expect(element.querySelector('.blob-canvas')).toBeNull()
  })

  it('falls back to the classic blob when the mode is off', () => {
    const element = mount(<BlobCanvas color="#2b49a3" size={60} label="Vex" />)
    expect(element.querySelector('.bitbot-frame')).toBeNull()
    expect(element.querySelector('canvas.blob-canvas')).not.toBeNull()
  })

  it('welcomes with a spin and then reports the greeting done', () => {
    vi.useFakeTimers()
    setBitbotsEnabled(true)
    const done = vi.fn()
    const element = mount(<BlobCanvas color="#2b49a3" size={60} greeting onGreetingComplete={done} />)
    const robot = element.querySelector<HTMLElement>('[role="img"]')!
    const clicked = vi.fn()
    robot.addEventListener('click', clicked)
    act(() => { vi.advanceTimersByTime(600) })
    expect(clicked).toHaveBeenCalledOnce()
    expect(done).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(2200) })
    expect(done).toHaveBeenCalledOnce()
  })

  it('three quick pokes make it dizzy and then it recovers', () => {
    vi.useFakeTimers()
    setBitbotsEnabled(true)
    const start = vi.fn(), recover = vi.fn()
    const element = mount(<BlobCanvas color="#2b49a3" size={60} onDizzy={start} onDizzyRecovery={recover} />)
    const frame = element.querySelector('.bitbot-frame')!
    for (let index = 0; index < 3; index++) act(() => { frame.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    expect(start).toHaveBeenCalledOnce()
    act(() => { vi.advanceTimersByTime(3400) })
    expect(recover).toHaveBeenCalledOnce()
  })
})
