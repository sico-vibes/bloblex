// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../tauri', () => ({ rpc: vi.fn(async () => ({})) }))

import { rpc } from '../tauri'
import { DensityControl } from './DensityControl'
import { hydrateDensity } from './uiPrefs'

const save = vi.mocked(rpc)
const mounted: Array<{ root: Root; host: HTMLDivElement }> = []
function mount() {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(<DensityControl />))
  mounted.push({ root, host })
  return host
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  save.mockClear()
  hydrateDensity('default')
  localStorage.clear()
})

afterEach(() => { for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() } })

describe('DensityControl', () => {
  it('offers the three densities and marks the current one', () => {
    const host = mount()
    const radios = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(radios.map((radio) => radio.textContent)).toEqual(['Compact', 'Default', 'Roomy'])
    expect(radios.filter((radio) => radio.getAttribute('aria-checked') === 'true').map((radio) => radio.textContent)).toEqual(['Default'])
    expect(host.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Density')
  })

  it('writes the choice to uiPrefs, the document and the daemon', async () => {
    const host = mount()
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((radio) => radio.textContent === 'Roomy')!.click() })
    expect(document.documentElement.dataset.density).toBe('roomy')
    expect(save).toHaveBeenCalledWith('settings.set', { key: 'appearance.density', value: 'roomy' })
    const checked = host.querySelectorAll('[role="radio"][aria-checked="true"]')
    expect(checked).toHaveLength(1)
    expect(checked[0].textContent).toBe('Roomy')
  })
})
