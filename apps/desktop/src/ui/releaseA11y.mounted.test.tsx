// @vitest-environment happy-dom
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appVersion } from '../appRelease'
import { ConfirmDialog } from './BlobPage'
import { SettingsSheet } from './SettingsSheet'

const rpc = vi.hoisted(() => vi.fn())
const policy = vi.hoisted(() => vi.fn())
vi.mock('../tauri', () => ({
  inDesktop: true,
  rpc,
  permissionsPolicyGet: policy,
  setCompanionVisibility: vi.fn(),
  setCloseToTray: vi.fn(),
  setCompanionMonitor: vi.fn(),
  companionMonitorOptions: async () => [],
  currentCompanionMonitor: async () => null,
}))
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn() }))
vi.mock('../blob/BlobCanvas', () => ({ BlobCanvas: () => null }))

function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  act(() => root.render(node))
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
afterEach(() => { for (const view of views.splice(0)) view.unmount(); rpc.mockReset(); policy.mockReset() })

function focusables(root: ParentNode) {
  return [...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.hasAttribute('aria-hidden'))
}

describe('settings and blob dialog accessibility', () => {
  it('shows a read-only about group and traps focus until Escape restores it', async () => {
    rpc.mockResolvedValue({ settings: { showCompanion: true, closeToTray: true } })
    policy.mockResolvedValue({ defaultMode: 'ask', perAgent: [] })
    function Harness() {
      const [open, setOpen] = useState(false)
      return <>
        <button type="button" onClick={() => setOpen(true)}>Open settings</button>
        {open && <SettingsSheet snapshot={{ agents: [] }} initialPage="General" onClose={() => setOpen(false)} onRefresh={() => undefined} onError={() => undefined} onOpenAgent={() => undefined} />}
      </>
    }
    const view = mount(<Harness />)
    views.push(view)
    const opener = view.host.querySelector('button')
    opener?.focus()
    await act(async () => { opener?.click() })
    await view.settle()
    await view.settle()
    const about = view.host.querySelector('[data-settings-about]')
    expect(about?.textContent).toContain(`Version: ${appVersion}`)
    expect(about?.textContent).toContain('Channel: local build')
    expect(about?.textContent).toContain('Updates: not configured')
    expect(about?.textContent).toContain('Signing: not configured')
    expect(about?.querySelector('button, input, select, textarea')).toBeNull()
    expect(view.host.querySelector('[aria-label="Close settings"] svg')?.getAttribute('aria-hidden')).toBe('true')
    const dialog = view.host.querySelector('.settings-sheet')
    if (!dialog) throw new Error('settings dialog missing')
    const items = focusables(dialog)
    expect(document.activeElement).toBe(items[0])
    expect(items[0]?.getAttribute('aria-label')).toBe('Close settings')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(items[items.length - 1])
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(items[0])
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(view.host.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('returns focus from the blob confirm dialog on Escape', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return <>
        <button type="button" onClick={() => setOpen(true)}>Open discard</button>
        {open && <ConfirmDialog title="Discard unsaved changes?" confirmLabel="Discard" cancelLabel="Keep editing" onConfirm={() => setOpen(false)} onCancel={() => setOpen(false)} />}
      </>
    }
    const view = mount(<Harness />)
    views.push(view)
    const opener = [...view.host.querySelectorAll('button')].find((button) => button.textContent === 'Open discard')
    opener?.focus()
    await act(async () => { opener?.click() })
    await view.settle()
    const dialog = view.host.querySelector('.blob-dialog')
    if (!dialog) throw new Error('blob dialog missing')
    const items = focusables(dialog)
    expect(document.activeElement).toBe(items[0])
    expect(items[0]?.textContent).toBe('Keep editing')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(items[items.length - 1])
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(view.host.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})
