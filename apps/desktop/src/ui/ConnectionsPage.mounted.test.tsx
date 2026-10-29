// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const rpc = vi.fn()
vi.mock('../tauri', () => ({
  rpc: (method: string, params: unknown) => rpc(method, params),
  listenForDaemonEvents: async () => () => undefined,
}))

const { ConnectionsPage, normalizeExternalStatus, usedAgo } = await import('./ConnectionsPage')
const { clientLabel, outsideSender } = await import('./messageOrigin')

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { if (root) act(() => root!.unmount()); root = null; host?.remove(); host = null; rpc.mockReset() })

async function mount(node: ReactNode) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(node) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  return host
}
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

const off = { enabled: false, tier: 'chat', endpointPath: null, bridgePath: 'C:/Data/bitbots-mcp.exe', command: 'claude mcp add bitbots -- "C:/Data/bitbots-mcp.exe" mcp-server --endpoint "C:/Data/external-mcp.json"', lastCallAt: null, lastClient: null }

// Wave 14: Settings › Connections, the Bitbots MCP.
describe('Bitbots MCP settings', () => {
  it('reads only a well-formed status and names the client plainly', () => {
    expect(normalizeExternalStatus({ ...off, tier: 'root' })?.tier).toBe('chat')
    expect(normalizeExternalStatus({ tier: 'chat' })).toBeNull()
    expect(normalizeExternalStatus(null)).toBeNull()
    expect(clientLabel('claude-code')).toBe('Claude Code')
    expect(clientLabel('cursor')).toBe('cursor')
    expect(clientLabel(null)).toBe('an MCP client')
    const now = Date.parse('2026-10-29T12:00:00Z')
    expect(usedAgo('2026-10-29T11:59:40Z', now)).toBe('just now')
    expect(usedAgo('2026-10-29T11:55:00Z', now)).toBe('5 min ago')
    expect(usedAgo('2026-10-29T09:00:00Z', now)).toBe('3 h ago')
    expect(usedAgo('not a date', now)).toBeNull()
  })

  it('marks a message sent through the MCP, at the top level or in meta', () => {
    expect(outsideSender({ role: 'user', origin: { kind: 'mcp', client: 'claude-code' } })).toBe('Claude Code')
    expect(outsideSender({ role: 'user', meta: { origin: { kind: 'mcp', client: 'MCP' } } })).toBe('an MCP client')
    expect(outsideSender({ role: 'user', meta: { origin: { kind: 'remote' } } })).toBeNull()
    expect(outsideSender({ role: 'user' })).toBeNull()
  })

  it('turns on only after the owner picks a level in the dialog, then shows the connect command', async () => {
    rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'external.status') return off
      if (method === 'external.enable') return { ...off, enabled: true, tier: params.tier, endpointPath: 'C:/Data/external-mcp.json' }
      throw new Error(`unexpected ${method}`)
    })
    const view = await mount(<ConnectionsPage connected />)
    const toggle = view.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(view.textContent).not.toContain('claude mcp add')
    await act(async () => { toggle.click() }); await settle()
    expect(rpc).not.toHaveBeenCalledWith('external.enable', expect.anything())
    const dialog = document.querySelector('.connect-consent')!
    expect(dialog.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain('Chat')
    const operator = [...dialog.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((choice) => choice.textContent?.includes('Operator'))!
    await act(async () => { operator.click() })
    await act(async () => { dialog.querySelector<HTMLButtonElement>('.primary-button')!.click() }); await settle()
    expect(rpc).toHaveBeenCalledWith('external.enable', { tier: 'operator', confirm: true })
    expect(document.querySelector('.connect-consent')).toBeNull()
    expect(view.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
    expect(view.querySelector('.connect-command code')?.textContent).toBe(off.command)
    expect(view.textContent).toContain('Not used yet')
  })

  it('changes the level, resets access and turns off, accepting a wrapped status', async () => {
    const on = { ...off, enabled: true, lastCallAt: new Date().toISOString(), lastClient: 'claude-code' }
    rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'external.status') return on
      if (method === 'external.setTier') return { status: { ...on, tier: params.tier } }
      if (method === 'external.rotate') return on
      if (method === 'external.disable') return { ...off }
      throw new Error(`unexpected ${method}`)
    })
    const view = await mount(<ConnectionsPage connected />)
    expect(view.textContent).toContain('just now, by Claude Code')
    const view1 = [...view.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((choice) => choice.textContent?.includes('View'))!
    await act(async () => { view1.click() }); await settle()
    expect(rpc).toHaveBeenCalledWith('external.setTier', { tier: 'viewer' })
    expect(view.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain('View')
    const reset = [...view.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Reset access')!
    await act(async () => { reset.click() }); await settle()
    expect(rpc).toHaveBeenCalledWith('external.rotate', {})
    expect(view.textContent).toContain('Access reset')
    await act(async () => { view.querySelector<HTMLButtonElement>('[role="switch"]')!.click() }); await settle()
    expect(rpc).toHaveBeenCalledWith('external.disable', {})
    expect(view.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
    expect(view.querySelector('.connect-command')).toBeNull()
  })

  it('shows a plain problem when the daemon refuses', async () => {
    rpc.mockImplementation(async (method: string) => {
      if (method === 'external.status') return off
      if (method === 'external.enable') throw new Error('The Bitbots MCP could not be turned on.')
      throw new Error(`unexpected ${method}`)
    })
    const view = await mount(<ConnectionsPage connected />)
    await act(async () => { view.querySelector<HTMLButtonElement>('[role="switch"]')!.click() }); await settle()
    await act(async () => { document.querySelector<HTMLButtonElement>('.connect-consent .primary-button')!.click() }); await settle()
    expect(view.querySelector('[role="alert"]')?.textContent).toBe('The Bitbots MCP could not be turned on.')
    expect(document.querySelector('.connect-consent')).not.toBeNull()
  })
})
