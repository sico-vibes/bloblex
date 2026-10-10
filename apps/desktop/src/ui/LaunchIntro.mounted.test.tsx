// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LaunchIntro } from './LaunchIntro'
import type { LaunchCheck } from './launchChecks'

vi.mock('../blob/BlobCanvas', () => ({ BlobCanvas: (props: { size: number }) => <canvas className="blob-canvas" width={props.size} height={props.size} /> }))
let root: Root | null = null
let host: HTMLDivElement | null = null
function mount(checks: LaunchCheck[], serviceDown = false) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const complete = vi.fn(), retry = vi.fn(), offline = vi.fn()
  const render = (nextChecks: LaunchCheck[], nextServiceDown: boolean) => <LaunchIntro checks={nextChecks} runtimes={[]} serviceDown={nextServiceDown} onComplete={complete} onRetry={retry} onContinueOffline={offline} />
  act(() => root!.render(render(checks, serviceDown)))
  return { complete, retry, offline, host, update: (nextChecks: LaunchCheck[], nextServiceDown: boolean) => act(() => root!.render(render(nextChecks, nextServiceDown))) }
}
afterEach(() => { if (root) act(() => root?.unmount()); host?.remove(); root = null; host = null })

describe('LaunchIntro', () => {
  it('shows ordered checks and permits warning states to complete', () => {
    const { host: mounted } = mount([
      { id: 'service', label: 'Connecting to the Bloblex service', state: 'ok', detail: 'Connected' },
      { id: 'agents', label: 'Finding coding agents', state: 'warning', detail: 'No coding agents found' },
    ])
    expect(mounted.querySelectorAll('.launch-checklist li')).toHaveLength(2)
    expect(mounted.textContent).toContain('No coding agents found')
  })

  it('offers retry and continue offline when the service is unavailable', () => {
    const { host: mounted, retry, offline } = mount([{ id: 'service', label: 'Connecting to the Bloblex service', state: 'failed', detail: 'Timed out' }], true)
    act(() => [...mounted.querySelectorAll('button')].find((item) => item.textContent === 'Retry')?.click())
    act(() => [...mounted.querySelectorAll('button')].find((item) => item.textContent === 'Continue offline')?.click())
    expect(retry).toHaveBeenCalledOnce()
    expect(offline).toHaveBeenCalledOnce()
  })

  it('works while scanning, waves when ready, completes after the wave, and cancels when going offline', async () => {
    vi.useFakeTimers()
    const { host: mounted, complete, update } = mount([{ id: 'service', label: 'Connecting', state: 'running', detail: 'Checking' }])
    const canvas = mounted.querySelector<HTMLCanvasElement>('.launch-blob-stage canvas.blob-canvas')
    expect(canvas?.width).toBe(canvas?.height)
    expect(mounted.querySelector('.launch-checklist-window .launch-checklist')).not.toBeNull()
    update([{ id: 'service', label: 'Connecting', state: 'ok', detail: 'Connected' }], false)
    expect(mounted.querySelector('.launch-intro')?.getAttribute('data-phase')).toBe('greeting')
    expect(mounted.querySelector('.launch-greeting')).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(complete).toHaveBeenCalledOnce()

    const second = mount([{ id: 'service', label: 'Connecting', state: 'ok', detail: 'Connected' }])
    second.update([{ id: 'service', label: 'Connecting', state: 'failed', detail: 'Unavailable' }], true)
    expect(second.host.querySelector('.launch-greeting')).toBeNull()
    act(() => [...second.host.querySelectorAll('button')].find((item) => item.textContent === 'Continue offline')?.click())
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(second.offline).toHaveBeenCalledOnce()
    expect(second.complete).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})
