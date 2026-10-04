// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Runtime } from '../types'
import { chooseOption } from './testSelect'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../tauri', () => ({ inDesktop: true, rpc }))

import { UsageLimitsSettings } from './UsageLimitsSettings'

const agent: Agent = { id: 'agent-1', name: 'Helper', description: '', instructions: '', color: '#aaaaaa', runtimeId: 'runtime-1', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {}, maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: '', updatedAt: '' }
const runtime: Runtime = { id: 'runtime-1', provider: 'codex' }
let budgets: Record<string, unknown>[]
let prices: Record<string, unknown>[]
let subscriptions: Record<string, unknown>[]
let catalogModels: Record<string, unknown>[]
const views: Array<{ unmount: () => void }> = []

function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  act(() => root.render(node))
  const view = { host, async settle() { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() }) }, rerender(node: ReactNode) { act(() => root.render(node)) }, unmount() { act(() => root.unmount()); host.remove() } }
  views.push(view)
  return view
}

function fill(host: ParentNode, label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!input) throw new Error(`Missing ${label}`)
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function click(host: ParentNode, label: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.replace(/\s+/g, ' ').trim() === label || item.getAttribute('aria-label') === label)
  if (!button) throw new Error(`Missing button ${label}`)
  await act(async () => { button.click(); await Promise.resolve() })
}

async function clickPriceAction(host: ParentNode, model: string, action: string) {
  const row = [...host.querySelectorAll<HTMLElement>('.price-table-row')].find((item) => item.textContent?.includes(model))
  const summary = row?.querySelector<HTMLElement>('summary')
  if (!row || !summary) throw new Error(`Missing price row ${model}`)
  await act(async () => { summary.click(); await Promise.resolve() })
  await click(host, action)
}

beforeEach(() => {
  budgets = []
  prices = []
  subscriptions = []
  catalogModels = []
  rpc.mockReset()
  rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'budget.list') return { policies: budgets }
    if (method === 'budget.set') { budgets = [...budgets.filter((item) => item.id !== params.id), { ...params, consumed: 0, reserved: 0, remaining: params.hardLimit }]; return { saved: true } }
    if (method === 'budget.delete') { budgets = budgets.filter((item) => item.id !== params.policyId); return { deleted: true } }
    if (method === 'pricing.list') return { rules: prices }
    if (method === 'runtime.models') return { models: catalogModels }
    if (method === 'pricing.override') { const rule = params.rule as Record<string, unknown>; prices = rule.remove === true ? prices.filter((item) => item.id !== rule.id) : [...prices.filter((item) => item.id !== rule.id), rule]; return { saved: true } }
    if (method === 'subscription.list') return { plans: subscriptions }
    if (method === 'subscription.save') { const plan = params.plan as Record<string, unknown>; subscriptions = [...subscriptions.filter((item) => item.id !== plan.id), plan]; return { saved: true } }
    throw new Error(`Unexpected RPC ${method}`)
  })
})

afterEach(() => { for (const view of views.splice(0)) view.unmount() })

