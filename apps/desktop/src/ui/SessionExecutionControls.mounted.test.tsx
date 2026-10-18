// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Session } from '../types'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../tauri', () => ({ rpc }))
vi.mock('./BlobPage', () => ({ ConfirmDialog: ({ title, body, confirmLabel, onConfirm, onCancel }: { title: string; body: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void }) => <div role="dialog"><h2>{title}</h2><p>{body}</p><button onClick={onCancel}>Cancel</button><button onClick={onConfirm}>{confirmLabel}</button></div> }))

import { labelizeEffort, SessionExecutionControls } from './SessionExecutionControls'
import { resetCatalogCacheForTests } from './catalogCache'

describe('Codex catalog effort labels', () => {
  it('maps display names by Codex provider while preserving the raw effort vocabulary for other providers', () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((value) => labelizeEffort(value, 'codex'))).toEqual(['Light', 'Medium', 'High', 'Extra High', 'Max', 'Ultra'])
    expect(['low', 'medium', 'high', 'xhigh', 'max'].map((value) => labelizeEffort(value, 'claude'))).toEqual(['Low', 'Medium', 'High', 'Extra high', 'Max'])
  })
})

const catalog = { runtimeId:'runtime', provider:'claude', validated:true, fallback:false, models:[
  { id:'alpha', displayName:'Alpha', supportedThinking:['low','high'], defaultThinking:'high', serviceTiers:[], defaultServiceTier:null, variants:[], hostDependent:false, isDefault:true, group:null, availability:'offered' },
  { id:'beta', displayName:'Beta', supportedThinking:['low'], defaultThinking:'low', serviceTiers:[], defaultServiceTier:null, variants:[], hostDependent:false, isDefault:false, group:null, availability:'offered' },
] }
const agent: Agent = { id:'agent', name:'Claude', description:'', instructions:'', color:'coral', runtimeId:'runtime', model:'alpha', thinking:'high', serviceTier:null, customArgs:[], customEnv:{}, maxConcurrency:1, defaultProject:null, sortOrder:0, archived:false, createdAt:'now', updatedAt:'now' }
const session: Session = { id:'session', runtimeId:'runtime', agentId:'agent', state:'idle', modelLock:{ model:'alpha', thinking:'high' } }
const mounted: Array<{ root: Root; host: HTMLDivElement }> = []
const pointer = (type: string, x: number, id = 5) => { const event = new Event(type, { bubbles:true }); Object.defineProperties(event, { pointerId:{ value:id }, clientX:{ value:x }, clientY:{ value:14 }, button:{ value:0 } }); return event }
/** The open popover's slider, with a 320px track at the left edge of the window. */
function slider(host: HTMLElement) {
  const track = host.querySelector<HTMLElement>('[aria-label="Conversation effort"]')!
  if (track) Object.defineProperty(track, 'getBoundingClientRect', { configurable:true, value:() => ({ width:320, height:28, top:0, right:320, bottom:28, left:0, x:0, y:0, toJSON:() => ({}) }) })
  return track
}
function mount() {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(<SessionExecutionControls session={session} agent={agent} onSessionUpdated={() => undefined} onError={() => undefined} />))
  mounted.push({ root, host })
  return host
}

afterEach(() => { for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() } document.querySelector('#composer-css-test')?.remove(); vi.restoreAllMocks() })
beforeEach(() => {
  resetCatalogCacheForTests()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const style = document.createElement('style')
  style.id = 'composer-css-test'
  style.textContent = readFileSync(resolve(process.cwd(), 'src/ui/composer.css'), 'utf8')
  document.head.append(style)
})

