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
const views: Array<{ unmount: () => void }> = []

function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  act(() => root.render(node))
  const view = { host, async settle() { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() }) }, unmount() { act(() => root.unmount()); host.remove() } }
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

async function clickRow(host: ParentNode, rowText: string, buttonText: string) {
  const row = [...host.querySelectorAll<HTMLElement>('.settings-row')].find((item) => item.textContent?.includes(rowText))
  const button = [...(row?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((item) => item.textContent?.trim() === buttonText)
  if (!button) throw new Error(`Missing ${buttonText} for ${rowText}`)
  await act(async () => { button.click(); await Promise.resolve() })
}

beforeEach(() => {
  budgets = []
  prices = []
  subscriptions = []
  rpc.mockReset()
  rpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'budget.list') return { policies: budgets }
    if (method === 'budget.set') { budgets = [...budgets.filter((item) => item.id !== params.id), { ...params, consumed: 0, reserved: 0, remaining: params.hardLimit }]; return { saved: true } }
    if (method === 'budget.delete') { budgets = budgets.filter((item) => item.id !== params.policyId); return { deleted: true } }
    if (method === 'pricing.list') return { rules: prices }
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
    fill(view.host, 'Budget limit', '1000')
    await click(view.host, 'Save budget')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('budget.set', expect.objectContaining({ metric: 'tokens', hardLimit: 1000, scopeType: 'global' }))
    await click(view.host, 'Edit')
    fill(view.host, 'Budget limit', '2000')
    await click(view.host, 'Save budget')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('budget.set', expect.objectContaining({ hardLimit: 2000 }))
    await click(view.host, 'Delete budget All agents')
    await click(view.host, 'Delete budget')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('budget.delete', expect.objectContaining({ policyId: expect.any(String) }))
  })

  it('saves provider and agent-install scope ids from their selects', async () => {
    const runtimeWithIdentity: Runtime = { ...runtime, version: '2.0', executablePath: 'C:/agents/codex.exe' }
    const view = mount(<UsageLimitsSettings agents={[agent]} runtimes={[runtimeWithIdentity]} sessions={[]} />)
    await view.settle()

    await click(view.host, 'Add budget')
    await chooseOption(view.host, 'Budget scope', 'agent')
    await chooseOption(view.host, 'Budget target', 'codex')
    fill(view.host, 'Budget limit', '100')
    await click(view.host, 'Save budget')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('budget.set', expect.objectContaining({ scopeType: 'agent', scopeId: 'codex' }))

    await click(view.host, 'Add budget')
    await chooseOption(view.host, 'Budget scope', 'runtime')
    await chooseOption(view.host, 'Budget target', 'runtime-1')
    fill(view.host, 'Budget limit', '200')
    await click(view.host, 'Save budget')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('budget.set', expect.objectContaining({ scopeType: 'runtime', scopeId: 'runtime-1' }))
  })

  it('lists legacy cost budgets as unenforced and still permits deletion', async () => {
    budgets = [{ id: 'cost-policy', scopeType: 'global', period: 'month', metric: 'cost_minor', hardLimit: 1000, currency: 'USD', consumed: 0, reserved: 0, remaining: 1000, enabled: true }]
    const view = mount(<UsageLimitsSettings agents={[agent]} runtimes={[runtime]} sessions={[]} />)
    await view.settle()
    expect(view.host.textContent).toContain('Cost limits are not enforced before a turn yet.')
    expect(view.host.textContent).toContain('Usage unknown.')
    expect(view.host.textContent).not.toContain('Used $0.00')
    expect([...view.host.querySelectorAll('.settings-row button')].some((button) => button.textContent?.trim() === 'Edit')).toBe(false)
    await click(view.host, 'Delete budget All agents')
    await click(view.host, 'Delete budget')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('budget.delete', { policyId: 'cost-policy' })
  })

  it('sets and removes a model price while preserving unknown rates', async () => {
    const view = mount(<UsageLimitsSettings agents={[agent]} runtimes={[runtime]} sessions={[{ id: 's', runtimeId: 'runtime-1', model: 'gpt-5.5' }]} />)
    await view.settle()
    await click(view.host, 'Set price')
    fill(view.host, 'Input rate per million tokens', '1.25')
    await click(view.host, 'Save price')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('pricing.override', { rule: expect.objectContaining({ inputPerMillion: 125, outputPerMillion: null, cacheReadPerMillion: null, cacheWritePerMillion: null, currency: 'USD' }) })
    expect(view.host.textContent).toContain('Your override')
    await click(view.host, 'Remove override')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('pricing.override', { rule: expect.objectContaining({ remove: true }) })
    expect(view.host.textContent).toContain('No price, costs stay unknown')
  })

  it('resets rate fields when switching model targets and rejects decimals after switching to JPY', async () => {
    const sessions = [
      { id: 's-a', runtimeId: 'runtime-1', model: 'model-a' },
      { id: 's-b', runtimeId: 'runtime-1', model: 'model-b' },
    ]
    const view = mount(<UsageLimitsSettings agents={[agent]} runtimes={[runtime]} sessions={sessions} />)
    await view.settle()

    await clickRow(view.host, 'model-a', 'Set price')
    fill(view.host, 'Input rate per million tokens', '1.25')
    await clickRow(view.host, 'model-b', 'Set price')
    expect(view.host.querySelector<HTMLInputElement>('[aria-label="Input rate per million tokens"]')?.value).toBe('')
    fill(view.host, 'Input rate per million tokens', '0.50')
    await click(view.host, 'Save price')
    await view.settle()
    expect(rpc).toHaveBeenCalledWith('pricing.override', { rule: expect.objectContaining({ canonicalModelId: 'model-b', inputPerMillion: 50 }) })
    expect(prices.find((rule) => rule.canonicalModelId === 'model-b')?.inputPerMillion).toBe(50)

    await clickRow(view.host, 'model-a', 'Set price')
    fill(view.host, 'Input rate per million tokens', '10.00')
    await chooseOption(view.host, 'Price currency', 'JPY')
    await click(view.host, 'Save price')
    expect(view.host.textContent).toContain('JPY rates must be whole numbers.')
    expect(rpc.mock.calls.filter((call) => call[0] === 'pricing.override')).toHaveLength(1)
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
