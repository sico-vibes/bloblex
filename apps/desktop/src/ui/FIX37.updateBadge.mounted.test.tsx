// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDLE_UPDATE_PHASE, type UpdatePhaseState } from '../updatesContract'
import { UpdateBadge } from './UpdateBadge'

const h = vi.hoisted(() => ({
  updatesPhase: vi.fn(),
  listenForUpdateState: vi.fn(),
  updatesInstall: vi.fn(),
  updatesCheck: vi.fn(),
}))

vi.mock('../tauri', () => ({
  inDesktop: true,
  previewMode: false,
  updatesPhase: h.updatesPhase,
  listenForUpdateState: h.listenForUpdateState,
  updatesInstall: h.updatesInstall,
  updatesCheck: h.updatesCheck,
}))

function phase(partial: Partial<UpdatePhaseState> = {}): UpdatePhaseState {
  return { ...IDLE_UPDATE_PHASE, ...partial }
}

/** A media query list that never matches, standing in for a wide window. */
function wideWindow() {
  return (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false })
}

/** Only `(max-width: …)` matches, as a narrow window. */
function narrowWindow() {
  return (query: string) => ({ matches: /max-width/.test(query), media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false })
}

function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  act(() => { root.render(node) })
  return {
    host,
    async settle() {
      await act(async () => {
        await Promise.resolve()
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
      })
    },
    unmount() { act(() => root.unmount()); host.remove() },
  }
}

const views: Array<{ unmount: () => void }> = []
afterEach(() => { for (const view of views.splice(0)) view.unmount(); vi.restoreAllMocks() })

beforeEach(() => {
  for (const mock of Object.values(h)) mock.mockReset()
  h.updatesPhase.mockResolvedValue(IDLE_UPDATE_PHASE)
  h.listenForUpdateState.mockResolvedValue(() => undefined)
  h.updatesInstall.mockResolvedValue(undefined)
  h.updatesCheck.mockResolvedValue({ status: 'available', checkedAt: '2026-10-18T10:00:00.000Z' })
  // FIX39 P5 follow-up: the badge goes compact below 1180 px, and happy-dom's
  // default window is 1024 px. These tests describe the wide layout; the
  // compact case stubs its own window.
  vi.stubGlobal('matchMedia', wideWindow())
  history.replaceState({}, '', '/')
})

function badge(host: ParentNode) {
  return host.querySelector('[data-update-badge]')
}

