// @vitest-environment happy-dom
import { chooseOption, selectOptions, selectTrigger, selectValue } from './testSelect'
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Runtime, Snapshot } from '../types'
import type { AgentDraft } from './agentForm'
import { BlobSettings } from './BlobSettings'
import { ApprovalBadge, ApprovalPill, AutoApprovedList } from './approvalUi'
import { SettingsSheet } from './SettingsSheet'

const rpc = vi.hoisted(() => vi.fn())
const policy = vi.hoisted(() => vi.fn())
const autostart = vi.hoisted(() => ({ enabled: false }))
vi.mock('../desktopIntegrations', () => ({
  autostartEnabled: async () => autostart.enabled,
  setAutostartEnabled: async (enabled: boolean) => { autostart.enabled = enabled },
  sendDesktopNotification: async () => undefined,
  flashMainWindow: async () => undefined,
}))
vi.mock('../tauri', () => ({
  inDesktop: true,
  rpc,
  permissionsPolicyGet: policy,
  setCompanionVisibility: vi.fn(),
  setCloseToTray: vi.fn(),
  setCompanionMonitor: vi.fn(),
  companionMonitorOptions: async () => [],
  currentCompanionMonitor: async () => null,
  updatesGetState: async () => ({ currentVersion: '0.1.0', channel: 'beta' as const, autoCheck: true, lastCheckedAt: null, available: null, devBuild: false }),
  updatesSetPreferences: async () => ({ currentVersion: '0.1.0', channel: 'beta' as const, autoCheck: true, lastCheckedAt: null, available: null, devBuild: false }),
  updatesCheck: async () => ({ status: 'up_to_date' as const, checkedAt: '2026-10-02T00:00:00.000Z' }),
  updatesInstall: async () => undefined,
  listenForUpdateAvailable: async () => () => undefined,
  listenForUpdateProgress: async () => () => undefined,
}))
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn(async () => () => undefined) }))

function draft(partial: Partial<AgentDraft> = {}): AgentDraft {
  return { name: 'Claude', description: '', instructions: '', color: 'mint', outfit: 'auto', runtimeId: 'rt-1', defaultProject: null, model: null, thinking: null, serviceTier: null, approvalMode: null, ...partial }
}

function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  act(() => root.render(node))
  return {
    host,
    async settle() { await act(async () => { await Promise.resolve(); await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))) }) },
    unmount() { act(() => root.unmount()); host.remove() },
  }
}

const views: Array<{ unmount: () => void }> = []
afterEach(() => { for (const view of views.splice(0)) view.unmount(); rpc.mockReset(); policy.mockReset() })

function PermissionsHarness() {
  const [value, setValue] = useState(draft())
  return <BlobSettings draft={value} runtimes={[{ id: 'rt-1', provider: 'claude', status: 'online' }]} errors={{}} execution={{ model: null, thinking: null, serviceTier: null, maxConcurrency: 1 }} onDraftChange={setValue} />
}

describe('approval mode UI', () => {
  it('requires the exact blob name before bypass and cancels on Escape', async () => {
    rpc.mockResolvedValue({})
    const view = mount(<PermissionsHarness />)
    views.push(view)
    await view.settle()
    const select = selectTrigger(view.host, 'Approval mode')!
    await chooseOption(view.host, 'Approval mode', 'bypass')
    await view.settle()
    const dialog = view.host.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('approves every action without asking')
    const confirm = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Turn on bypass') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    const input = dialog.querySelector('input') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'claude')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(confirm.disabled).toBe(true)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Claude')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(confirm.disabled).toBe(false)
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(view.host.querySelector('#bypass-dialog-title')).toBeNull()
    expect(selectValue(view.host, 'Approval mode')).toBe('')
    expect(document.activeElement).toBe(select)
  })

  it('shows shield badges only for auto and bypass', () => {
    const view = mount(<div><ApprovalBadge mode="ask" /><ApprovalBadge mode="auto" /><ApprovalBadge mode="bypass" /><ApprovalPill mode="ask" /><ApprovalPill mode="bypass" /></div>)
    views.push(view)
    expect(view.host.querySelectorAll('.approval-badge')).toHaveLength(2)
    expect(view.host.querySelector('.approval-badge-auto')?.getAttribute('aria-label')).toBe('Auto-approve')
    expect(view.host.querySelector('.approval-badge-bypass')?.getAttribute('aria-label')).toBe('Bypass approvals')
    expect(view.host.querySelector('.approval-pill-bypass')?.textContent).toBe('Bypass')
    expect(view.host.querySelector('.approval-pill-ask')).toBeNull()
  })

  it('lists auto-approved actions newest first', () => {
    const view = mount(<AutoApprovedList actions={[
      { summary: 'Read file', category: 'READ', mode: 'auto', sequence: 1 },
      { summary: 'Edit file', category: 'EDIT', mode: 'bypass', sequence: 4 },
    ]} />)
    views.push(view)
    const items = [...view.host.querySelectorAll('.auto-approved-list li')].map((item) => item.textContent ?? '')
    expect(items[0]).toContain('Edit file')
    expect(items[0]).toContain('EDIT')
    expect(items[0]).toContain('Bypass')
    expect(items[1]).toContain('Read file')
    expect(items[1]).toContain('Auto')
    const empty = mount(<AutoApprovedList actions={[]} />)
    views.push(empty)
    expect(empty.host.textContent).toContain('No actions have been auto-approved.')
  })
})

