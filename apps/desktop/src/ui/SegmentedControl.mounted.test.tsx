// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SegmentedControl } from './SegmentedControl'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement | null = null
let root: Root | null = null
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = null; host = null })

describe('segmented appearance controls', () => {
  it('exposes a selected radio and moves selection with arrow keys', () => {
    const onChange = vi.fn()
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    act(() => root!.render(<SegmentedControl label="Glass" value="balanced" options={[{ value: 'solid', label: 'Solid' }, { value: 'balanced', label: 'Balanced' }, { value: 'clear', label: 'Clear' }]} onChange={onChange} />))
    const radios = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(host.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Glass')
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    act(() => { radios[1]!.focus(); radios[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(onChange).toHaveBeenCalledWith('clear')
    expect(document.activeElement).toBe(radios[2])
  })
})