describe('session execution controls', () => {
  it('does not append a model-default label when Codex effort is Max', async () => {
    rpc.mockResolvedValue({ ...catalog, provider: 'codex', models: [{ ...catalog.models[0], supportedThinking: ['medium', 'max'], defaultThinking: 'medium' }] })
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<SessionExecutionControls session={{ ...session, modelLock: { model: 'alpha', thinking: 'max' } }} agent={agent} onSessionUpdated={() => undefined} onError={() => undefined} />))
    mounted.push({ root, host })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click() })
    expect(host.querySelector('.session-effort-popover')?.textContent).toContain('Max')
    expect(host.querySelector('.session-effort-popover')?.textContent).not.toContain('Model default')
  })

  it('surfaces and repairs an invalid saved effort without changing the model or marking the runtime broken', async () => {
    const onError = vi.fn()
    const onSessionUpdated = vi.fn()
    rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => method === 'runtime.models' ? catalog : method === 'session.model.update' ? { session: { ...session, modelLock:{ model:params.model, thinking:params.thinking } } } : {})
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<SessionExecutionControls session={{ ...session, modelLock:{ model:'alpha', thinking:'ultra' } }} agent={agent} onSessionUpdated={onSessionUpdated} onError={onError} />)); mounted.push({ root, host })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click() })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Saved Ultra is not supported by Alpha')
    expect(host.querySelector<HTMLButtonElement>('.session-effort-recovery button')?.textContent).toContain('Use model default · High')
    expect(onError).not.toHaveBeenCalled()
    await act(async () => { host.querySelector<HTMLButtonElement>('.session-effort-recovery button')!.click(); await Promise.resolve(); await Promise.resolve() })
    expect(rpc).toHaveBeenCalledWith('session.model.update', expect.objectContaining({ sessionId:'session', model:'alpha', thinking:'high' }))
    expect(onSessionUpdated).toHaveBeenCalledWith(expect.objectContaining({ modelLock:{ model:'alpha', thinking:'high' } }))
    expect(onError).not.toHaveBeenCalled()
  })

  it('keeps model and effort separate and requires confirmation before locking a different model', async () => {
    rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'runtime.models') return catalog
      if (method === 'session.model.update') return { session: { ...session, modelLock:{ model:params.model, thinking:params.thinking } } }
      return {}
    })
    const host = mount()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(rpc).toHaveBeenCalledWith('runtime.models', { runtimeId:'runtime', sessionId:'session' })
    const model = host.querySelector<HTMLButtonElement>('.model-pill')!
    expect(model.textContent).toContain('Alpha')
    expect(model.getAttribute('aria-label')).toBe('Conversation model: Alpha')
    expect(model.textContent).not.toContain('Recommended')
    await act(async () => { host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click() })
    const effort = slider(host)
    expect(effort.getAttribute('role')).toBe('slider')
    expect(effort.getAttribute('aria-valuemin')).toBe('0')
    expect(host.querySelector('.session-effort-default')).toBeNull()
    expect(host.querySelector('.session-effort-recommended')).toBeNull()
    const chooseBeta = async () => {
      await act(async () => { model.click() })
      expect(host.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Conversation model')
      expect(host.querySelector('[role="menuitemradio"][data-value=""]')).toBeNull()
      expect(host.querySelector('[role="menuitemradio"][data-value="alpha"]')?.textContent).not.toContain('Recommended')
      expect(host.querySelector('[role="menuitemradio"][data-value="alpha"]')?.getAttribute('aria-checked')).toBe('true')
      const option = host.querySelector<HTMLElement>('[role="menuitemradio"][data-value="beta"]')!
      expect(option.textContent).toContain('Beta')
      await act(async () => { option.click() })
    }
    await chooseBeta()
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('may reset its context')
    expect(rpc).not.toHaveBeenCalledWith('session.model.update', expect.anything())
    act(() => host.querySelector<HTMLButtonElement>('[role="dialog"] button:first-of-type')!.click())
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(rpc).not.toHaveBeenCalledWith('session.model.update', expect.anything())
    await chooseBeta()
    act(() => host.querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')!.click())
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(rpc).toHaveBeenCalledWith('session.model.update', expect.objectContaining({ sessionId:'session', model:'beta', thinking:null, confirmModelChange:true }))
  })

  it('previews effort while dragging and persists only when pointer or keyboard interaction settles', async () => {
    rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => method === 'runtime.models' ? catalog : { session:{ ...session, modelLock:{ model:params.model, thinking:params.thinking } } })
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => undefined)
    const host = mount()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click() })
    const effort = slider(host)
    await act(async () => { effort.dispatchEvent(pointer('pointerdown', 300)); effort.dispatchEvent(pointer('pointermove', 20)); await Promise.resolve() })
    expect(effort.getAttribute('aria-valuetext')).toBe('Low')
    expect(host.querySelector('.session-effort-value')?.textContent).toBe('Low')
    expect(rpc.mock.calls.filter(([method]) => method === 'session.model.update')).toHaveLength(0)
    await act(async () => { effort.dispatchEvent(pointer('pointerup', 20)); await Promise.resolve(); await Promise.resolve() })
    expect(rpc).toHaveBeenLastCalledWith('session.model.update', expect.objectContaining({ sessionId:'session', model:'alpha', thinking:'low', confirmModelChange:false }))
    expect(rpc.mock.calls.filter(([method]) => method === 'session.model.update')).toHaveLength(1)
  })

  it('uses Codex track geometry for a continuous drag and commits only the released stop', async () => {
    const codexCatalog={...catalog,provider:'codex',models:[{...catalog.models[0],id:'gpt-5',displayName:'GPT 5',supportedThinking:['low','medium','high']}]}
    rpc.mockImplementation(async(method:string,params:Record<string,unknown>)=>method==='runtime.models'?codexCatalog:{session:{...session,modelLock:{model:params.model,thinking:params.thinking}}})
    vi.spyOn(HTMLElement.prototype,'setPointerCapture').mockImplementation(()=>undefined)
    const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
    act(()=>root.render(<SessionExecutionControls session={{...session,modelLock:{model:'gpt-5',thinking:'low'}}} agent={agent} onSessionUpdated={()=>undefined} onError={()=>undefined}/>));mounted.push({root,host})
    await act(async()=>{await Promise.resolve();await Promise.resolve()})
    await act(async()=>{host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click()})
    const track=slider(host)
    await act(async()=>{track.dispatchEvent(pointer('pointerdown',160));await Promise.resolve()})
    expect(track.getAttribute('aria-valuetext')).toBe('Medium')
    await act(async()=>{track.dispatchEvent(pointer('pointermove',288));await Promise.resolve()})
    expect(rpc.mock.calls.filter(([method])=>method==='session.model.update')).toHaveLength(0)
    expect(track.getAttribute('aria-valuetext')).toBe('High')
    // A move from another pointer is ignored.
    await act(async()=>{track.dispatchEvent(pointer('pointermove',10,9));await Promise.resolve()})
    expect(track.getAttribute('aria-valuetext')).toBe('High')
    await act(async()=>{track.dispatchEvent(pointer('pointerup',288));await Promise.resolve();await Promise.resolve()})
    expect(rpc).toHaveBeenCalledWith('session.model.update',expect.objectContaining({sessionId:'session',model:'gpt-5',thinking:'high'}))
    expect(rpc.mock.calls.filter(([method])=>method==='session.model.update')).toHaveLength(1)
  })

  it('cancels an unfinished drag back to its committed value and commits once on release', async () => {
    rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => method === 'runtime.models' ? catalog : { session:{ ...session, modelLock:{ model:params.model, thinking:params.thinking } } })
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => undefined)
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    const lowSession = { ...session, modelLock:{ model:'alpha', thinking:'low' } }
    act(() => root.render(<SessionExecutionControls session={lowSession} agent={agent} onSessionUpdated={() => undefined} onError={() => undefined} />)); mounted.push({ root, host })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const open = () => act(() => host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click())
    open()
    await act(async () => { slider(host).dispatchEvent(pointer('pointerdown', 300)); await Promise.resolve() })
    expect(rpc.mock.calls.filter(([method]) => method === 'session.model.update')).toHaveLength(0)
    await act(async () => { slider(host).dispatchEvent(pointer('pointercancel', 300)) })
    expect(host.querySelector('.session-effort-trigger')?.textContent).toContain('Low')
    expect(slider(host).getAttribute('aria-valuetext')).toBe('Low')
    expect(rpc.mock.calls.filter(([method]) => method === 'session.model.update')).toHaveLength(0)

    open()
    expect(host.querySelector('[aria-label="Conversation effort"]')).toBeNull()
    open()
    expect(slider(host).getAttribute('aria-valuetext')).toBe('Low')
    await act(async () => { const track = slider(host); track.dispatchEvent(pointer('pointerdown', 300)); track.dispatchEvent(pointer('pointerup', 300)); track.dispatchEvent(pointer('lostpointercapture', 300)); await Promise.resolve(); await Promise.resolve() })
    expect(rpc.mock.calls.filter(([method]) => method === 'session.model.update')).toHaveLength(1)
    expect(rpc).toHaveBeenLastCalledWith('session.model.update', expect.objectContaining({ sessionId:'session', model:'alpha', thinking:'high', confirmModelChange:false }))
  })

  it('commits a keyboard effort change once on key release', async () => {
    rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => method === 'runtime.models' ? catalog : { session:{ ...session, modelLock:{ model:params.model, thinking:params.thinking } } })
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    const lowSession = { ...session, modelLock:{ model:'alpha', thinking:'low' } }
    act(() => root.render(<SessionExecutionControls session={lowSession} agent={agent} onSessionUpdated={() => undefined} onError={() => undefined} />)); mounted.push({ root, host })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click() })
    const effort = slider(host)
    await act(async () => { effort.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true, cancelable:true })); effort.dispatchEvent(new KeyboardEvent('keyup', { key:'ArrowRight', bubbles:true, cancelable:true })); await Promise.resolve(); await Promise.resolve() })
    expect(rpc.mock.calls.filter(([method]) => method === 'session.model.update')).toHaveLength(1)
    expect(rpc).toHaveBeenLastCalledWith('session.model.update', expect.objectContaining({ sessionId:'session', model:'alpha', thinking:'high', confirmModelChange:false }))
  })

  it('keeps an in-flight save owned by session A across A to B to A and ignores its stale result', async () => {
    let resolveSave!: (value: { session: Session }) => void
    rpc.mockImplementation(async (method: string) => method === 'runtime.models' ? catalog : await new Promise((resolve) => { resolveSave = resolve }))
    const onSessionUpdated = vi.fn()
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    const a = { ...session, modelLock:{ model:'alpha', thinking:'low' } }
    const b = { ...session, id:'session-b', modelLock:{ model:'beta', thinking:'low' } }
    const render = (value: Session) => root.render(<SessionExecutionControls session={value} agent={agent} onSessionUpdated={onSessionUpdated} onError={() => undefined} />)
    act(() => render(a)); mounted.push({ root, host })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click() })
    const range = slider(host)
    await act(async () => { range.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));range.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowRight',bubbles:true,cancelable:true}));await Promise.resolve() })
    expect(rpc).toHaveBeenCalledWith('session.model.update',expect.objectContaining({sessionId:'session',thinking:'high'}))
    act(() => render(b)); await act(async () => { await Promise.resolve() })
    act(() => render(a)); await act(async () => { await Promise.resolve() })
    expect(host.querySelector<HTMLButtonElement>('.session-effort-trigger')?.disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>('.model-pill')?.disabled).toBe(true)
    await act(async () => { resolveSave({ session:{ ...a, modelLock:{model:'alpha',thinking:'high'} } }); await Promise.resolve(); await Promise.resolve() })
    expect(onSessionUpdated).not.toHaveBeenCalled()
  })

  it('keeps provider default honest when effort is unavailable and only exposes advertised values', async () => {
    rpc.mockImplementation(async (method: string) => method === 'runtime.models' ? { ...catalog, provider:'codex', models:[{ ...catalog.models[0], supportedThinking:[], defaultThinking:null }] } : {})
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<SessionExecutionControls session={{ ...session, modelLock:{ model:'alpha', thinking:null } }} agent={agent} onSessionUpdated={() => undefined} onError={() => undefined} />))
    mounted.push({ root, host })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const trigger = host.querySelector<HTMLButtonElement>('.session-effort-trigger')!
    expect(trigger.textContent).toBe('Model default')
    expect(trigger.textContent).not.toContain('Ultra')
    await act(async () => { trigger.click() })
    expect(host.textContent).toContain('This model does not report selectable effort levels')
    expect(host.querySelector('[aria-label="Conversation effort"]')).toBeNull()
    expect(rpc.mock.calls.filter(([method]) => method === 'session.model.update')).toHaveLength(0)
  })

  it('keeps a one-tier catalog at one stop without exposing an unset model or effort option', async () => {
    const single={...catalog,models:[{...catalog.models[0],supportedThinking:['low'],defaultThinking:'low'}]}
    rpc.mockImplementation(async(method:string,params:Record<string,unknown>)=>method==='runtime.models'?single:{session:{...session,modelLock:{model:params.model,thinking:params.thinking}}})
    const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
    act(()=>root.render(<SessionExecutionControls session={{...session,modelLock:{model:'alpha',thinking:'low'}}} agent={agent} onSessionUpdated={()=>undefined} onError={()=>undefined}/>));mounted.push({root,host})
    await act(async()=>{await Promise.resolve();await Promise.resolve()})
    await act(async()=>{host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click()})
    expect(slider(host).getAttribute('aria-valuemax')).toBe('0')
    expect(host.querySelectorAll('.session-effort-tick')).toHaveLength(1)
    expect(host.querySelector('.session-effort-default')).toBeNull()
    expect(host.querySelector('[role="menuitemradio"][data-value=""]')).toBeNull()
  })

  it('labels the catalog value xhigh as Extra high while preserving its raw value for updates', async () => {
    const catalogWithXhigh = { ...catalog, provider:'codex', models:[{ ...catalog.models[0], supportedThinking:['low','medium','high','xhigh'] }] }
    rpc.mockImplementation(async (method: string) => method === 'runtime.models' ? catalogWithXhigh : {})
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<SessionExecutionControls session={{ ...session, modelLock:{ model:'alpha', thinking:'high' } }} agent={agent} onSessionUpdated={() => undefined} onError={() => undefined} />))
    mounted.push({ root, host })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(host.querySelector('.session-effort-trigger')?.textContent).toContain('High')
    await act(async () => { host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click() })
    const option = [...host.querySelectorAll<HTMLButtonElement>('.session-effort-labels button')].find((button) => button.textContent === 'Extra High')!
    await act(async () => { option.click(); await Promise.resolve(); await Promise.resolve() })
    expect(rpc).toHaveBeenCalledWith('session.model.update', expect.objectContaining({ sessionId:'session', model:'alpha', thinking:'xhigh', confirmModelChange:false }))
  })

  it('uses the saved session lock over changed blob defaults and drops a pending warning on session switch', async () => {
    rpc.mockImplementation(async (method: string) => method === 'runtime.models' ? catalog : {})
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    const render = (current: Session) => root.render(<SessionExecutionControls session={current} agent={{ ...agent, model:'beta', thinking:'low' }} onSessionUpdated={() => undefined} onError={() => undefined} />)
    act(() => render(session)); mounted.push({ root, host })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(host.querySelector('.model-pill')?.textContent).toContain('Alpha')
    expect(host.querySelector('.session-effort-trigger')?.textContent).toContain('High')

    const model = host.querySelector<HTMLButtonElement>('.model-pill')!
    await act(async () => { model.click() })
    await act(async () => { host.querySelector<HTMLElement>('[role="menuitemradio"][data-value="beta"]')!.click() })
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()
    await act(async () => { render({ ...session, id:'session-2', modelLock:{ model:'beta', thinking:'low' } }); await Promise.resolve() })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(host.querySelector('.model-pill')?.textContent).toContain('Beta')
    expect(rpc.mock.calls.filter(([method]) => method === 'session.model.update')).toHaveLength(0)
  })

  it('rolls an effort draft back after failure and does not deliver an old save into a newly selected session', async () => {
    let rejectUpdate = true
    const onError = vi.fn()
    const onSessionUpdated = vi.fn()
    rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'runtime.models') return catalog
      if (method === 'session.model.update' && rejectUpdate) throw new Error('save failed')
      return { session: { ...session, id: String(params.sessionId), modelLock:{ model:params.model, thinking:params.thinking } } }
    })
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    const render = (current: Session) => root.render(<SessionExecutionControls session={current} agent={agent} onSessionUpdated={onSessionUpdated} onError={onError} />)
    act(() => render(session)); mounted.push({ root, host })
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click() })
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => undefined)
    const input = slider(host)
    await act(async () => { input.dispatchEvent(pointer('pointerdown', 10)); input.dispatchEvent(pointer('pointerup', 10)); await Promise.resolve(); await Promise.resolve() })
    expect(onError).toHaveBeenCalledOnce()
    expect(onSessionUpdated).not.toHaveBeenCalled()
    expect(host.querySelector('.session-effort-trigger')?.textContent).toContain('High')

    rejectUpdate = false
    const nextSession: Session = { ...session, id:'session-2', modelLock:{ model:'alpha', thinking:'high' } }
    await act(async () => { render(nextSession); await Promise.resolve(); await Promise.resolve() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click() })
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.session-effort-labels button')].find((button) => button.textContent === 'Low')!.click(); await Promise.resolve(); await Promise.resolve() })
    expect(onSessionUpdated).toHaveBeenCalledWith(expect.objectContaining({ id:'session-2' }))
    expect(rpc.mock.calls.filter(([method]) => method === 'session.model.update').at(-1)?.[1]).toMatchObject({ sessionId:'session-2' })
  })
})

