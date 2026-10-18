// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlobLook } from '../blob/look'
import { setBitbotsEnabled } from '../blob/bitbots'
import { LookEditor } from './LookEditor'

vi.mock('../blob/BlobCanvas', () => ({
  BlobCanvas: ({ look, mood, label }: { look?: BlobLook; mood?: string; label?: string }) => <span data-shape={look?.shape} data-mood={mood ?? 'idle'} data-label={label} />,
}))

const mounted: Array<{ root: Root; host: HTMLDivElement }> = []
function mount(look: BlobLook, locked = false) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const onLookChange = vi.fn()
  const onColorChange = vi.fn()
  const render = (next: BlobLook) => root.render(<LookEditor look={next} color="mint" colorHex="#9be7c4" name="Pololo" locked={locked} onLookChange={onLookChange} onColorChange={onColorChange} />)
  act(() => render(look))
  mounted.push({ root, host })
  return { host, render, onLookChange, onColorChange }
}
const click = (element: Element | null | undefined) => act(() => { (element as HTMLElement).click() })

beforeEach(() => { setBitbotsEnabled(false); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(() => { for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() } vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('look editor', () => {
  it('previews every shape in the blob and picks one by click or arrow keys', () => {
    const { host, onLookChange } = mount({ shape: 'circle', seed: 'pololo' })
    const radios = [...host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Bot shape"] [role="radio"]')]
    expect(radios).toHaveLength(8)
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
    expect(radios.map((radio) => radio.querySelector('span[data-shape]')?.getAttribute('data-shape'))).toEqual(['circle', 'pebble', 'squircle', 'capsule', 'triangle', 'hexagon', 'cloud', 'droplet'])
    click(radios[5])
    expect(onLookChange).toHaveBeenLastCalledWith({ shape: 'hexagon', seed: 'pololo' })
    act(() => radios[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(onLookChange).toHaveBeenLastCalledWith({ shape: 'triangle', seed: 'pololo' })
  })

  it('previews moods on the stage without changing the look', () => {
    const { host, onLookChange } = mount({ shape: 'pebble', seed: 'a' })
    const stage = () => host.querySelector('.look-stage span[data-shape]')
    expect(stage()?.getAttribute('data-mood')).toBe('idle')
    click([...host.querySelectorAll('[aria-label="Preview mood"] [role="radio"]')].find((item) => item.textContent === 'Asleep'))
    expect(stage()?.getAttribute('data-mood')).toBe('sleeping')
    expect(onLookChange).not.toHaveBeenCalled()
  })

  it('pins a trait from a slider, shows the count and resets back to the seed', () => {
    const { host, render, onLookChange } = mount({ shape: 'hexagon', seed: 'a' })
    click([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.startsWith('Fine-tune')))
    const labels = [...host.querySelectorAll('.look-slider label')].map((label) => label.textContent)
    expect(labels).toContain('Size')
    expect(labels).toContain('Squareness')
    expect(labels).not.toContain('Roundness')
    expect(labels).not.toContain('Tilt')
    const sizeSlider = host.querySelector<HTMLInputElement>(`#${CSS.escape([...host.querySelectorAll('.look-slider label')].find((label) => label.textContent === 'Size')!.getAttribute('for')!)}`)!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(sizeSlider, '0.8')
      sizeSlider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onLookChange).toHaveBeenLastCalledWith({ shape: 'hexagon', seed: 'a', traits: { 'eye.rx': 0.8 } })
    act(() => render({ shape: 'hexagon', seed: 'a', traits: { 'eye.rx': 0.8 } }))
    expect(host.querySelector('.look-tab-count')?.textContent).toBe('1')
    click(host.querySelector('[aria-label="Reset size"]'))
    expect(onLookChange).toHaveBeenLastCalledWith({ shape: 'hexagon', seed: 'a', traits: undefined })
    click([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Reset tweaks')))
    expect(onLookChange).toHaveBeenLastCalledWith({ shape: 'hexagon', seed: 'a' })
  })

  it('counts only pins read by visible controls and still lets Reset tweaks clear legacy pins', () => {
    const legacyTraits = { 'eye.lean': 0.1, 'eye.scale': 0.3, 'body.rot': 0.8, 'sun.n': 0.6 }
    const { host, render, onLookChange } = mount({ shape: 'cloud', seed: 'saved', traits: { ...legacyTraits, 'eye.rx': 0.8, 'eye.n': 0.4 } })
    expect(host.querySelector('.look-tab-count')?.textContent).toBe('2')
    expect(host.querySelector('.look-tab-count')?.getAttribute('aria-label')).toBe('2 adjusted')
    click([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.startsWith('Fine-tune')))
    expect(host.querySelectorAll('.look-slider.pinned')).toHaveLength(2)
    click(host.querySelector('[aria-label="Reset squareness"]'))
    expect(onLookChange).toHaveBeenLastCalledWith({ shape: 'cloud', seed: 'saved', traits: { ...legacyTraits, 'eye.rx': 0.8 } })
    act(() => render({ shape: 'cloud', seed: 'saved', traits: legacyTraits }))
    expect(host.querySelector('.look-tab-count')).toBeNull()
    expect(host.querySelectorAll('.look-slider.pinned')).toHaveLength(0)
    const reset = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Reset tweaks'))!
    expect(reset.disabled).toBe(false)
    click(reset)
    expect(onLookChange).toHaveBeenLastCalledWith({ shape: 'cloud', seed: 'saved' })
  })

  it('surprises with new eyes and colour while keeping the selected shape', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const original: BlobLook = { shape: 'hexagon', seed: 'a', traits: { 'eye.rx': 0.1 }, bot: { shape: 'square' } }
    const { host, render, onLookChange } = mount(original)
    click([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Surprise me')))
    const next = onLookChange.mock.lastCall?.[0] as BlobLook
    expect(next.shape).toBe('hexagon')
    expect(next.seed).not.toBe('a')
    expect(next.traits).toBeUndefined()
    expect(next.bot).toEqual(original.bot)
    expect(onLookChange.mock.lastCall?.[1]).toEqual(expect.not.stringMatching(/^mint$/))
    act(() => render(next))
    expect(host.querySelector('.look-shape[aria-checked="true"]')?.getAttribute('data-shape')).toBe('hexagon')
  })

  it('updates eyes and colour together in a parent draft without overwriting either', () => {
    function DraftEditor() {
      const [draft, setDraft] = useState({ look: { shape: 'circle', seed: 'original' } as BlobLook, color: 'mint' })
      return <>
        <LookEditor look={draft.look} color={draft.color} colorHex="#89D6B3" name="Draft"
          onLookChange={(look, color) => setDraft({ ...draft, look, color: color ?? draft.color })}
          onColorChange={(color) => setDraft({ ...draft, color })} />
        <output>{JSON.stringify(draft)}</output>
      </>
    }
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host); mounted.push({ root, host })
    act(() => root.render(<DraftEditor />))
    click([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Surprise me')))
    const saved = JSON.parse(host.querySelector('output')!.textContent!)
    expect(saved.look.seed).not.toBe('original')
    expect(saved.color).not.toBe('mint')
    expect(saved.look.shape).toBe('circle')
  })

  it.each([undefined, 'hexagon'] as const)('keeps the inferred or explicit robot outline (%s) on Surprise me', (outline) => {
    setBitbotsEnabled(true)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const { host, render, onLookChange } = mount({ shape: 'squircle', seed: 'a', ...(outline ? { bot: { shape: outline } } : {}) })
    click([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Surprise me')))
    const next = onLookChange.mock.lastCall?.[0] as BlobLook
    expect(next.shape).toBe('squircle')
    expect(next.bot?.shape).toBe(outline ?? 'square')
    act(() => render(next))
    expect(host.querySelector('.bot-shape[aria-checked="true"]')?.getAttribute('data-bot-shape')).toBe(outline ?? 'square')
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

  // FIX39 item 13 / P5 audit F3-adjacent: the read-only editor must be inert,
  // not merely covered by the disabled fieldset around it.
  it('makes every control inert while the bot is locked', () => {
    const { host, onLookChange, onColorChange } = mount({ shape: 'circle', seed: 'pololo' }, true)
    const shapes = [...host.querySelectorAll<HTMLButtonElement>('.look-shape')]
    expect(shapes).toHaveLength(8)
    expect(shapes.every((button) => button.disabled)).toBe(true)
    expect([...host.querySelectorAll<HTMLButtonElement>('.look-moods button')].every((button) => button.disabled)).toBe(true)
    expect([...host.querySelectorAll<HTMLButtonElement>('.look-stage-actions button')].every((button) => button.disabled)).toBe(true)
    expect([...host.querySelectorAll<HTMLButtonElement>('.look-tabs button')].every((button) => button.disabled)).toBe(true)
    expect([...host.querySelectorAll<HTMLButtonElement>('.swatch')].every((button) => button.disabled)).toBe(true)
    // Clicking a disabled control changes nothing.
    click(shapes[5])
    click(host.querySelector('.swatch'))
    expect(onLookChange).not.toHaveBeenCalled()
    expect(onColorChange).not.toHaveBeenCalled()
  })

  it('cannot even open the fine-tune tab while the bot is locked, and its sliders stay inert', () => {
    const { host, onLookChange } = mount({ shape: 'circle', seed: 'pololo', traits: { 'eye.rx': 0.4 } }, true)
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('.look-tabs button')]
    expect(tabs).toHaveLength(2)
    expect(tabs.every((button) => button.disabled)).toBe(true)
    click(tabs[1])
    expect(host.querySelector('.look-slider input[type="range"]')).toBeNull()
    expect(onLookChange).not.toHaveBeenCalled()
  })
})
