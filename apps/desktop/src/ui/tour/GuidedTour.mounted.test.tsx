// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GuidedTour, TourInvite } from './GuidedTour'
import { tourSteps } from './tourSteps'

let root: Root | null = null
let host: HTMLDivElement | null = null
const anchors: HTMLElement[] = []

function anchor(name: string, box: { x: number; y: number; width: number; height: number }) {
  const element = document.createElement('div')
  element.dataset.tour = name
  element.getBoundingClientRect = () => ({ ...box, top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => box }) as DOMRect
  document.body.append(element)
  anchors.push(element)
  return element
}
function mount(ui: React.ReactElement) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(ui))
}
const steps = tourSteps('bot', 'bots')
const flush = async (ms = 0) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) }) }
afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove(); anchors.splice(0).forEach((element) => element.remove()); document.querySelectorAll('.coach, .tour-invite').forEach((node) => node.remove())
  root = null; host = null; vi.useRealTimers()
})

describe('GuidedTour', () => {
  it('has six stops, with the remote stop last', () => {
    expect(steps).toHaveLength(6)
    expect(steps[5]).toMatchObject({ id: 'remote', anchor: 'remote', placement: 'right' })
  })

  it('ends the tour when the sixth remote anchor never appears', async () => {
    vi.useFakeTimers()
    const onFinish = vi.fn()
    mount(<GuidedTour steps={steps} step={5} onStep={vi.fn()} onFinish={onFinish} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(onFinish).toHaveBeenCalledWith('done')
  })

  it('shows the current step, moves with Next and Back and finishes with Done', async () => {
    for (const [index, step] of steps.entries()) anchor(step.anchor, { x: 20, y: 40 + index * 60, width: 200, height: 40 })
    const onStep = vi.fn()
    const onFinish = vi.fn()
    mount(<GuidedTour steps={steps} step={0} onStep={onStep} onFinish={onFinish} />)
    await flush()
    const card = document.querySelector('.coach-card')!
    expect(card.textContent).toContain('Your bots live here')
    expect(card.textContent).toContain('1 of 6')
    expect(card.textContent).not.toContain('Back')
    await act(async () => { [...card.querySelectorAll('button')].find((button) => button.textContent === 'Next')!.click() })
    expect(onStep).toHaveBeenCalledWith(1)
    act(() => root?.unmount()); host?.remove()
    mount(<GuidedTour steps={steps} step={5} onStep={onStep} onFinish={onFinish} />)
    await flush()
    const lastCard = document.querySelector('.coach-card')!
    expect(lastCard.textContent).toContain('6 of 6')
    await act(async () => { [...lastCard.querySelectorAll('button')].find((button) => button.textContent === 'Done')!.click() })
    expect(onFinish).toHaveBeenCalledWith('done')
  })

  it('skips on Escape and from the Skip button, and never acts for the person', async () => {
    anchor('roster', { x: 0, y: 0, width: 280, height: 500 })
    const onFinish = vi.fn()
    mount(<GuidedTour steps={steps} step={0} onStep={vi.fn()} onFinish={onFinish} />)
    await flush()
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(onFinish).toHaveBeenCalledWith('skipped')
    await act(async () => { document.querySelector<HTMLButtonElement>('.coach-skip')!.click() })
    expect(onFinish).toHaveBeenCalledTimes(2)
  })

  it('skips a step whose anchor never appears', async () => {
    vi.useFakeTimers()
    anchor('roster', { x: 0, y: 0, width: 280, height: 500 })
    const onStep = vi.fn()
    mount(<GuidedTour steps={steps} step={1} onStep={onStep} onFinish={vi.fn()} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(onStep).toHaveBeenCalledWith(2)
  })
})

describe('TourInvite', () => {
  it('offers the tour with a way out', () => {
    const onStart = vi.fn(); const onDismiss = vi.fn()
    mount(<TourInvite plural="bots" onStart={onStart} onDismiss={onDismiss} />)
    const aside = document.querySelector('.tour-invite')!
    expect(aside.textContent).toContain('your bots')
    act(() => { [...aside.querySelectorAll('button')].find((button) => button.textContent === 'Start tour')!.click() })
    act(() => { [...aside.querySelectorAll('button')].find((button) => button.textContent === 'Not now')!.click() })
    expect(onStart).toHaveBeenCalledOnce()
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