describe('session execution labels', () => {
  it('shows Pick a model and the effort placeholder until a model is chosen', async () => {
    rpc.mockImplementation(async (method: string) => method === 'runtime.models' ? catalog : {})
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<SessionExecutionControls session={{ ...session, modelLock: { model: null } }} agent={agent} onSessionUpdated={() => undefined} onError={() => undefined} />))
    mounted.push({ root, host })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const model = host.querySelector<HTMLButtonElement>('.model-pill')!
    expect(model.textContent).toContain('Pick a model')
    expect(model.getAttribute('title')).toBe('Choose which model this conversation uses')
    const effort = host.querySelector<HTMLButtonElement>('.session-effort-trigger')!
    expect(effort.textContent).toBe('Effort')
    expect(effort.getAttribute('aria-disabled')).toBe('true')
    expect(document.body.querySelector('.tip-bubble')?.textContent).toBe('Available after you pick a model')
  })

  it('shows each effort level with its icon and no sub-text', async () => {
    rpc.mockImplementation(async (method: string) => method === 'runtime.models' ? { ...catalog, models: [{ ...catalog.models[0], supportedThinking: ['low', 'medium', 'high', 'xhigh', 'max'] }] } : {})
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<SessionExecutionControls session={{ ...session, modelLock: { model: 'alpha', thinking: 'high' } }} agent={agent} onSessionUpdated={() => undefined} onError={() => undefined} />))
    mounted.push({ root, host })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click() })
    const levels = [...host.querySelectorAll<HTMLButtonElement>('.session-effort-labels button')].map((button) => ({ name: button.textContent, icon: !!button.querySelector('.effort-icon'), description: button.getAttribute('aria-description') }))
    expect(levels).toEqual([
      { name: 'Low', icon: true, description: null },
      { name: 'Medium', icon: true, description: null },
      { name: 'High', icon: true, description: null },
      { name: 'Extra high', icon: true, description: null },
      { name: 'Max', icon: true, description: null },
    ])
    expect(host.querySelector('.session-effort-level-note')).toBeNull()
    expect(host.querySelector('.session-effort-trigger .effort-icon')).not.toBeNull()
  })
})

