// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionEffortMeter, type EffortMeterStyle } from './SessionEffortMeter'

const mounted: Array<{ root: Root; host: HTMLDivElement }> = []
const draw = {
  setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), save:vi.fn(), restore:vi.fn(), clip:vi.fn(), roundRect:vi.fn(),
  createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
}
const drawFunctions = [draw.setTransform, draw.clearRect, draw.fillRect, draw.beginPath, draw.arc, draw.fill, draw.save, draw.restore, draw.clip, draw.roundRect, draw.createLinearGradient]
function props(style: EffortMeterStyle, position = 0, count = 4, highest = false) {
  return { style, position, count, selectedLabel:'Low', defaultLabel:'Provider default', highest, snapping:false, burstKey:0, onChange:vi.fn(), onPointerMove:vi.fn(), onPointerDown:vi.fn(), onPointerUp:vi.fn(), onPointerCancel:vi.fn(), onLostPointerCapture:vi.fn(), onKeyDown:vi.fn(), onKeyUp:vi.fn(), disabled:false }
}
function mount(initial: ReturnType<typeof props>) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const render = (next: ReturnType<typeof props>) => root.render(<SessionEffortMeter {...next} />)
  act(() => render(initial))
  Object.defineProperty(host.querySelector('.session-effort-track'), 'getBoundingClientRect', { configurable:true, value:() => ({ width:320, height:28, top:0, right:320, bottom:28, left:0, x:0, y:0, toJSON:() => ({}) }) })
  mounted.push({ root, host })
  return { host, render }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches:query.includes('reduce'), media:query, addEventListener:vi.fn(), removeEventListener:vi.fn() })))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => draw as unknown as CanvasRenderingContext2D)
  for (const spy of drawFunctions) spy.mockClear()
})
afterEach(() => { for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() } vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('effort meter canvas lifecycle', () => {
  it('redraws current props under reduced motion without scheduling animation frames', async () => {
    const frame = vi.spyOn(window, 'requestAnimationFrame')
    const view = mount(props('claude', 0, 4, false))
    const initialDraws = draw.clearRect.mock.calls.length
    await act(async () => { view.render(props('claude', 3, 5, true)) })
    expect(draw.clearRect.mock.calls.length).toBeGreaterThan(initialDraws)
    expect(frame).not.toHaveBeenCalled()
  })

  it('does not run a perpetual blank canvas loop for an unknown provider style', () => {
    const frame = vi.spyOn(window, 'requestAnimationFrame')
    mount(props('neutral', 1, 3, false))
    expect(frame).not.toHaveBeenCalled()
  })

  it('pauses the continuous Codex particle loop while hidden and cancels it on unmount', async () => {
    vi.stubGlobal('matchMedia',vi.fn(()=>({matches:false,media:'(prefers-reduced-motion: no-preference)',addEventListener:vi.fn(),removeEventListener:vi.fn()})))
    const frame = vi.spyOn(window,'requestAnimationFrame').mockImplementation(()=>17)
    const cancel = vi.spyOn(window,'cancelAnimationFrame').mockImplementation(()=>undefined)
    const view=mount(props('magnetic',1,4,false))
    expect(frame).toHaveBeenCalled()
    Object.defineProperty(document,'hidden',{configurable:true,value:true})
    await act(async()=>{document.dispatchEvent(new Event('visibilitychange'))})
    expect(cancel).toHaveBeenCalledWith(17)
    Object.defineProperty(document,'hidden',{configurable:true,value:false})
    await act(async()=>{document.dispatchEvent(new Event('visibilitychange'))})
    expect(frame).toHaveBeenCalledTimes(2)
    const index=mounted.findIndex((item)=>item.host===view.host)
    const cancelCount=cancel.mock.calls.length
    await act(async()=>{mounted[index].root.unmount()})
    mounted.splice(index,1);view.host.remove()
    expect(cancel.mock.calls.length).toBeGreaterThan(cancelCount)
    expect(cancel.mock.calls.slice(cancelCount)).toContainEqual([17])
  })
})
