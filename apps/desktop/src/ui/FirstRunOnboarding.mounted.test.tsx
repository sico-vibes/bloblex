// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Runtime } from '../types'
import { PROVIDER_GUIDES } from './providerGuides'

vi.mock('../blob/BlobCanvas', () => ({ BlobCanvas: () => <div aria-label="Bloblex onboarding companion" /> }))
import { FirstRunOnboarding } from './FirstRunOnboarding'

const runtime = { id: 'runtime-codex', provider: 'codex', version: '1.2', authState: 'authenticated' } as Runtime
let root: Root | null = null
let host: HTMLDivElement | null = null
function mount(props: Partial<React.ComponentProps<typeof FirstRunOnboarding>> = {}) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const complete = vi.fn()
  act(() => root!.render(<FirstRunOnboarding runtimes={[]} scanning={false} error={null} onScan={vi.fn()} onCreate={vi.fn(async () => null)} onFinish={complete} onSaveName={vi.fn()} {...props} />))
  return { complete, host }
}
function button(name: string) { return [...(host?.querySelectorAll('button') ?? [])].find((item) => item.textContent?.includes(name))! }
function input(value: string, label: string) {
  const target = host?.querySelector<HTMLInputElement>('input')
  if (!target) throw new Error('Input missing: ' + label)
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
afterEach(() => { if (root) act(() => root?.unmount()); host?.remove(); root = null; host = null })

describe('FirstRunOnboarding', () => {
  it('saves a name and provides the no-agent path', () => {
    const saveName = vi.fn()
    const { complete, host: mounted } = mount({ onSaveName: saveName })
    act(() => button('Skip').click())
    expect(mounted.textContent).toContain('Not found')
    act(() => button('Continue without an agent').click())
    expect(saveName).toHaveBeenCalledWith('')
    expect(complete).toHaveBeenCalledOnce()
  })

  it('renders onboarding step two with found and missing agent rows', () => {
    const found = mount({ initialStep: 1, runtimes: [runtime] })
    const codex = found.host.querySelector<HTMLElement>('[data-provider="codex"]')
    expect(codex?.textContent).toContain('Signed in')
    expect(codex?.querySelector('.provider-logo')).not.toBeNull()
    act(() => root?.unmount())
    found.host.remove()
    root = null
    host = null

    const missing = mount({ initialStep: 1, runtimes: [] })
    expect(missing.host.querySelectorAll('.onboarding-runtime')).toHaveLength(3)
    expect(missing.host.querySelector('[data-provider="claude"]')?.textContent).toContain('Not found on this Windows device')
  })

  it('shows each OpenCode gateway state from the normalized runtime record', () => {
    const openCode: Runtime = { id: 'runtime-opencode', provider: 'opencode', gatewayAuthStates: { opencode: 'authenticated', 'opencode-go': 'authenticated' } }
    const { host: mounted } = mount({ initialStep: 1, runtimes: [openCode] })
    expect(mounted.querySelector('[data-provider="opencode"]')?.textContent).toContain('Zen: signed in · Go: signed in')
  })

  it('shows found agent details and sends the selected runtime, name and colour to create', async () => {
    const create = vi.fn(async () => ({ id: 'agent-1' } as Agent))
    const saveName = vi.fn()
    const { host: mounted } = mount({ runtimes: [runtime], onCreate: create, onSaveName: saveName })
    input('Sam', 'name')
    act(() => button('Continue').click())
    expect(mounted.textContent).toContain('1.2')
    expect(mounted.textContent).toContain('Signed in')
    act(() => button('Continue').click())
    input('Helper', 'blob name')
    await act(async () => { button('Create blob').click(); await Promise.resolve() })
    expect(saveName).toHaveBeenCalledWith('Sam')
    expect(create).toHaveBeenCalledWith(runtime, 'Helper', '#b7a7f4')
  })

  it('omits an unconfirmed version command and links to the official docs', () => {
    const { host: mounted } = mount({ runtimes: [runtime] })
    act(() => button('Skip').click())
    const codex = mounted.querySelector<HTMLElement>('[data-provider="codex"]')
    expect(codex?.textContent).toContain('Version check command not confirmed; see the official docs.')
    expect(codex?.querySelector('.onboarding-version-note')).not.toBeNull()
    expect(codex?.querySelector<HTMLAnchorElement>('.onboarding-doc-link')?.href).toBe(PROVIDER_GUIDES.codex.docsUrl)
    expect(codex?.querySelector('[aria-label="Copy Codex version command"]')).toBeNull()
  })
})
