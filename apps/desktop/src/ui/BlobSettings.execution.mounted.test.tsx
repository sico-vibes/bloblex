// @vitest-environment happy-dom
import { chooseOption, openSelect, selectOptions, selectTrigger, selectValue } from './testSelect'
import { act, useRef, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Runtime } from '../types'
import { updateParams, type AgentDraft } from './agentForm'
import type { ExecutionSendGate } from '../executionContract'
import { BlobSettings } from './BlobSettings'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../tauri', () => ({ inDesktop: true, rpc }))

const runtime = (provider: string): Runtime => ({ id: 'rt-1', provider, status: 'online' })

function draft(partial: Partial<AgentDraft> = {}): AgentDraft {
  return {
    name: 'Claude', description: '', instructions: 'Be brief', color: 'mint', runtimeId: 'rt-1', defaultProject: null,
    model: null, thinking: null, serviceTier: null, approvalMode: null, ...partial,
  }
}

function caps(settings: Record<string, unknown>) {
  return {
    runtimeId: 'rt-1',
    settings: {
      model: { supported: true, enabled: true, scope: 'turn', evidence: 'provider_echo' },
      thinking: { supported: true, enabled: true, scope: 'turn', evidence: 'usage_effect' },
      serviceTier: { supported: true, enabled: true, scope: 'turn', evidence: 'provider_echo' },
      instructions: { supported: true, enabled: true, scope: 'thread', evidence: 'successful_turn' },
      customEnv: { supported: true, enabled: true, scope: 'spawn', evidence: 'request_shape', allowedKeys: ['TZ', 'LANG'] },
      ...settings,
    },
  }
}

const catalog = {
  runtimeId: 'rt-1', provider: 'codex', fallback: false, validated: true, source: 'live_query', fetchedAt: '2026-10-02T00:00:00Z', expiresAt: '2026-10-02T00:01:00Z',
  models: [
    { id: 'alpha', displayName: 'Alpha', supportedThinking: ['low', 'high'], defaultThinking: 'high', serviceTiers: [{ id: 'priority', name: 'Priority' }], defaultServiceTier: 'priority', hostDependent: false, isDefault: true, group: 'Alpha', availability: 'offered' },
    { id: 'beta', displayName: 'Beta', supportedThinking: ['low'], defaultThinking: 'low', serviceTiers: [{ id: 'flex', name: 'Flex' }], defaultServiceTier: 'flex', hostDependent: true, isDefault: false, group: 'Beta', availability: 'offered' },
  ],
}

function answer(method: string) {
  if (method === 'runtime.capabilities') return caps({})
  if (method === 'runtime.models') return catalog
  if (method === 'exec.snapshot.latest') return {
    id: 'snap-1', sessionId: 'sess-1', status: 'partial', requested: { model: 'alpha' },
    applied: { model: { applied: null }, thinking: { applied: true }, serviceTier: 0, instructions: { applied: false } },
    evidence: { thinking: { kind: 'usage_effect' } },
  }
  return {}
}

function Harness({ provider, initial, sessionId = 'sess-1' }: { provider: string; initial: AgentDraft; sessionId?: string | null }) {
  const [value, setValue] = useState(initial)
  const baseline = useRef(initial)
  const gate = useRef<ExecutionSendGate>({ model: false, thinking: false, serviceTier: false })
  return <>
    <BlobSettings draft={value} runtimes={[runtime(provider)]} errors={{}} execution={{ model: initial.model, thinking: initial.thinking, serviceTier: initial.serviceTier, maxConcurrency: 1 }} agentId="agent-1" sessionId={sessionId} onDraftChange={setValue} onExecutionGate={(next) => { gate.current = next }} />
    <button type="button" onClick={() => { (document.body as HTMLElement & { __saved?: unknown }).__saved = updateParams('agent-1', value, baseline.current, gate.current) }}>Save probe</button>
  </>
}

const mounted: Array<{ unmount: () => void }> = []
function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  act(() => root.render(node))
  let live = true
  const view = {
    host,
    async settle() { await act(async () => { await Promise.resolve(); await Promise.resolve() }) },
    unmount() { if (!live) return; live = false; act(() => root.unmount()); host.remove() },
  }
  mounted.push(view)
  return view
}
afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); rpc.mockReset() })

function selectNamed(host: ParentNode, label: string) {
  return selectTrigger(host, label)
}

