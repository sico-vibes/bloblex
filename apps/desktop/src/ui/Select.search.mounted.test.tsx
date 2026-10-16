// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Select } from './Select'

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = null; host = null })

const options = Array.from({ length: 12 }, (_, index) => ({ value: `model-${index}`, label: `Model ${index}`, group: index === 0 ? 'Zen' : index === 6 ? 'Go' : undefined }))

function mount(onChange = vi.fn()) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(<Select ariaLabel="Model" value="" placeholder="Choose a model" searchable={8} searchPlaceholder="Search models" options={options} onChange={onChange} />))
  return onChange
}

function type(value: string) {
  const input = host!.querySelector<HTMLInputElement>('.select-search input')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return input
}

describe('searchable select', () => {
  it('filters a long list, keeps group headings and picks the first match with Enter', () => {
    const onChange = mount()
    act(() => host!.querySelector<HTMLButtonElement>('.select-trigger')!.click())
    expect(host!.querySelector('.select-search input')).not.toBeNull()
    expect(host!.querySelectorAll('.select-option')).toHaveLength(12)
    const input = type('11')
    expect([...host!.querySelectorAll('.select-option')].map((node) => node.textContent)).toEqual(['Model 11'])
    expect([...host!.querySelectorAll('.select-group-label')].map((node) => node.textContent)).toEqual(['Go'])
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onChange).toHaveBeenCalledWith('model-11')
  })

  it('says when nothing matches', () => {
    mount()
    act(() => host!.querySelector<HTMLButtonElement>('.select-trigger')!.click())
    type('nothing like this')
    expect(host!.querySelector('.select-empty')?.textContent).toBe('No matches')
  })
})
