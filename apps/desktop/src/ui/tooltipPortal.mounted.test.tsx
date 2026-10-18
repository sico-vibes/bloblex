// @vitest-environment happy-dom
// Tooltips must render in a layer above everything and stay inside the window,
// even when their trigger sits in a panel that hides its own overflow.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tip } from './Tip'
import { HelpTip } from './SettingsParts'

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number; x: number; y: number; toJSON: () => Record<string, never> }
const rect = (left: number, top: number, width: number, height: number): Rect => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) })

const BUBBLE = { width: 200, height: 60 }
const VIEW = { width: 400, height: 300 }
const MARGIN = 8
let anchorRect: Rect = rect(0, 140, 24, 24)
let root: Root | null = null
let host: HTMLDivElement | null = null

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('innerWidth', VIEW.width)
  vi.stubGlobal('innerHeight', VIEW.height)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('tip-bubble') || this.classList.contains('help-tip-bubble')) return rect(0, 0, BUBBLE.width, BUBBLE.height)
    if (this.classList.contains('tip') || this.classList.contains('help-tip')) return anchorRect
    return rect(0, 0, 0, 0)
  })
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mount(node: ReactNode) {
  host = document.createElement('div')
  // The trigger lives in a panel that hides its overflow, next to the right edge.
  host.className = 'settings-sheet'
  Object.defineProperty(host, 'getBoundingClientRect', { value: () => rect(0, 0, VIEW.width, VIEW.height) })
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(node))
}

const bubbleIn = (selector: string) => document.body.querySelector<HTMLElement>(selector)!

describe('tooltip portal', () => {
  it('renders a Tip outside its overflow-hidden parent and inside the viewport', () => {
    anchorRect = rect(VIEW.width - 30, 140, 24, 24)
    mount(<Tip text="Available later"><button type="button">Effort</button></Tip>)
    const bubble = bubbleIn('.tip-bubble')
    expect(bubble.textContent).toBe('Available later')
    expect(document.body.contains(bubble)).toBe(true)
    expect(host!.contains(bubble)).toBe(false)
    expect(bubble.classList.contains('tip-portal')).toBe(true)
    expect(Number.parseFloat(bubble.style.left)).toBeGreaterThanOrEqual(MARGIN)
    expect(Number.parseFloat(bubble.style.left) + BUBBLE.width).toBeLessThanOrEqual(VIEW.width - MARGIN)
  })

  it('renders a HelpTip outside the Settings sheet and keeps its id for aria-describedby', () => {
    anchorRect = rect(VIEW.width - 30, 140, 24, 24)
    mount(<HelpTip text="Resets the companion position" id="companion-reset-hint" />)
    const bubble = bubbleIn('.help-tip-bubble')
    expect(document.body.contains(bubble)).toBe(true)
    expect(host!.contains(bubble)).toBe(false)
    expect(document.getElementById('companion-reset-hint')).toBe(bubble)
    expect(bubble.getAttribute('role')).toBe('tooltip')
    expect(Number.parseFloat(bubble.style.left) + BUBBLE.width).toBeLessThanOrEqual(VIEW.width - MARGIN)
    expect(Number.parseFloat(bubble.style.left)).toBeGreaterThanOrEqual(MARGIN)
  })

  it('flips a top tooltip below when there is no room above the trigger', () => {
    anchorRect = rect(40, 4, 24, 24)
    mount(<Tip text="Explains the control"><button type="button">Control</button></Tip>)
    const bubble = bubbleIn('.tip-bubble')
    expect(Number.parseFloat(bubble.style.top)).toBeGreaterThanOrEqual(anchorRect.bottom)
    expect(Number.parseFloat(bubble.style.top) + BUBBLE.height).toBeLessThanOrEqual(VIEW.height - MARGIN)
  })

  it('opens on focus and closes on Escape', async () => {
    anchorRect = rect(40, 140, 24, 24)
    mount(<Tip text="Explains the control"><button type="button">Control</button></Tip>)
    const bubble = bubbleIn('.tip-bubble')
    expect(bubble.getAttribute('data-open')).toBe('false')
    const trigger = host!.querySelector('button')!
    await act(async () => { trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); await Promise.resolve() })
    expect(bubble.getAttribute('data-open')).toBe('true')
    await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await Promise.resolve() })
    expect(bubble.getAttribute('data-open')).toBe('false')
  })
})
