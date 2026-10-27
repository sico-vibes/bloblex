// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LaunchIntro, LaunchWarnings } from './LaunchIntro'
import { setThemeStyle } from '../blob/bitbots'
import type { LaunchCheck } from './launchChecks'
import type { BlobCanvasProps } from '../blob/BlobCanvas'
import type { Agent } from '../types'

const canvasMock = vi.hoisted(() => ({ latest: null as null | Record<string, unknown> }))
vi.mock('../blob/BlobCanvas', () => ({ BlobCanvas: (props: BlobCanvasProps) => {
  canvasMock.latest = props as unknown as Record<string, unknown>
  return <canvas className="blob-canvas" data-greeting={props.greeting ? 'true' : undefined} data-look-art={props.look?.art ?? undefined} width={props.size} height={props.size} />
} }))
let root: Root | null = null
let host: HTMLDivElement | null = null
function mount(checks: LaunchCheck[], serviceDown = false, agent: Agent | null = null) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const complete = vi.fn(), retry = vi.fn(), offline = vi.fn()
  const render = (nextChecks: LaunchCheck[], nextServiceDown: boolean) => <LaunchIntro checks={nextChecks} runtimes={[]} serviceDown={nextServiceDown} agent={agent} onComplete={complete} onRetry={retry} onContinueOffline={offline} />
  act(() => root!.render(render(checks, serviceDown)))
  return { complete, retry, offline, host, update: (nextChecks: LaunchCheck[], nextServiceDown: boolean) => act(() => root!.render(render(nextChecks, nextServiceDown))) }
}
afterEach(() => { if (root) act(() => root?.unmount()); host?.remove(); root = null; host = null })
// These cases exercise the classic launch greeting; Blobots is the style under test.
beforeEach(() => { setThemeStyle('blobots') })

describe('LaunchIntro', () => {
  it('does not use the retired pixel welcome in either supported look', () => {
    setThemeStyle('blobots')
    const { host: mounted } = mount([{ id: 'service', label: 'Connecting', state: 'running', detail: 'Checking' }])
    expect(mounted.querySelector('.launch-pixel-scan')).toBeNull()
    act(() => setThemeStyle('haze'))
    expect(mounted.querySelector('.launch-pixel-scan')).toBeNull()
  })
  it('shows ordered checks and permits warning states to complete', () => {
    const { host: mounted } = mount([
      { id: 'service', label: 'Connecting to the Bitbots service', state: 'ok', detail: 'Connected' },
      { id: 'agents', label: 'Finding coding agents', state: 'warning', detail: 'No coding agents found' },
    ])
    expect(mounted.querySelectorAll('.launch-checklist li')).toHaveLength(2)
    expect(mounted.textContent).toContain('No coding agents found')
  })

  // Both looks default to Glossy (the wave greeting); a bot with its own art greets with that art.
  it('uses the bot art for its greeting and completes through the canvas callback', () => {
    setThemeStyle('blobots')
    const agent = { id: 'agent-a', name: 'Ada', runtimeId: 'rt', color: 'violet', look: { shape: 'circle', art: 'painted' } } as unknown as Agent
    const { host: mounted, complete } = mount([{ id: 'service', label: 'Connecting', state: 'ok', detail: 'Connected' }], false, agent)
    const canvas = mounted.querySelector<HTMLCanvasElement>('.launch-blob-stage canvas.blob-canvas')
    expect(canvas?.dataset.greeting).toBe('true')
    expect(canvasMock.latest?.greeting).toBe(true)
    expect((canvasMock.latest?.look as { art?: string } | null)?.art).toBe('painted')
    act(() => (canvasMock.latest?.onGreetingComplete as (() => void) | undefined)?.())
    expect(complete).toHaveBeenCalledOnce()
  })

  it('offers retry and continue offline when the service is unavailable', () => {
    const { host: mounted, retry, offline } = mount([{ id: 'service', label: 'Connecting to the Bitbots service', state: 'failed', detail: 'Timed out' }], true)
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


describe('startup warning context', () => {
  it('names the failed step and keeps local transport addresses out of the notice', () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    act(() => root!.render(<LaunchWarnings warnings={['Connection failed']} details="Loading usage and limits: Daemon request failed: error sending request for url (http://127.0.0.1:12345/v1/rpc)" onSettings={vi.fn()} onDismiss={vi.fn()} />))
    expect(host.textContent).toContain('Loading usage and limits: The local service connection was interrupted.')
    expect(host.querySelector('[role="status"]')?.getAttribute('title')).not.toContain('127.0.0.1')
    expect(host.textContent).not.toContain('/v1/rpc')
  })
})
