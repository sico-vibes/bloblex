// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Select } from './Select'

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = null; host = null })

const options = [{ value: '', label: 'No project' }, { value: 'p1', label: 'Bitbots' }]

function mount(onChange = vi.fn(), inDialog = true) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const select = <Select ariaLabel="Project" variant="field" value="" options={options} onChange={onChange} />
  act(() => root!.render(inDialog ? <section role="dialog" aria-modal="true" className="blob-dialog">{select}</section> : select))
  return onChange
}

describe('select inside a dialog', () => {
  it('floats its list above the dialog instead of growing it', () => {
    mount()
    act(() => host!.querySelector<HTMLButtonElement>('.select-trigger')!.click())
    const menu = document.body.querySelector<HTMLElement>('.select-menu')!
    expect(menu).not.toBeNull()
    expect(host!.querySelector('.select-menu')).toBeNull()
    expect(menu.parentElement).toBe(document.body)
    expect(menu.style.position).toBe('fixed')
  })

  it('picks an option, then closes on Escape and on an outside click', () => {
    const onChange = mount()
    const open = () => act(() => host!.querySelector<HTMLButtonElement>('.select-trigger')!.click())
    open()
    act(() => document.body.querySelector<HTMLElement>('.select-option[data-value="p1"]')!.click())
    expect(onChange).toHaveBeenCalledWith('p1')
    expect(document.body.querySelector('.select-menu')).toBeNull()
    open()
    act(() => { document.body.querySelector('.select-menu')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(document.body.querySelector('.select-menu')).toBeNull()
    open()
    act(() => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    expect(document.body.querySelector('.select-menu')).toBeNull()
  })

  it('flips upwards when there is no room below the trigger', () => {
    mount()
    const trigger = host!.querySelector<HTMLButtonElement>('.select-trigger')!
    const rect = { top: 560, bottom: 590, left: 100, right: 300, width: 200, height: 30, x: 100, y: 560, toJSON: () => ({}) }
    trigger.getBoundingClientRect = () => rect as DOMRect
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200)
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200)
    const inner = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
    act(() => trigger.click())
    const menu = document.body.querySelector<HTMLElement>('.select-menu')!
    expect(parseFloat(menu.style.top)).toBe(560 - 4 - 200)
    expect(parseFloat(menu.style.left)).toBe(100)
    height.mockRestore(); width.mockRestore()
    if (inner) Object.defineProperty(window, 'innerHeight', inner)
  })

  it('stays in place outside a dialog', () => {
    mount(vi.fn(), false)
    act(() => host!.querySelector<HTMLButtonElement>('.select-trigger')!.click())
    expect(host!.querySelector('.select-menu')).not.toBeNull()
  })
})