describe('live execution card', () => {
  it('renders supported, disabled, gated, and unknown controls', async () => {
    rpc.mockImplementation(async (method: string) => method === 'runtime.capabilities' ? caps({
      model: { supported: false, enabled: false, scope: 'turn', evidence: 'none', reason: 'No model flag' },
      thinking: { supported: true, enabled: false, scope: 'turn', evidence: 'none', reason: 'Gate closed' },
    }) : method === 'runtime.models' ? catalog : null)
    const disabled = mount(<Harness provider="codex" initial={draft({ model: 'alpha', thinking: 'high' })} sessionId={null} />)
    await disabled.settle()
    const model = disabled.host.querySelector('[data-capability="disabled"] .select-trigger') as HTMLButtonElement
    expect(model.disabled).toBe(true)
    expect(disabled.host.textContent).toContain('No model flag')
    expect(selectNamed(disabled.host, 'Thinking')).toBeNull()
    disabled.unmount()

    rpc.mockImplementation(async (method: string) => method === 'runtime.capabilities' ? caps({
      model: { supported: true, enabled: false, scope: 'turn', evidence: 'provider_echo', reason: 'Gate closed' },
      thinking: { supported: true, enabled: false, scope: 'turn', evidence: 'none', reason: 'Thinking gate' },
    }) : method === 'runtime.models' ? catalog : null)
    const gated = mount(<Harness provider="codex" initial={draft({ model: 'alpha' })} sessionId={null} />)
    await gated.settle()
    expect((gated.host.querySelector('[data-capability="gated"] .select-trigger') as HTMLButtonElement).disabled).toBe(true)
    expect(gated.host.textContent).toContain('Gate closed')
    expect(selectNamed(gated.host, 'Thinking')).toBeNull()
    gated.unmount()

    rpc.mockResolvedValue({})
    const unknown = mount(<Harness provider="codex" initial={draft()} sessionId={null} />)
    await unknown.settle()
    expect(unknown.host.querySelector('[data-capability="unknown"]')).not.toBeNull()
    expect(selectNamed(unknown.host, 'Thinking')).toBeNull()
    expect(unknown.host.textContent).toContain('has not reported')
  })

  it('resets thinking and tier to the selected model and sends tier ids', async () => {
    rpc.mockImplementation(async (method: string) => answer(method))
    const view = mount(<Harness provider="codex" initial={draft({ model: 'alpha', thinking: 'high', serviceTier: 'priority' })} />)
    await view.settle()
    const speedOptions = (await selectOptions(view.host, 'Speed')).map((option) => [option.value, option.label])
    expect(speedOptions).toEqual([['', 'Default'], ['priority', 'Priority']])
    expect(speedOptions.some(([value]) => value === 'fast' || value === 'standard')).toBe(false)
    await chooseOption(view.host, 'Model', 'beta')
    expect(selectValue(view.host, 'Thinking')).toBe('low')
    expect(selectValue(view.host, 'Speed')).toBe('flex')
    await act(async () => { [...view.host.querySelectorAll('button')].find((button) => button.textContent === 'Save probe')?.click() })
    const saved = (document.body as HTMLElement & { __saved?: Record<string, unknown> }).__saved
    expect(saved).toMatchObject({ model: 'beta', thinking: 'low', serviceTier: 'flex' })
    const outcomes = [...view.host.querySelectorAll('[data-outcome]')].map((row) => row.getAttribute('data-outcome'))
    expect(outcomes).toEqual(['Unknown', 'Applied', 'Unknown', 'Not applied'])
    const modelRow = view.host.querySelector('[data-outcome="Unknown"]')
    expect(modelRow?.textContent).not.toContain('Applied')
    expect(view.host.textContent).toContain('Applies to new conversations.')
  })

  it('hides the thinking control when the selected model has no model-specific effort evidence', async () => {
    rpc.mockImplementation(async (method: string) => method === 'runtime.models'
      ? { ...catalog, models: [{ ...catalog.models[0], supportedThinking: [] }] }
      : answer(method))
    const view = mount(<Harness provider="opencode" initial={draft({ model: 'alpha', thinking: 'high' })} sessionId={null} />)
    await view.settle()
    expect(selectValue(view.host, 'Model')).toBe('alpha')
    expect(selectNamed(view.host, 'Thinking')).toBeNull()
  })

  it('accepts an unvalidated custom Claude id and does not send thinking', async () => {
    rpc.mockImplementation(async (method: string) => method === 'runtime.models' ? { ...catalog, provider: 'claude', fallback: true } : answer(method))
    const view = mount(<Harness provider="claude" initial={draft()} sessionId={null} />)
    await view.settle()
    expect(view.host.textContent).toContain('Suggested models, not checked with Claude Code.')
    await chooseOption(view.host, 'Model', '__custom__')
    const input = view.host.querySelector<HTMLInputElement>('[aria-label="Custom model id"]')!
    expect(view.host.textContent).toContain('Not validated')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'claude-custom-9')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(selectNamed(view.host, 'Thinking')).toBeNull()
    await act(async () => { [...view.host.querySelectorAll('button')].find((button) => button.textContent === 'Save probe')?.click() })
    const saved = (document.body as HTMLElement & { __saved?: Record<string, unknown> }).__saved
    expect(saved).toMatchObject({ model: 'claude-custom-9' })
    expect(saved).not.toHaveProperty('thinking')
    expect(saved).not.toHaveProperty('serviceTier')
  })

  it('shows provider unavailable with retry and refreshes the catalog', async () => {
    rpc.mockImplementation(async (method: string, params?: { refresh?: boolean }) => {
      if (method === 'runtime.models' && params?.refresh) return catalog
      if (method === 'runtime.models') throw new Error('provider_unavailable: offline')
      if (method === 'runtime.capabilities') return caps({})
      return null
    })
    const view = mount(<Harness provider="opencode" initial={draft({ instructions: '' })} sessionId={null} />)
    await view.settle()
    expect(view.host.textContent).toContain('The provider could not be reached.')
    expect(view.host.textContent).toContain('has not reported')
    await act(async () => { [...view.host.querySelectorAll('button')].find((button) => button.textContent === 'Retry')?.click() })
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('runtime.models', { runtimeId: 'rt-1', refresh: true })
    expect(selectNamed(view.host, 'Model')).not.toBeNull()
  })

  it('labels suggestions, refresh time, default family, and a saved model missing from discovery', async () => {
    rpc.mockImplementation(async (method: string) => method === 'runtime.models'
      ? {
          ...catalog,
          fallback: true,
          validated: false,
          source: 'fallback',
          models: [
            ...catalog.models.map((model, index) => ({ ...model, isDefault: index === 0, group: 'Alpha family' })),
            { id: 'gamma', displayName: 'Gamma', supportedThinking: [], defaultThinking: null, serviceTiers: [], defaultServiceTier: null, variants: [], hostDependent: false, isDefault: false, group: 'Other models', availability: null },
          ],
        }
      : answer(method))
    const view = mount(<Harness provider="codex" initial={draft({ model: 'retired-model' })} sessionId={null} />)
    await view.settle()
    expect(view.host.textContent).toContain('Suggested models, not checked with Codex.')
    expect(view.host.querySelector('.catalog-refresh-action')?.textContent).toContain('Updated')
    const options = await selectOptions(view.host, 'Model')
    expect(options).toContainEqual(expect.objectContaining({ value: 'alpha', label: 'Alpha · Default' }))
    expect(options).toContainEqual(expect.objectContaining({ value: 'retired-model', label: 'retired-model' }))
    expect(options).toContainEqual(expect.objectContaining({ value: 'gamma', label: 'Gamma' }))
    await openSelect(view.host, 'Model')
    expect([...view.host.querySelectorAll('.select-group-label')].map((node) => node.textContent)).toEqual(['Alpha family', 'Other models'])

    view.unmount()
    rpc.mockImplementation(async (method: string) => method === 'runtime.models' ? catalog : answer(method))
    const liveView = mount(<Harness provider="codex" initial={draft({ model: 'retired-model' })} sessionId={null} />)
    await liveView.settle()
    expect(liveView.host.querySelector('.model-catalog-note')).toBeNull()
    const liveOptions = await selectOptions(liveView.host, 'Model')
    expect(liveOptions).toContainEqual(expect.objectContaining({
      value: 'retired-model',
      label: 'retired-model · Not offered by Codex right now',
    }))
  })

  it('states an empty catalog without inventing models', async () => {
    rpc.mockImplementation(async (method: string) => method === 'runtime.models' ? { ...catalog, models: [] } : method === 'runtime.capabilities' ? caps({ thinking: { supported: true, enabled: true, scope: 'turn', evidence: 'none' } }) : null)
    const view = mount(<Harness provider="opencode" initial={draft()} sessionId={null} />)
    await view.settle()
    expect(view.host.textContent).toContain('No models were reported for this agent.')
    expect(view.host.textContent).toContain('Applies when the next conversation starts.')
    expect(selectNamed(view.host, 'Thinking')).toBeNull()
    await act(async () => { [...view.host.querySelectorAll('button')].find((button) => button.textContent === 'Refresh models')?.click() })
    expect(rpc).toHaveBeenCalledWith('runtime.models', { runtimeId: 'rt-1', refresh: true })
  })
})
