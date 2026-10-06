// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './BlobPage'

const mounted: Array<{ root: Root; host: HTMLDivElement }> = []
function mount(onConfirm: () => void, onCancel = vi.fn()) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(<ConfirmDialog title="Delete conversation?" body="The transcript in Bloblex will be removed." confirmLabel="Delete" cancelLabel="Cancel" holdToConfirm onConfirm={onConfirm} onCancel={onCancel} />))
  mounted.push({ root, host })
  return host
}

afterEach(() => { for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() } vi.useRealTimers(); vi.unstubAllGlobals() })

describe('destructive hold confirmation', () => {
  it('cancels on release and confirms only after a keyboard hold, including reduced motion', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches:true, media:'(prefers-reduced-motion: reduce)', addEventListener:vi.fn(), removeEventListener:vi.fn() })))
    const confirm = vi.fn()
    const host = mount(confirm)
    const button = host.querySelector<HTMLButtonElement>('.hold-confirm-button')!
    expect(button.getAttribute('aria-describedby')).toBe('hold-confirm-hint')
    expect(host.textContent).toContain('Release or press Escape to cancel')
    await act(async () => { button.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true })); await vi.advanceTimersByTimeAsync(400); button.dispatchEvent(new KeyboardEvent('keyup', { key:'Enter', bubbles:true })); await vi.advanceTimersByTimeAsync(500) })
    expect(confirm).not.toHaveBeenCalled()
    await act(async () => { button.dispatchEvent(new KeyboardEvent('keydown', { key:' ', bubbles:true })); await vi.advanceTimersByTimeAsync(850) })
    expect(confirm).toHaveBeenCalledOnce()
  })
})
