// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Runtime } from '../types'
import { PROVIDER_GUIDES } from './providerGuides'

vi.mock('../blob/BlobCanvas', () => ({ BlobCanvas: () => <div aria-label="Bitbots onboarding companion" /> }))
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../tauri', () => ({ rpc: mocks.rpc }))
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
afterEach(() => { if (root) act(() => root?.unmount()); host?.remove(); root = null; host = null; mocks.rpc.mockReset() })

describe('FirstRunOnboarding', () => {
  it('starts on the look step: Bitbots is tagged Primary, Blobots Alternative, and Continue waits for a choice', async () => {
    const { host: mounted } = mount({ runtimes: [runtime] })
    const cards = [...mounted.querySelectorAll<HTMLElement>('.look-card')]
    expect(cards.map((card) => card.dataset.look)).toEqual(['bitbots', 'blobots'])
    expect(cards[0].textContent).toContain('Primary')
    expect(cards[1].textContent).toContain('Alternative')
    expect(button('Continue').disabled).toBe(true)
    expect(mounted.querySelector('.look-preview')?.getAttribute('data-open')).toBe('false')
    await act(async () => { cards[1].click(); await Promise.resolve() })
    expect(mocks.rpc).toHaveBeenCalledWith('settings.set', { key: 'appearance.style', value: 'blobots' })
    expect(mounted.querySelector('.look-preview')?.getAttribute('data-open')).toBe('true')
    expect(document.documentElement.dataset.style).toBe('blobots')
    expect(button('Continue').disabled).toBe(false)
    await act(async () => { cards[0].click(); await Promise.resolve() })
    expect(document.documentElement.dataset.style).toBe('bitbots')
    act(() => button('Continue').click())
    expect(mounted.textContent).toContain('What should we call you?')
  })

  it('saves a name and provides the no-agent path', () => {
    const saveName = vi.fn()
    const { complete, host: mounted } = mount({ initialStep: 0, onSaveName: saveName })
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
    mocks.rpc.mockResolvedValue({ runtimeId:'runtime-codex', provider:'codex', validated:true, fallback:false, models:[
      { id:'gpt-6-sol', displayName:'GPT-6 Sol', supportedThinking:['low','medium','high','xhigh','max','ultra'], serviceTiers:[], isDefault:true },
      { id:'gpt-6-luna', displayName:'GPT-6 Luna', supportedThinking:['low','medium','high','xhigh','max'], serviceTiers:[], isDefault:false },
    ] })
    const create = vi.fn(async () => ({ id: 'agent-1' } as Agent))
    const saveName = vi.fn()
    const { host: mounted } = mount({ initialStep: 0, runtimes: [runtime], onCreate: create, onSaveName: saveName })
    input('Sam', 'name')
    await act(async () => { button('Continue').click(); await Promise.resolve(); await Promise.resolve() })
    expect(mounted.textContent).toContain('1.2')
    expect(mounted.textContent).toContain('Signed in')
    await act(async () => { button('Continue').click(); await Promise.resolve(); await Promise.resolve() })
    input('Helper', 'blob name')
    await act(async () => { button('Create blob').click(); await Promise.resolve() })
    expect(saveName).toHaveBeenCalledWith('Sam')
    expect(create).toHaveBeenCalledWith(runtime, 'Helper', '#b7a7f4', 'gpt-6-luna')
  })

  it('omits an unconfirmed version command and links to the official docs', () => {
    const { host: mounted } = mount({ initialStep: 0, runtimes: [runtime] })
    act(() => button('Skip').click())
    const codex = mounted.querySelector<HTMLElement>('[data-provider="codex"]')
    expect(codex?.textContent).toContain('Version check command not confirmed; see the official docs.')
    expect(codex?.querySelector('.onboarding-version-note')).not.toBeNull()
    expect(codex?.querySelector<HTMLAnchorElement>('.onboarding-doc-link')?.href).toBe(PROVIDER_GUIDES.codex.docsUrl)
    expect(codex?.querySelector('[aria-label="Copy Codex version command"]')).toBeNull()
  })
})
