// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '../types'
import { ComposerExecutionSwitch } from './ComposerExecutionSwitch'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../tauri', () => ({ rpc }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); rpc.mockReset() })

const agent: Agent = { id: 'a', name: 'Blob', description: '', instructions: '', color: 'mint', runtimeId: 'rt', model: 'alpha', thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: '', updatedAt: '' }
const catalog = { runtimeId: 'rt', provider: 'runtime', models: [
  { id: 'alpha', displayName: 'Alpha', supportedThinking: ['low', 'high'], defaultThinking: 'high', serviceTiers: [{ id: 'priority', name: 'Priority' }], defaultServiceTier: 'priority', isDefault: true, group: 'Group A' },
  { id: 'beta', displayName: 'Beta', supportedThinking: ['medium'], defaultThinking: 'medium', serviceTiers: [{ id: 'flex', name: 'Flex' }], defaultServiceTier: 'flex', isDefault: false, group: 'Group B' },
] }
const capabilities = (enabled: boolean) => ({ runtimeId: 'rt', settings: {
  model: { supported: true, enabled, scope: 'turn', evidence: 'provider_echo' },
  thinking: { supported: true, enabled, scope: 'turn', evidence: 'provider_echo' },
  serviceTier: { supported: true, enabled, scope: 'turn', evidence: 'provider_echo' },
} })

describe('composer model and thinking switch', () => {
  it('hides gated runtime controls', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    rpc.mockImplementation(async (method: string) => method === 'runtime.models' ? catalog : capabilities(false))
    await act(async () => root.render(<ComposerExecutionSwitch agent={agent} onAgentUpdated={vi.fn()} onError={vi.fn()} />))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(host.querySelector('.composer-execution-pill')).toBeNull()
  })

  it('sends the selected model with compatible open-gate options and follows its thinking list', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    rpc.mockImplementation(async (method: string) => method === 'runtime.models' ? catalog : method === 'runtime.capabilities' ? capabilities(true) : { agent: { ...agent, model: 'beta' } })
    const onAgentUpdated = vi.fn()
    const onError = vi.fn()
    await act(async () => root.render(<ComposerExecutionSwitch agent={agent} onAgentUpdated={onAgentUpdated} onError={onError} />))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    act(() => host.querySelector<HTMLButtonElement>('button.composer-execution-pill')!.click())
    const beta = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((item) => item.textContent?.includes('Beta'))!
    act(() => beta.click())
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(rpc).toHaveBeenCalledWith('agent.update', { agentId: 'a', model: 'beta', thinking: 'medium', serviceTier: 'flex' })
    expect(onAgentUpdated).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()

    const nextAgent = { ...agent, model: 'beta' }
    await act(async () => root.render(<ComposerExecutionSwitch agent={nextAgent} onAgentUpdated={onAgentUpdated} onError={onError} />))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    act(() => host.querySelector<HTMLButtonElement>('button.composer-execution-pill')!.click())
    const labels = [...host.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent)
    expect(labels).toContain('medium')
    expect(labels).not.toContain('high')
    act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((item) => item.textContent === 'medium')!.click())
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(rpc).toHaveBeenCalledWith('agent.update', { agentId: 'a', thinking: 'medium' })
  })

  it('omits dependent fields when their capability gates are closed', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    rpc.mockImplementation(async (method: string) => {
      if (method === 'runtime.models') return catalog
      if (method === 'runtime.capabilities') return { ...capabilities(true), settings: {
        ...capabilities(true).settings,
        thinking: { supported: true, enabled: false, scope: 'turn', evidence: 'none' },
        serviceTier: { supported: false, enabled: false, scope: 'turn', evidence: 'none' },
      } }
      return { agent: { ...agent, model: 'beta' } }
    })
    await act(async () => root.render(<ComposerExecutionSwitch agent={agent} onAgentUpdated={vi.fn()} onError={vi.fn()} />))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    act(() => host.querySelector<HTMLButtonElement>('.composer-execution-pill')!.click())
    act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((item) => item.textContent?.includes('Beta'))!.click())
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(rpc).toHaveBeenCalledWith('agent.update', { agentId: 'a', model: 'beta' })
  })

  it('moves focus into the menu, restores it on Escape, and closes on an outside pointer press', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    rpc.mockImplementation(async (method: string) => method === 'runtime.models' ? catalog : capabilities(true))
    await act(async () => root.render(<ComposerExecutionSwitch agent={agent} onAgentUpdated={vi.fn()} onError={vi.fn()} />))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const trigger = host.querySelector<HTMLButtonElement>('.composer-execution-pill')!
    act(() => trigger.click())
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)) })
    const firstItem = host.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!
    expect(document.activeElement).toBe(firstItem)
    act(() => firstItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)) })
    expect(host.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    act(() => trigger.click())
    const outside = document.createElement('button')
    document.body.append(outside)
    act(() => outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(host.querySelector('[role="menu"]')).toBeNull()
    outside.remove()
  })
})
