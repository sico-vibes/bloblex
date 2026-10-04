// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Runtime } from '../types'
import { SetupScreen } from './SetupScreen'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
afterEach(() => { if (root) act(() => root.unmount()); host?.remove() })

describe('first run setup screen', () => {
  it('shows each detected runtime and the sign-in hint only for reported signed-out state', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    const runtimes: Runtime[] = [
      { id: 'rt-a', provider: 'codex', version: '1.4', authState: 'unauthenticated' },
      { id: 'rt-b', provider: 'opencode', version: '2.1', authState: 'authenticated' },
    ]
    await act(async () => root.render(<SetupScreen runtimes={runtimes} onCreate={vi.fn()} onScan={vi.fn()} onCustom={vi.fn()} />))
    expect(host.querySelectorAll('.setup-agent-row')).toHaveLength(2)
    expect(host.textContent).toContain('Sign in with the Codex command line tool, then scan again.')
    expect(host.textContent).not.toContain('Sign in with the OpenCode command line tool, then scan again.')
    expect(host.textContent).toContain('1.4')
    expect(host.textContent).toContain('unauthenticated')
  })

  it('passes the exact runtime selected by its Create blob action', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    const runtime: Runtime = { id: 'rt-selected', provider: 'codex', version: '1' }
    const create = vi.fn()
    await act(async () => root.render(<SetupScreen runtimes={[runtime]} onCreate={create} onScan={vi.fn()} onCustom={vi.fn()} />))
    await act(async () => host.querySelector<HTMLButtonElement>('.setup-agent-row button')?.click())
    expect(create).toHaveBeenCalledWith(runtime)
  })

  it('names the provider in the create action and disables an in-flight runtime', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    const runtime: Runtime = { id: 'rt-codex', provider: 'codex' }
    await act(async () => root.render(<SetupScreen runtimes={[runtime]} creatingRuntimeIds={['rt-codex']} error="Could not create blob." onCreate={vi.fn()} onScan={vi.fn()} onCustom={vi.fn()} />))
    const button = host.querySelector<HTMLButtonElement>('.setup-agent-row button')!
    expect(button.getAttribute('aria-label')).toBe('Create a Codex blob')
    expect(button.disabled).toBe(true)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not create blob.')
  })
})
