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

const { OutsideSessionPills, OutsideWatchSetting, normalizeOutsideSessions, outsideLabel } = await import('./OutsideSessions')

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

// Wave 13: Claude Code sessions started outside Bitbots.
describe('outside sessions', () => {
  it('says what a session is doing without guessing', () => {
    const session = (state: string, tool: string | null = null) => normalizeOutsideSessions([{ id: 'x', state, tool, folder: 'site' }])[0]!
    expect(outsideLabel(session('working', 'Bash'))).toBe('Running a command')
    expect(outsideLabel(session('working', 'Edit'))).toBe('Editing files')
    expect(outsideLabel(session('working', 'mcp__thing'))).toBe('Working')
    expect(outsideLabel(session('waiting'))).toBe('Needs you in the terminal')
    expect(outsideLabel(session('done'))).toBe('Done')
    expect(normalizeOutsideSessions([{ id: 'x', state: 'exploded' }, null, 'no'])).toEqual([])
  })

  it('shows one pill per session and nothing without sessions', async () => {
    const view = await mount(<OutsideSessionPills sessions={normalizeOutsideSessions([{ id: 'a', state: 'working', tool: 'Bash', folder: 'invoice-api' }, { id: 'b', state: 'waiting', folder: 'site' }])} />)
    expect([...view.querySelectorAll('.outside-pill')].map((pill) => pill.textContent)).toEqual(['invoice-apiRunning a command', 'siteNeeds you in the terminal'])
    act(() => root!.render(<OutsideSessionPills sessions={[]} />))
    expect(view.querySelector('.outside-sessions')).toBeNull()
  })

  it('changes nothing until the owner confirms the previewed file', async () => {
    const off = { enabled: false, installed: false, settingsPath: 'C:/Users/me/.claude/settings.json', bridgeAvailable: true, problem: null }
    rpc.mockImplementation(async (method: string) => {
      if (method === 'outside.status') return off
      if (method === 'outside.preview') return { settingsPath: off.settingsPath, exists: true, before: '{}', after: '{"hooks":{}}' }
      if (method === 'outside.enable') return { status: { ...off, enabled: true, installed: true }, backupPath: 'C:/Users/me/.claude/settings.json.bitbots-backup-1' }
      throw new Error(`unexpected ${method}`)
    })
    const view = await mount(<OutsideWatchSetting connected />)
    const toggle = view.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await act(async () => { toggle.click() }); await settle()
    expect(rpc).not.toHaveBeenCalledWith('outside.enable', expect.anything())
    const dialog = document.querySelector('.outside-consent')!
    expect(dialog.textContent).toContain('C:/Users/me/.claude/settings.json')
    expect(dialog.querySelector('pre')?.textContent).toBe('{"hooks":{}}')
    await act(async () => { [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Turn on')!.click() }); await settle()
    expect(rpc).toHaveBeenCalledWith('outside.enable', { confirm: true })
    expect(view.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
    expect(view.textContent).toContain('settings.json.bitbots-backup-1')
  })

  it('is unavailable without the hook bridge', async () => {
    rpc.mockResolvedValue({ enabled: false, installed: false, settingsPath: null, bridgeAvailable: false, problem: null })
    const view = await mount(<OutsideWatchSetting connected />)
    expect(view.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true)
    expect(view.textContent).toContain('hook bridge is not installed')
  })
})