describe('Usage & limits settings forms', () => {
  it('adds, edits, and confirms deletion of a budget', async () => {
    const view = mount(<UsageLimitsSettings agents={[agent]} runtimes={[runtime]} sessions={[]} />)
    await view.settle()
    await click(view.host, 'Add budget')
    await chooseOption(view.host, 'Budget target', 'agent-1')
    fill(view.host, 'Budget limit', '1000')
    await click(view.host, 'Save budget')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('budget.set', expect.objectContaining({ metric: 'tokens', hardLimit: 1000, scopeType: 'blob', scopeId: 'agent-1' }))
    await click(view.host, 'Edit')
    fill(view.host, 'Budget limit', '2000')
    await click(view.host, 'Save budget')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('budget.set', expect.objectContaining({ hardLimit: 2000 }))
    await click(view.host, 'Delete budget Blob · Helper')
    await click(view.host, 'Delete budget')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('budget.delete', expect.objectContaining({ policyId: expect.any(String) }))
  })

  it('saves blob and coding-agent scope ids from their selects', async () => {
    const runtimeWithIdentity: Runtime = { ...runtime, version: '2.0', executablePath: 'C:/agents/codex.exe' }
    const view = mount(<UsageLimitsSettings agents={[agent]} runtimes={[runtimeWithIdentity]} sessions={[]} />)
    await view.settle()

    await click(view.host, 'Add budget')
    await chooseOption(view.host, 'Budget target', 'agent-1')
    fill(view.host, 'Budget limit', '100')
    await click(view.host, 'Save budget')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('budget.set', expect.objectContaining({ scopeType: 'blob', scopeId: 'agent-1' }))

    await click(view.host, 'Add budget')
    await chooseOption(view.host, 'Budget scope', 'agent')
    await chooseOption(view.host, 'Budget target', 'codex')
    fill(view.host, 'Budget limit', '200')
    await click(view.host, 'Save budget')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('budget.set', expect.objectContaining({ scopeType: 'agent', scopeId: 'codex' }))
  })

  it('lists legacy cost budgets as unenforced and still permits deletion', async () => {
    budgets = [{ id: 'cost-policy', scopeType: 'global', period: 'month', metric: 'cost_minor', hardLimit: 1000, currency: 'USD', consumed: 0, reserved: 0, remaining: 1000, enabled: true }]
    const view = mount(<UsageLimitsSettings agents={[agent]} runtimes={[runtime]} sessions={[]} />)
    await view.settle()
    expect(view.host.textContent).toContain('Cost limits are not enforced before a turn yet.')
    expect(view.host.textContent).toContain('Usage unknown.')
    expect(view.host.textContent).not.toContain('Used $0.00')
    expect([...view.host.querySelectorAll('.settings-row button')].some((button) => button.textContent?.trim() === 'Edit')).toBe(false)
    await click(view.host, 'Delete budget Everything')
    await click(view.host, 'Delete budget')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('budget.delete', { policyId: 'cost-policy' })
  })

  it('sets and removes a model price while preserving unknown rates', async () => {
    const view = mount(<UsageLimitsSettings agents={[agent]} runtimes={[runtime]} sessions={[{ id: 's', runtimeId: 'runtime-1', model: 'gpt-5.5' }]} />)
    await view.settle()
    await clickPriceAction(view.host, 'gpt-5.5', 'Use my own price…')
    fill(view.host, 'Input rate per million tokens', '1.25')
    await click(view.host, 'Save price')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('pricing.override', { rule: expect.objectContaining({ inputPerMillion: '1.25', outputPerMillion: null, cacheReadPerMillion: null, cacheWritePerMillion: null, currency: 'USD' }) })
    expect(view.host.textContent).toContain('Your price')
    await clickPriceAction(view.host, 'gpt-5.5', 'Remove my price')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('pricing.override', { rule: expect.objectContaining({ remove: true }) })
    expect(view.host.textContent).toContain('Unknown')
  })

  it('edits only the raw override fields and uses inherited rates as placeholders', async () => {
    prices = [{
      id: 'partial-price', provider: 'codex', canonicalModelId: 'gpt-5.5', currency: 'USD', source: 'user_override',
      inputPerMillion: '0.17', outputPerMillion: null, cacheReadPerMillion: null, cacheWritePerMillion: null,
      effectiveFields: {
        inputPerMillion: { rate: '0.17', source: 'user_override', currency: 'USD' },
        outputPerMillion: { rate: '0.5', source: 'official_price_list', currency: 'USD', checkedAt: '2026-10-04' },
        cacheReadPerMillion: { rate: '0.01', source: 'official_price_list', currency: 'USD', checkedAt: '2026-10-04' },
        cacheWritePerMillion: { rate: '0.125', source: 'official_price_list', currency: 'USD', checkedAt: '2026-10-04' },
      },
    }]
    const view = mount(<UsageLimitsSettings agents={[agent]} runtimes={[runtime]} sessions={[{ id: 'price-session', runtimeId: runtime.id, model: 'gpt-5.5' }]} />)
    await view.settle()
    await clickPriceAction(view.host, 'gpt-5.5', 'Edit my price…')

    expect(view.host.querySelector<HTMLInputElement>('[aria-label="Input rate per million tokens"]')?.value).toBe('0.17')
    expect(view.host.querySelector<HTMLInputElement>('[aria-label="Output rate per million tokens"]')?.value).toBe('')
    expect(view.host.querySelector<HTMLInputElement>('[aria-label="Output rate per million tokens"]')?.placeholder).toContain('0.5 USD · Official price list')
    expect(view.host.querySelector<HTMLInputElement>('[aria-label="Cache read rate per million tokens"]')?.value).toBe('')
    expect(view.host.querySelector<HTMLInputElement>('[aria-label="Cache read rate per million tokens"]')?.placeholder).toContain('0.01 USD · Official price list')
    expect(view.host.querySelector<HTMLInputElement>('[aria-label="Cache write rate per million tokens"]')?.value).toBe('')
    expect(view.host.querySelector<HTMLInputElement>('[aria-label="Cache write rate per million tokens"]')?.placeholder).toContain('0.125 USD · Official price list')

    fill(view.host, 'Cache read rate per million tokens', '0.007')
    await click(view.host, 'Save price')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('pricing.override', { rule: expect.objectContaining({ inputPerMillion: '0.17', outputPerMillion: null, cacheReadPerMillion: '0.007', cacheWritePerMillion: null }) })
  })

  it('resets rate fields when switching targets and saves fractional rates losslessly in JPY', async () => {
    const sessions = [
      { id: 's-a', runtimeId: 'runtime-1', model: 'model-a' },
      { id: 's-b', runtimeId: 'runtime-1', model: 'model-b' },
    ]
    const view = mount(<UsageLimitsSettings agents={[agent]} runtimes={[runtime]} sessions={sessions} />)
    await view.settle()

    await clickPriceAction(view.host, 'model-a', 'Use my own price…')
    fill(view.host, 'Input rate per million tokens', '1.25')
    await clickPriceAction(view.host, 'model-b', 'Use my own price…')
    expect(view.host.querySelector<HTMLInputElement>('[aria-label="Input rate per million tokens"]')?.value).toBe('')
    fill(view.host, 'Input rate per million tokens', '0.50')
    await click(view.host, 'Save price')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('pricing.override', { rule: expect.objectContaining({ canonicalModelId: 'model-b', inputPerMillion: '0.50' }) })
    expect(prices.find((rule) => rule.canonicalModelId === 'model-b')?.inputPerMillion).toBe('0.50')

    await clickPriceAction(view.host, 'model-a', 'Use my own price…')
    fill(view.host, 'Input rate per million tokens', '0.003')
    await chooseOption(view.host, 'Price currency', 'JPY')
    await click(view.host, 'Save price')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('pricing.override', { rule: expect.objectContaining({ canonicalModelId: 'model-a', inputPerMillion: '0.003', currency: 'JPY' }) })
    expect(rpc.mock.calls.filter((call) => call[0] === 'pricing.override')).toHaveLength(2)
  })

  it('labels official and cached catalog prices and prefers the official row', async () => {
    const openCodeRuntime: Runtime = { id: 'runtime-1', provider: 'opencode' }
    prices = [{ id: 'official-go-luna', provider: 'opencode-go', canonicalModelId: 'gpt-6-luna', currency: 'USD', inputPerMillion: '0.10', outputPerMillion: '0.50', cacheReadPerMillion: '0.01', cacheWritePerMillion: '0.125', source: 'official_price_list', checkedAt: '2026-10-04', tiers: [{ kind: 'long_context', thresholdInputTokens: 272000 }] }]
    catalogModels = [
      { id: 'opencode-go/gpt-6-luna', reportedPrice: { inputPerMillion: '0', outputPerMillion: '0', cacheReadPerMillion: '0', cacheWritePerMillion: '0', currency: 'USD' } },
      { id: 'opencode-go/free-catalog-only', reportedPrice: { inputPerMillion: '0', outputPerMillion: '0', cacheReadPerMillion: '0', currency: 'USD' } },
    ]
    const view = mount(<UsageLimitsSettings agents={[agent]} runtimes={[openCodeRuntime]} sessions={[]} showAllModelsByDefault />)
    await view.settle()
    expect(view.host.textContent).toContain('Official prices from each vendor, checked 4 Oct 2026.')
    expect(view.host.textContent).toContain('OpenCode catalog estimate')
    expect(view.host.textContent).toContain('Free')
    expect(view.host.textContent).toContain('272,000 input tokens: long-context rates')
  })

  it('hides unused model prices by default and reveals them with the accessible switch', async () => {
    prices = [{ id: 'unused-price', provider: 'codex', canonicalModelId: 'unused-model', currency: 'USD', inputPerMillion: '1', outputPerMillion: '2', source: 'official_price_list' }]
    const view = mount(<UsageLimitsSettings agents={[agent]} runtimes={[runtime]} sessions={[]} />)
    await view.settle()
    expect(view.host.textContent).not.toContain('unused-model')
    const toggle = view.host.querySelector<HTMLButtonElement>('[aria-label="Show all models"]')
    expect(toggle?.getAttribute('role')).toBe('switch')
    await act(async () => { toggle?.click(); await Promise.resolve() })
    expect(view.host.textContent).toContain('unused-model')
  })

  it('loads OpenCode catalog prices when an OpenCode runtime appears after the sheet opens', async () => {
    const view = mount(<UsageLimitsSettings agents={[agent]} runtimes={[runtime]} sessions={[]} />)
    await view.settle()
    expect(rpc).not.toHaveBeenCalledWith('runtime.models', expect.anything())
    view.rerender(<UsageLimitsSettings agents={[agent]} runtimes={[{ id: 'runtime-1', provider: 'opencode' }]} sessions={[]} />)
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('runtime.models', { runtimeId: 'runtime-1' })
  })

  it('validates and adds or edits a subscription fee in the selected currency', async () => {
    const view = mount(<UsageLimitsSettings agents={[agent]} runtimes={[runtime]} sessions={[]} />)
    await view.settle()
    await click(view.host, 'Add subscription')
    await click(view.host, 'Save subscription')
    expect(view.host.textContent).toContain('Enter a provider, plan name, and a valid monthly fee.')
    fill(view.host, 'Subscription provider', 'Codex')
    fill(view.host, 'Subscription plan name', 'Monthly')
    fill(view.host, 'Monthly fee', '2.50')
    await chooseOption(view.host, 'Subscription currency', 'EUR')
    await click(view.host, 'Save subscription')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('subscription.save', { plan: expect.objectContaining({ provider: 'Codex', planName: 'Monthly', monthlyMinor: 250, currency: 'EUR' }) })
    await click(view.host, 'Edit')
    fill(view.host, 'Monthly fee', '3.00')
    await click(view.host, 'Save subscription')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('subscription.save', { plan: expect.objectContaining({ monthlyMinor: 300, currency: 'EUR' }) })

    await click(view.host, 'Add subscription')
    fill(view.host, 'Subscription provider', 'Codex')
    fill(view.host, 'Subscription plan name', 'JPY plan')
    fill(view.host, 'Monthly fee', '10.00')
    await chooseOption(view.host, 'Subscription currency', 'JPY')
    await click(view.host, 'Save subscription')
    expect(view.host.textContent).toContain('JPY subscription fees must be whole numbers.')
    expect(rpc.mock.calls.filter((call) => call[0] === 'subscription.save')).toHaveLength(2)
  })
})
