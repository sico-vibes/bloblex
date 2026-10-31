// @vitest-environment happy-dom
// Phase 5: accounts, custom models, secrets and the one-use form.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Runtime } from '../types'

const rpc = vi.fn()
vi.mock('../tauri', () => ({
  inDesktop: true,
  rpc: (...args: unknown[]) => rpc(...args),
  listenForDaemonEvents: vi.fn(async () => () => undefined),
  openExternal: vi.fn(),
}))

import { AccountsPage, accountLine, customModelProblem, parseEfforts } from './AccountsPage'
import { SecretRequests, SecretsPage, secondsLeft, secretNameProblem } from './SecretsPage'

let root: Root | null = null
let host: HTMLDivElement
const render = async (element: React.ReactElement) => {
  await act(async () => { root!.render(element) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const button = (label: string) => [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label) as HTMLButtonElement
const click = async (element: Element | null | undefined) => { await act(async () => { (element as HTMLElement).click() }); await flush() }
const type = async (element: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
const called = (method: string) => rpc.mock.calls.filter((call) => call[0] === method).map((call) => call[1])
const replies = (table: Record<string, unknown>) => rpc.mockImplementation(async (method: string) => {
  if (!(method in table)) return {}
  return table[method]
})
const runtime = (over: Record<string, unknown>) => ({ id: 'r', provider: 'claude', ...over }) as unknown as Runtime

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  rpc.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  host.remove()
  document.body.innerHTML = ''
})

describe('accounts', () => {
  it('an unknown name stays unknown', () => {
    expect(accountLine({ label: 'me@example.com', plan: 'pro' })).toBe('me@example.com · pro')
    expect(accountLine({ label: null, plan: null })).toBe('Signed in')
    expect(accountLine(null)).toBe('Signed in')
    expect(accountLine({ label: 'x', plan: null }, false)).toBe('Not signed in')
  })

  it('shows who is signed in and adds an account', async () => {
    replies({ 'account.list': { accounts: [] } })
    await render(<AccountsPage runtimes={[runtime({ account: { label: 'me@example.com', plan: 'pro', source: 'claude auth status' } })]} />)
    expect(document.body.textContent).toContain('me@example.com · pro')
    await type(document.querySelector<HTMLInputElement>('input[aria-label^="Name for a new"]')!, 'Work')
    await click(button('Add account'))
    expect(called('account.create')).toEqual([{ provider: 'claude', name: 'Work' }])
  })

  it('shows the sign-in command, and deletes only after asking', async () => {
    replies({ 'account.list': { accounts: [{ id: 'a', provider: 'claude', name: 'Work', signedIn: false, label: null, plan: null, bots: 1 }] }, 'account.signIn': { command: "$env:CLAUDE_CONFIG_DIR='C:\\x'; claude auth login" } })
    await render(<AccountsPage runtimes={[runtime({})]} />)
    expect(document.body.textContent).toContain('Not signed in')
    await click(button('Sign in'))
    expect(document.querySelector('.account-command code')?.textContent).toContain('claude auth login')
    await click(button('Delete Work'))
    expect(called('account.delete')).toEqual([])
    await click([...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].find((item) => item.textContent?.trim() === 'Delete'))
    await flush()
    expect(called('account.delete')).toEqual([{ id: 'a', confirm: true }])
  })
})

describe('custom models', () => {
  it('checks what it can before asking the daemon', () => {
    expect(customModelProblem('', '', '')).toMatch(/Enter/)
    expect(customModelProblem('has space', '', '')).toMatch(/no spaces/)
    expect(customModelProblem('x', 'y'.repeat(81), '')).toMatch(/80/)
    expect(customModelProblem('x', '', 'a,b,c,d,e,f,g,h,i')).toMatch(/8/)
    expect(customModelProblem('gpt-x', 'GPT X', 'low, high')).toBeNull()
    expect(parseEfforts(' low, high,low,, ')).toEqual(['low', 'high'])
  })

  it('saves one with its efforts', async () => {
    replies({ 'account.list': { accounts: [] }, 'model.custom.list': { models: [] } })
    await render(<AccountsPage runtimes={[runtime({})]} />)
    await type(document.querySelector<HTMLInputElement>('input[aria-label="Model id"]')!, 'my-model')
    await type(document.querySelector<HTMLInputElement>('input[aria-label^="Effort"]')!, 'low, high')
    await click(button('Add'))
    expect(called('model.custom.save')).toEqual([{ id: null, provider: 'claude', modelId: 'my-model', label: 'my-model', efforts: ['low', 'high'] }])
  })
})

describe('secrets', () => {
  it('counts down, and stops at zero', () => {
    expect(secondsLeft(null, 0)).toBeNull()
    expect(secondsLeft('2026-10-31T12:00:50Z', Date.parse('2026-10-31T12:00:00Z'))).toBe(50)
    expect(secondsLeft('2026-10-31T12:00:00Z', Date.parse('2026-10-31T12:00:09Z'))).toBe(0)
  })

  it('checks a name', () => {
    expect(secretNameProblem('')).toMatch(/name/)
    expect(secretNameProblem('has space')).toMatch(/letters/)
    expect(secretNameProblem('x'.repeat(65))).toMatch(/64/)
    expect(secretNameProblem('GITHUB_TOKEN')).toBeNull()
  })

  it('lists names only, saves with confirm and clears the value', async () => {
    replies({ 'secret.list': { secrets: [{ name: 'GITHUB_TOKEN', updatedAt: null, usedBy: ['Rae'] }] } })
    await render(<SecretsPage />)
    expect(document.body.textContent).toContain('Used by Rae')
    await type(document.querySelector<HTMLInputElement>('input[aria-label="Secret name"]')!, 'NEW_ONE')
    const value = document.querySelector<HTMLInputElement>('input[aria-label="Secret value"]')!
    expect(value.type).toBe('password')
    await type(value, 'hunter2')
    await click(button('Save'))
    expect(called('secret.set')).toEqual([{ name: 'NEW_ONE', value: 'hunter2', confirm: true }])
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Secret value"]')!.value).toBe('')
    expect(document.body.textContent).not.toContain('hunter2')
  })

  it('a one-use request asks, sends the value once and says what happens to it', async () => {
    replies({ 'secret.request.list': { requests: [{ id: 'q', sessionId: 's', name: 'DEPLOY', reason: 'To check staging.', botName: 'Rae', expiresAt: null }] } })
    await render(<SecretRequests />)
    expect(document.body.textContent).toContain('Rae is asking for DEPLOY')
    expect(document.body.textContent).toContain('To check staging.')
    expect(document.body.textContent).toContain('For this turn only')
    expect(button('Give it for this turn').disabled).toBe(true)
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!
    expect(input.type).toBe('password')
    await type(input, 'abc123')
    await click(button('Give it for this turn'))
    expect(called('secret.request.answer')).toEqual([{ id: 'q', value: 'abc123' }])
  })

  it('declining sends no value', async () => {
    replies({ 'secret.request.list': { requests: [{ id: 'q', sessionId: 's', name: 'DEPLOY', reason: 'r', botName: 'Rae', expiresAt: null }] } })
    await render(<SecretRequests />)
    await click(button('Decline'))
    expect(called('secret.request.decline')).toEqual([{ id: 'q' }])
    expect(called('secret.request.answer')).toEqual([])
  })

  it('shows nothing with no request', async () => {
    replies({ 'secret.request.list': { requests: [] } })
    await render(<SecretRequests />)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