describe('effort availability', () => {
  it('keeps one downward chevron and rotates it only while the effort menu is open', async () => {
    rpc.mockImplementation(async (method: string) => method === 'runtime.models' ? catalog : {})
    const host = mount()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const trigger = host.querySelector<HTMLButtonElement>('.session-effort-trigger')!
    const closedIcon = trigger.querySelector<SVGSVGElement>('.composer-pill-chevron')!
    const closedPath = closedIcon.querySelector('path')?.getAttribute('d')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { trigger.click() })
    const openIcon = trigger.querySelector<SVGSVGElement>('.composer-pill-chevron')!
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(openIcon.querySelector('path')?.getAttribute('d')).toBe(closedPath)
    expect(getComputedStyle(openIcon).transform).toBe('rotate(180deg)')
  })

  it('greys out effort with a tooltip while the runtime keeps it behind an execution check', async () => {
    rpc.mockImplementation(async (method: string) => method === 'runtime.models' ? { ...catalog, provider:'opencode' } : method === 'runtime.capabilities' ? { settings:{ thinking:{ supported:true, enabled:false } } } : {})
    const host = mount()
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    const trigger = host.querySelector<HTMLButtonElement>('.session-effort-trigger')!
    expect(trigger.getAttribute('aria-disabled')).toBe('true')
    expect(document.body.querySelector('.tip-bubble')?.textContent).toContain("OpenCode doesn't let Bitbots pick an effort level")
    await act(async () => { trigger.click() })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('offers Ultra and Ultracode as the last stop with their own labels', async () => {
    const ultra = { ...catalog, models:[{ ...catalog.models[0], supportedThinking:['low','medium','high','xhigh','max','ultracode'], defaultThinking:'medium' }] }
    rpc.mockImplementation(async (method: string) => method === 'runtime.models' ? ultra : {})
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<SessionExecutionControls session={{ ...session, modelLock:{ model:'alpha', thinking:'ultracode' } }} agent={agent} onSessionUpdated={() => undefined} onError={() => undefined} />)); mounted.push({ root, host })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(host.querySelector('.session-effort-trigger')?.textContent).toBe('Ultracode')
    await act(async () => { host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click() })
    expect(host.querySelector('.session-effort-value')?.textContent).toBe('Ultracode')
    expect(host.querySelector('.session-effort-note')?.textContent).toContain('Extra high with dynamic workflows enabled for this session')
    expect(host.querySelectorAll('.session-effort-tick')).toHaveLength(6)
    expect(host.querySelector('.session-effort-recommended')).toBeNull()
  })

  it('explains that the workflow preference does not change an existing session captured with workflows off', async () => {
    rpc.mockImplementation(async (method: string) => method === 'runtime.models' ? { ...catalog, models:[{ ...catalog.models[0], supportedThinking:['low','medium','high','xhigh','max'] }] } : {})
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<SessionExecutionControls session={{ ...session, modelLock:{ model:'alpha', thinking:'max', enableWorkflows:false } }} agent={agent} onSessionUpdated={() => undefined} onError={() => undefined} />)); mounted.push({ root, host })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click() })
    expect(host.querySelector('.session-effort-note')?.textContent).toContain('Bitbots did not enable workflows for this conversation')
    expect(host.querySelector('.session-effort-note')?.textContent).toContain('new conversations')
  })
})
