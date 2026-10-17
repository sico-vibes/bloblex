// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rpc: vi.fn(), runtimeTerminal: vi.fn() }))
vi.mock('../tauri', () => ({ rpc: h.rpc, runtimeTerminal: h.runtimeTerminal }))
import { needsSignIn, SignInHelp } from './SignInHelp'
import { runtimeAuthSummary } from './launchChecks'
import { runtimeProblem } from './RuntimeProblemMarker'

let root: Root | null = null
let host: HTMLDivElement | null = null
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const button = (label: string) => [...host!.querySelectorAll('button')].find((item) => item.textContent?.includes(label)) as HTMLButtonElement | undefined

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  h.rpc.mockReset(); h.rpc.mockResolvedValue({})
  h.runtimeTerminal.mockReset(); h.runtimeTerminal.mockResolvedValue({ launched: true, terminal: 'wt' })
})
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = null; host = null })

async function mount(node: React.ReactNode) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(node) })
}

describe('sign-in help', () => {
  it('opens the provider sign-in, then clears the flag when the user says they are done', async () => {
    const onChecked = vi.fn()
    await mount(<SignInHelp provider="claude" runtimeId="rt-claude" onChecked={onChecked} />)
    expect(host!.textContent).toContain('Type /login there')
    await act(async () => { button('Sign in to Claude Code')!.click() })
    await flush()
    expect(h.runtimeTerminal).toHaveBeenCalledWith('claude', 'login')
    await act(async () => { button('I’ve signed in')!.click() })
    await flush()
    expect(h.rpc).toHaveBeenCalledWith('runtime.auth.clear', { runtimeId: 'rt-claude' })
    expect(onChecked).toHaveBeenCalled()
  })

  it('installs a missing coding agent and shows a launch failure', async () => {
    h.runtimeTerminal.mockRejectedValueOnce(new Error('OpenCode is installed with npm, which is not on PATH.'))
    await mount(<SignInHelp provider="opencode" mode="install" />)
    await act(async () => { button('Install OpenCode')!.click() })
    await flush()
    expect(h.runtimeTerminal).toHaveBeenCalledWith('opencode', 'install')
    expect(host!.querySelector('[role="alert"]')?.textContent).toContain('npm')
  })

  it('treats an expired sign-in as needing attention everywhere', () => {
    const runtime = { id: 'rt', provider: 'claude', authState: 'sign_in_failed', status: 'online' }
    expect(needsSignIn(runtime)).toBe(true)
    expect(runtimeAuthSummary(runtime)).toEqual({ state: 'unauthenticated', label: 'Sign in again' })
    expect(runtimeProblem(runtime as never)?.label).toContain('Sign in again')
    expect(needsSignIn({ authState: 'authenticated' })).toBe(false)
  })
})
