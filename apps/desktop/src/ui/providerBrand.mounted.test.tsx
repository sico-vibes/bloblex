// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeMark } from './providerBrand'

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(() => { if (root) act(() => root?.unmount()); root = null; host?.remove(); host = null; vi.unstubAllGlobals() })

describe('runtime logo tooltip', () => {
  it('opens below on keyboard focus, clamps to the viewport, and closes on Escape', async () => {
    vi.stubGlobal('innerWidth', 320)
    vi.stubGlobal('innerHeight', 120)
    host = document.createElement('div'); document.body.append(host)
    root = createRoot(host)
    act(() => root?.render(<RuntimeMark provider="claude" />))
    const mark = host.querySelector<HTMLElement>('.runtime-mark')!
    const wrapper = host.querySelector<HTMLElement>('.runtime-mark-tip')!
    Object.defineProperty(wrapper, 'getBoundingClientRect', { value:() => ({ left:0, right:16, top:0, bottom:20, width:16, height:20, x:0, y:0, toJSON:() => ({}) }) })
    await act(async () => { mark.focus(); await Promise.resolve() })
    const tooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]')!
    expect(tooltip.textContent).toBe('Runs on Claude Code')
    expect(Number.parseFloat(tooltip.style.top)).toBeGreaterThanOrEqual(20)
    expect(Number.parseFloat(tooltip.style.top) + 28).toBeLessThanOrEqual(120)
    expect(Number.parseFloat(tooltip.style.left)).toBeGreaterThan(0)
    await act(async () => { mark.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true })) })
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull()
  })
})