const agent = (partial: Partial<Agent>): Agent => ({
  id: 'agent-1', name: 'Claude', description: '', instructions: '', color: 'mint', runtimeId: 'rt-1', model: null, thinking: null, serviceTier: null,
  customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: '', updatedAt: '', ...partial,
})

describe('settings modal', () => {
  it('navigates settings and changes the real start-with-Windows state', async () => {
    autostart.enabled = false
    rpc.mockImplementation(async (method: string) => method === 'settings.get' ? { settings: { showCompanion: true, closeToTray: true, 'companion.soundsEnabled': false } } : {})
    policy.mockResolvedValue({ defaultMode: 'ask', perAgent: [{ agentId: 'agent-2', mode: 'bypass', effectiveMode: 'bypass' }] })
    const snapshot: Snapshot = {
      agents: [agent({ id: 'agent-1', name: 'Claude' }), agent({ id: 'agent-2', name: 'Risky', effectiveApprovalMode: 'bypass' })],
      runtimes: [{ id: 'rt-1', provider: 'codex', status: 'online', authState: 'authenticated', version: '0.159.3', executablePath: 'C:\\Tools\\codex.exe' } satisfies Runtime],
    }
    const opened: string[] = []
    const view = mount(<SettingsSheet snapshot={snapshot} initialPage="General" onClose={() => undefined} onRefresh={() => undefined} onError={() => undefined} onOpenAgent={(id) => opened.push(id)} />)
    views.push(view)
    await view.settle()
    const page = async (name: string) => { await act(async () => { [...view.host.querySelectorAll<HTMLButtonElement>('.settings-nav button')].find((button) => button.textContent === name)?.click() }) }
    const nav = [...view.host.querySelectorAll('.settings-nav button')].map((button) => button.textContent)
    expect(nav).toEqual(['General', 'Agents', 'Updates'])
    expect(view.host.textContent).not.toMatch(/Add budget|pricing|subscription/i)
    const start = view.host.querySelector<HTMLButtonElement>('[aria-label="Start with Windows"]')!
    expect(start.disabled).toBe(false)
    expect(start.getAttribute('aria-checked')).toBe('false')
    await act(async () => { start.click() })
    await view.settle()
    expect(start.getAttribute('aria-checked')).toBe('true')
    expect(view.host.textContent).not.toContain('Not available yet')
    const notifications = view.host.querySelector<HTMLButtonElement>('[aria-label="Notify when a blob finishes or needs approval"]')!
    expect(notifications.getAttribute('aria-checked')).toBe('true')
    await act(async () => { notifications.click() })
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('settings.set', { key: 'notifications.enabled', value: false })
    expect(notifications.getAttribute('aria-checked')).toBe('false')
    expect(view.host.querySelector('[aria-label="Companion sounds"]')).not.toBeNull()

    await page('Updates')
    expect(view.host.querySelector('[data-settings-section="updates"]')).not.toBeNull()
    const about = view.host.querySelector('[data-settings-about]')
    expect(about?.textContent).toContain('Code signing')
    expect(about?.textContent).toContain('Not configured')
    expect(about?.querySelector('button, input, select, textarea')).toBeNull()

    await page('Agents')
    expect((await selectOptions(view.host, 'Default approval mode')).map((option) => option.value)).toEqual(['ask', 'auto'])
    await chooseOption(view.host, 'Default approval mode', 'auto')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('settings.set', { key: 'permissions.default_mode', value: 'auto' })
    expect(rpc.mock.calls.some((call) => call[1]?.value === 'bypass')).toBe(false)
    expect(view.host.textContent).toContain('Bypass can only be turned on for a single blob')
    const runtimeHead = view.host.querySelector<HTMLButtonElement>('.runtime-entry-head')!
    expect(runtimeHead.getAttribute('aria-expanded')).toBe('false')
    expect(runtimeHead.textContent).toContain('Codex')
    expect(runtimeHead.textContent).toContain('Signed in')
    expect(runtimeHead.textContent).toContain('2 blobs')
    await act(async () => { runtimeHead.click() })
    expect(view.host.querySelector('.settings-facts')?.textContent).toContain('C:\\Tools\\codex.exe')
    expect(view.host.textContent).toContain('Bypass approvals')
    expect(view.host.textContent).not.toMatch(/token|credential|secret/i)
    await act(async () => { view.host.querySelector<HTMLButtonElement>('[aria-label="Open Risky"]')?.click() })
    expect(opened).toEqual(['agent-2'])
    await act(async () => { view.host.querySelector<HTMLButtonElement>('[aria-label="Open Claude"]')?.click() })
    expect(opened).toEqual(['agent-2', 'agent-1'])
  })

  it('disables the global default when the policy cannot be loaded', async () => {
    rpc.mockResolvedValue({ settings: {} })
    policy.mockRejectedValue(new Error('unsupported: not ready'))
    const view = mount(<SettingsSheet snapshot={{ agents: [] }} initialPage="Agents" onClose={() => undefined} onRefresh={() => undefined} onError={() => undefined} onOpenAgent={() => undefined} />)
    views.push(view)
    await view.settle()
    expect(selectTrigger(view.host, 'Default approval mode')?.disabled).toBe(true)
    expect(view.host.textContent).toContain('Unavailable')
    expect(rpc).not.toHaveBeenCalledWith('settings.set', expect.anything())
  })
})
