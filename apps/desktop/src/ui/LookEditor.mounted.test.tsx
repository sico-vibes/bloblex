// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlobLook } from '../blob/look'
import { LookEditor } from './LookEditor'

vi.mock('../blob/BlobCanvas', () => ({
  BlobCanvas: ({ look, mood, label }: { look?: BlobLook; mood?: string; label?: string }) => <span data-shape={look?.shape} data-mood={mood ?? 'idle'} data-label={label} />,
}))

const mounted: Array<{ root: Root; host: HTMLDivElement }> = []
function mount(look: BlobLook) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const onLookChange = vi.fn()
  const onColorChange = vi.fn()
  const render = (next: BlobLook) => root.render(<LookEditor look={next} color="mint" colorHex="#9be7c4" name="Pololo" onLookChange={onLookChange} onColorChange={onColorChange} />)
  act(() => render(look))
  mounted.push({ root, host })
  return { host, render, onLookChange, onColorChange }
}
const click = (element: Element | null | undefined) => act(() => { (element as HTMLElement).click() })

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(() => { for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() } vi.unstubAllGlobals() })

describe('look editor', () => {
  it('previews every shape in the blob and picks one by click or arrow keys', () => {
    const { host, onLookChange } = mount({ shape: 'round', seed: 'pololo' })
    const radios = [...host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Blob shape"] [role="radio"]')]
    expect(radios).toHaveLength(10)
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
    expect(radios.map((radio) => radio.querySelector('span[data-shape]')?.getAttribute('data-shape'))).toEqual(['round', 'organic', 'boxy', 'capsule', 'cloud', 'droplet', 'hexagon', 'sun', 'triangle', 'cat'])
    click(radios[7])
    expect(onLookChange).toHaveBeenLastCalledWith({ shape: 'sun', seed: 'pololo' })
    act(() => radios[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(onLookChange).toHaveBeenLastCalledWith({ shape: 'droplet', seed: 'pololo' })
  })

  it('previews moods on the stage without changing the look', () => {
    const { host, onLookChange } = mount({ shape: 'cat', seed: 'a' })
    const stage = () => host.querySelector('.look-stage span[data-shape]')
    expect(stage()?.getAttribute('data-mood')).toBe('idle')
    click([...host.querySelectorAll('[aria-label="Preview mood"] [role="radio"]')].find((item) => item.textContent === 'Asleep'))
    expect(stage()?.getAttribute('data-mood')).toBe('sleeping')
    expect(onLookChange).not.toHaveBeenCalled()
  })

  it('pins a trait from a slider, shows the count and resets back to the seed', () => {
    const { host, render, onLookChange } = mount({ shape: 'sun', seed: 'a' })
    click([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.startsWith('Fine-tune')))
    const labels = [...host.querySelectorAll('.look-slider label')].map((label) => label.textContent)
    expect(labels).toContain('Petals')
    expect(labels).not.toContain('Tilt')
    const petals = host.querySelector<HTMLInputElement>(`#${CSS.escape([...host.querySelectorAll('.look-slider label')].find((label) => label.textContent === 'Petals')!.getAttribute('for')!)}`)!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(petals, '0.8')
      petals.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onLookChange).toHaveBeenLastCalledWith({ shape: 'sun', seed: 'a', traits: { 'sun.n': 0.8 } })
    act(() => render({ shape: 'sun', seed: 'a', traits: { 'sun.n': 0.8 } }))
    expect(host.querySelector('.look-tab-count')?.textContent).toBe('1')
    click(host.querySelector('[aria-label="Reset petals"]'))
    expect(onLookChange).toHaveBeenLastCalledWith({ shape: 'sun', seed: 'a', traits: undefined })
    click([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Reset tweaks')))
    expect(onLookChange).toHaveBeenLastCalledWith({ shape: 'sun', seed: 'a' })
  })

  it('shuffles the face, keeps the shape, and credits the shape source', () => {
    const { host, onLookChange } = mount({ shape: 'hexagon', seed: 'a', traits: { 'eye.rx': 0.1 } })
    click([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Shuffle')))
    const next = onLookChange.mock.lastCall?.[0] as BlobLook
    expect(next.shape).toBe('hexagon')
    expect(next.seed).not.toBe('a')
    expect(next.traits).toBeUndefined()
    expect(host.querySelector('.look-credit')?.textContent).toContain('blobatar')
  })
})
