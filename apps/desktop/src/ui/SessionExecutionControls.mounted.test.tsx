// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Session } from '../types'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../tauri', () => ({ rpc }))
vi.mock('./BlobPage', () => ({ ConfirmDialog: ({ title, body, confirmLabel, onConfirm, onCancel }: { title: string; body: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void }) => <div role="dialog"><h2>{title}</h2><p>{body}</p><button onClick={onCancel}>Cancel</button><button onClick={onConfirm}>{confirmLabel}</button></div> }))

import { SessionExecutionControls } from './SessionExecutionControls'

const catalog = { runtimeId:'runtime', provider:'claude', validated:true, fallback:false, models:[
  { id:'alpha', displayName:'Alpha', supportedThinking:['low','high'], defaultThinking:'high', serviceTiers:[], defaultServiceTier:null, variants:[], hostDependent:false, isDefault:true, group:null, availability:'offered' },
  { id:'beta', displayName:'Beta', supportedThinking:['low'], defaultThinking:'low', serviceTiers:[], defaultServiceTier:null, variants:[], hostDependent:false, isDefault:false, group:null, availability:'offered' },
] }
const agent: Agent = { id:'agent', name:'Claude', description:'', instructions:'', color:'coral', runtimeId:'runtime', model:'alpha', thinking:'high', serviceTier:null, customArgs:[], customEnv:{}, maxConcurrency:1, defaultProject:null, sortOrder:0, archived:false, createdAt:'now', updatedAt:'now' }
const session: Session = { id:'session', runtimeId:'runtime', agentId:'agent', state:'idle', modelLock:{ model:'alpha', thinking:'high' } }
const mounted: Array<{ root: Root; host: HTMLDivElement }> = []
function mount() {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(<SessionExecutionControls session={session} agent={agent} onSessionUpdated={() => undefined} onError={() => undefined} />))
  mounted.push({ root, host })
  return host
}

afterEach(() => { for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() } vi.restoreAllMocks() })
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })

describe('session execution controls', () => {
  it('keeps model and effort separate and requires confirmation before locking a different model', async () => {
    rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'runtime.models') return catalog
      if (method === 'session.model.update') return { session: { ...session, modelLock:{ model:params.model, thinking:params.thinking } } }
      return {}
    })
    const host = mount()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const model = host.querySelector<HTMLSelectElement>('[aria-label="Conversation model"]')!
    const effort = host.querySelector<HTMLInputElement>('[aria-label="Conversation effort"]')!
    expect(model.value).toBe('alpha')
    expect(effort.type).toBe('range')
    expect(effort.getAttribute('min')).toBe('-1')
    act(() => { model.value = 'beta'; model.dispatchEvent(new Event('change', { bubbles:true })) })
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('may start a new context')
    expect(rpc).not.toHaveBeenCalledWith('session.model.update', expect.anything())
    act(() => host.querySelector<HTMLButtonElement>('[role="dialog"] button:first-of-type')!.click())
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(rpc).not.toHaveBeenCalledWith('session.model.update', expect.anything())
    act(() => { model.value = 'beta'; model.dispatchEvent(new Event('change', { bubbles:true })) })
    act(() => host.querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')!.click())
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(rpc).toHaveBeenCalledWith('session.model.update', expect.objectContaining({ sessionId:'session', model:'beta', thinking:null, confirmModelChange:true }))
  })
})
