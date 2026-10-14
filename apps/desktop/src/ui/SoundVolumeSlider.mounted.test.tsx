// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SoundVolumeSlider } from './SoundVolumeSlider'

const mounted: Array<{ root: Root; host: HTMLDivElement }> = []

function Harness({ initial = 0.8, onChange, onCommit }: { initial?: number; onChange: (volume: number) => void; onCommit: (volume: number) => void }) {
  const [volume, setVolume] = useState(initial)
  return <SoundVolumeSlider value={volume} onChange={(next) => { setVolume(next); onChange(next) }} onCommit={onCommit} />
}

function mount(props: Parameters<typeof Harness>[0]) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(<Harness {...props} />))
  mounted.push({ root, host })
  return host
}

/** React tracks the value, so set it through the native setter and fire the input event. */
function drag(input: HTMLInputElement, percent: number) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { setter.call(input, String(percent)); input.dispatchEvent(new Event('input', { bubbles: true })) })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})
afterEach(() => {
  for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() }
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('SoundVolumeSlider', () => {
  it('is a native 0 to 100 range in 5% steps with a spoken percentage', () => {
    const host = mount({ initial: 0.35, onChange: vi.fn(), onCommit: vi.fn() })
    const input = host.querySelector<HTMLInputElement>('input[type="range"]')!
    expect(input.getAttribute('aria-label')).toBe('Companion sound volume')
    expect([input.min, input.max, input.step, input.value]).toEqual(['0', '100', '5', '35'])
    expect(input.getAttribute('aria-valuetext')).toBe('35%')
    expect(host.querySelector('.volume-value')?.textContent).toBe('35%')
  })

  it('follows a drag live but commits once, on release', () => {
    const onChange = vi.fn()
    const onCommit = vi.fn()
    const host = mount({ onChange, onCommit })
    const input = host.querySelector<HTMLInputElement>('input')!
    act(() => { input.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    for (const percent of [75, 60, 55, 45, 30]) drag(input, percent)
    expect(onChange.mock.calls.map(([volume]) => volume)).toEqual([0.75, 0.6, 0.55, 0.45, 0.3])
    act(() => { vi.advanceTimersByTime(2000) })
    expect(onCommit).not.toHaveBeenCalled()
    act(() => { input.dispatchEvent(new Event('pointerup', { bubbles: true })) })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(0.3)
    expect(host.querySelector('.volume-value')?.textContent).toBe('30%')
  })

  it('commits a keyboard step on key up, and only once', () => {
    const onCommit = vi.fn()
    const host = mount({ onChange: vi.fn(), onCommit })
    const input = host.querySelector<HTMLInputElement>('input')!
    drag(input, 85)
    expect(onCommit).not.toHaveBeenCalled()
    act(() => { input.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true })) })
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(0.85)
    act(() => { vi.advanceTimersByTime(2000) })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('still commits after a pause when no release event arrives', () => {
    const onCommit = vi.fn()
    const host = mount({ onChange: vi.fn(), onCommit })
    const input = host.querySelector<HTMLInputElement>('input')!
    drag(input, 90)
    drag(input, 95)
    expect(onCommit).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(600) })
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(0.95)
  })

  it('does not commit when nothing changed', () => {
    const onCommit = vi.fn()
    const host = mount({ onChange: vi.fn(), onCommit })
    const input = host.querySelector<HTMLInputElement>('input')!
    act(() => { input.dispatchEvent(new Event('pointerdown', { bubbles: true })); input.dispatchEvent(new Event('pointerup', { bubbles: true })) })
    act(() => { input.dispatchEvent(new FocusEvent('blur')) })
    expect(onCommit).not.toHaveBeenCalled()
  })
})