describe('update badge', () => {
  it('renders nothing while idle or checking', async () => {
    const view = mount(<UpdateBadge />)
    views.push(view)
    await view.settle()
    expect(badge(view.host)).toBeNull()

    h.updatesPhase.mockResolvedValue(phase({ phase: 'checking' }))
    const checking = mount(<UpdateBadge />)
    views.push(checking)
    await checking.settle()
    expect(badge(checking.host)).toBeNull()
  })

  it('shows the download label and a progress ring, and is not clickable', async () => {
    h.updatesPhase.mockResolvedValue(phase({ phase: 'downloading', version: '0.1.0-beta.32', downloadedBytes: 42, totalBytes: 100 }))
    const view = mount(<UpdateBadge />)
    views.push(view)
    await view.settle()
    const node = badge(view.host)!
    expect(node.tagName).toBe('SPAN')
    expect(node.textContent).toBe('Downloading update · 42%')
    expect(node.getAttribute('title')).toBe('Bitbots 0.1.0-beta.32')
    expect(node.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
    // Nothing to press while the download runs.
    expect(view.host.querySelector('button')).toBeNull()
  })

  it('uses the raw label when the total size is unknown', async () => {
    h.updatesPhase.mockResolvedValue(phase({ phase: 'downloading', version: '0.1.0-beta.32', downloadedBytes: 512, totalBytes: null }))
    const view = mount(<UpdateBadge />)
    views.push(view)
    await view.settle()
    expect(badge(view.host)?.textContent).toBe('Downloading update')
  })

  it('offers Restart to update when ready and calls the install command', async () => {
    h.updatesPhase.mockResolvedValue(phase({ phase: 'ready', version: '0.1.0-beta.32' }))
    const view = mount(<UpdateBadge />)
    views.push(view)
    await view.settle()
    const button = view.host.querySelector<HTMLButtonElement>('[data-update-badge="ready"]')!
    expect(button.textContent).toBe('Restart to update')
    expect(button.getAttribute('title')).toBe('Bitbots 0.1.0-beta.32')
    await act(async () => { button.click() })
    await view.settle()
    expect(h.updatesInstall).toHaveBeenCalledTimes(1)
  })

  it('shows a quick retry on error and never the raw message', async () => {
    h.updatesPhase.mockResolvedValue(phase({ phase: 'error', version: '0.1.0-beta.32', message: 'SECRET_RAW_STACK' }))
    const view = mount(<UpdateBadge />)
    views.push(view)
    await view.settle()
    const button = view.host.querySelector<HTMLButtonElement>('[data-update-badge="error"]')!
    expect(button.textContent).toBe('Update failed')
    expect(view.host.textContent).not.toContain('SECRET_RAW_STACK')
    await act(async () => { button.click() })
    await view.settle()
    expect(h.updatesCheck).toHaveBeenCalledTimes(1)
  })

  it('follows the pushed phase event after the initial state', async () => {
    let push: (next: UpdatePhaseState) => void = () => undefined
    h.listenForUpdateState.mockImplementation(async (handler: (next: UpdatePhaseState) => void) => { push = handler; return () => undefined })
    const view = mount(<UpdateBadge />)
    views.push(view)
    await view.settle()
    expect(badge(view.host)).toBeNull()
    await act(async () => { push(phase({ phase: 'ready', version: '0.2.0' })) })
    expect(badge(view.host)?.getAttribute('data-update-badge')).toBe('ready')
  })

  it('renders nothing in the companion window', async () => {
    history.replaceState({}, '', '/?companion=1')
    h.updatesPhase.mockResolvedValue(phase({ phase: 'ready', version: '0.1.0-beta.32' }))
    const view = mount(<UpdateBadge />)
    views.push(view)
    await view.settle()
    expect(badge(view.host)).toBeNull()
  })

  // FIX39 P5 follow-up: the Director saw "Restart to update" cover the
  // conversation title at a 1024 px window. The badge goes compact there.
  it('shrinks to an icon and a short label below the compact width', async () => {
    vi.stubGlobal('matchMedia', narrowWindow())
    h.updatesPhase.mockResolvedValue(phase({ phase: 'ready', version: '0.1.0-beta.34' }))
    const view = mount(<UpdateBadge />)
    views.push(view)
    await view.settle()
    const button = view.host.querySelector<HTMLButtonElement>('[data-update-badge="ready"]')!
    expect(button.classList.contains('is-compact')).toBe(true)
    expect(button.textContent).toBe('Restart')
    expect(button.getAttribute('aria-label')).toBe('Restart to update')
    expect(button.getAttribute('title')).toBe('Restart to update — Bitbots 0.1.0-beta.34')
    expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull()

    // A downloading badge keeps the ring and a short label too.
    h.updatesPhase.mockResolvedValue(phase({ phase: 'downloading', version: '0.1.0-beta.34', downloadedBytes: 42, totalBytes: 100 }))
    const downloading = mount(<UpdateBadge />)
    views.push(downloading)
    await downloading.settle()
    const node = badge(downloading.host)!
    expect(node.classList.contains('is-compact')).toBe(true)
    expect(node.textContent).toBe('42%')
    expect(node.getAttribute('aria-label')).toBe('Downloading update · 42%')
    expect(node.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
  })

  it('keeps the full label at a wide window', async () => {
    const view = mount(<UpdateBadge />)
    views.push(view)
    h.updatesPhase.mockResolvedValue(phase({ phase: 'ready', version: '0.1.0-beta.34' }))
    await view.settle()
    expect(badge(view.host)?.textContent).toBe('Restart to update')
  })
})
