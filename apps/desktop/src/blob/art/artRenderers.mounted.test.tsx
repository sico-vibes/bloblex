// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaintedBlob } from './PaintedBlob'

const mounted: Array<{ root: Root; host: HTMLDivElement }> = []

function mount(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(node))
  mounted.push({ root, host })
  return host
}

const reduced = (matches: boolean) => ({ matches, media: '(prefers-reduced-motion: reduce)', onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(() => true) })

beforeEach(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => {
  for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() }
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('painted blob renderer', () => {
  it('draws a uniquely identified SVG and scales the body to the mood class', () => {
    const first = mount(<PaintedBlob color="#ff9bd0" size={44} mood="idle" look={{ shape: 'circle' }} label="Bot" />)
    const second = mount(<PaintedBlob color="#ff9bd0" size={44} mood="idle" look={{ shape: 'circle' }} label="Bot" />)
    expect(first.querySelector('svg.art-svg')?.classList.contains('art-mood-idle')).toBe(true)
    expect(first.querySelector('[data-art="painted"]')).toBeTruthy()
    expect(first.querySelector('svg')!.getAttribute('id')).not.toBe(second.querySelector('svg')!.getAttribute('id'))
  })

  it('shows a badge for state and a plain dot on mini avatars', () => {
    const working = mount(<PaintedBlob color="#ff9bd0" size={44} mood="working" look={{ shape: 'circle' }} label="Bot" />)
    expect(working.querySelector('.pb-badge.on')).toBeTruthy()
    expect(working.querySelectorAll('.pb-badge-dot').length).toBe(3)
    const mini = mount(<PaintedBlob color="#ff9bd0" size={18} mini mood="working" look={{ shape: 'circle' }} label="Bot" />)
    expect(mini.querySelector('.pb-badge.on')).toBeTruthy()
    expect(mini.querySelectorAll('.pb-badge-dot').length).toBe(0)
  })

  it('hides the highlight on mini avatars and keeps it on full ones', () => {
    const mini = mount(<PaintedBlob color="#ff9bd0" size={18} mini mood="idle" look={{ shape: 'circle' }} label="Bot" />)
    expect(mini.querySelector('[data-art="painted"]')?.getAttribute('data-mini')).toBe('true')
    expect(mini.querySelectorAll('.pb-light')).toHaveLength(0)
    const full = mount(<PaintedBlob color="#ff9bd0" size={44} mood="idle" look={{ shape: 'circle' }} label="Bot" />)
    expect(full.querySelectorAll('.pb-light')).toHaveLength(1)
  })

  it('has no badge while idle or offline, and a z while sleeping', () => {
    const idle = mount(<PaintedBlob color="#ff9bd0" size={44} mood="idle" look={{ shape: 'circle' }} label="Bot" />)
    expect(idle.querySelector('.pb-badge.on')).toBeNull()
    const offline = mount(<PaintedBlob color="#ff9bd0" size={44} mood="offline" look={{ shape: 'circle' }} label="Bot" />)
    expect(offline.querySelector('.pb-badge.on')).toBeNull()
    const sleeping = mount(<PaintedBlob color="#ff9bd0" size={44} mood="sleeping" look={{ shape: 'circle' }} label="Bot" />)
    expect(sleeping.querySelector('.pb-badge.on text')?.textContent).toBe('z')
  })

  it('still shows a still pose under reduced motion', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => reduced(true)))
    const host = mount(<PaintedBlob color="#ff9bd0" size={44} mood="idle" look={{ shape: 'circle' }} label="Bot" />)
    expect(host.querySelector('svg.art-svg')?.classList.contains('art-still')).toBe(true)
    expect(host.querySelector('svg.art-svg')?.classList.contains('art-mood-idle')).toBe(true)
  })
})

// The owner's hand-painted art follows the pointer without moving its body.
describe('painted gaze', () => {
  it('tracks the pointer on a large avatar and stops after unmount', async () => {
    vi.stubGlobal('matchMedia', () => reduced(false))
    const host = mount(<PaintedBlob color="#89d6b3" size={100} />)
    const svg = host.querySelector('svg')!
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ x:0,y:0,left:0,top:0,right:100,bottom:100,width:100,height:100,toJSON:()=>({}) })
    window.dispatchEvent(new PointerEvent('pointermove', {clientX:200,clientY:150}))
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const gaze = host.querySelector('.pb-gaze')!
    expect(gaze.getAttribute('transform')).toMatch(/^translate\([1-3]/)
    const view = mounted.pop()!
    const before = gaze.getAttribute('transform')
    act(() => view.root.unmount())
    window.dispatchEvent(new PointerEvent('pointermove', {clientX:0,clientY:0}))
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(gaze.getAttribute('transform')).toBe(before)
    view.host.remove()
  })
  it('does not track on mini avatars or with reduced motion', async () => {
    vi.stubGlobal('matchMedia', () => reduced(true))
    const host = mount(<PaintedBlob color="#89d6b3" size={100} />)
    window.dispatchEvent(new PointerEvent('pointermove', {clientX:200,clientY:150}))
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(host.querySelector('.pb-gaze')?.hasAttribute('transform')).toBe(false)
  })
})
