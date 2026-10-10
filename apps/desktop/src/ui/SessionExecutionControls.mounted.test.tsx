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
    const model = host.querySelector<HTMLButtonElement>('.model-pill')!
    expect(model.textContent).toContain('Alpha')
    expect(model.getAttribute('aria-label')).toBe('Conversation model: Alpha')
    expect(model.textContent).not.toContain('Recommended')
    await act(async () => { host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click() })
    const effort = host.querySelector<HTMLInputElement>('[aria-label="Conversation effort"]')!
    expect(effort.type).toBe('range')
    expect(effort.getAttribute('min')).toBe('0')
    expect(host.querySelector('.session-effort-footer button')?.textContent).toBe('Provider default')
    const chooseBeta = async () => {
      await act(async () => { model.click() })
      expect(host.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Conversation model')
      expect(host.querySelector('[role="menuitemradio"][data-value=""]')?.textContent).toContain('Provider default')
      expect(host.querySelector('[role="menuitemradio"][data-value="alpha"]')?.textContent).toContain('Recommended')
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
    vi.spyOn(HTMLInputElement.prototype, 'setPointerCapture').mockImplementation(() => undefined)
    const host = mount()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click() })
    const effort = host.querySelector<HTMLInputElement>('[aria-label="Conversation effort"]')!
    const setRange = (value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(effort, value)
      effort.dispatchEvent(new Event('input', { bubbles:true }))
    }
    await act(async () => {
      effort.dispatchEvent(new Event('pointerdown', { bubbles:true }))
      setRange('0')
      await Promise.resolve()
    })
    expect(rpc.mock.calls.filter(([method]) => method === 'session.model.update')).toHaveLength(0)
    await act(async () => { effort.dispatchEvent(new Event('pointerup', { bubbles:true })); await Promise.resolve(); await Promise.resolve() })
    expect(rpc).toHaveBeenLastCalledWith('session.model.update', expect.objectContaining({ sessionId:'session', model:'alpha', thinking:'low', confirmModelChange:false }))

    expect(rpc.mock.calls.filter(([method]) => method === 'session.model.update')).toHaveLength(1)
  })

  it('uses Codex track geometry for a continuous drag and commits only the released stop', async () => {
    const codexCatalog={...catalog,provider:'codex',models:[{...catalog.models[0],id:'gpt-5',displayName:'GPT 5',supportedThinking:['low','medium','high']}]}
    rpc.mockImplementation(async(method:string,params:Record<string,unknown>)=>method==='runtime.models'?codexCatalog:{session:{...session,modelLock:{model:params.model,thinking:params.thinking}}})
    vi.spyOn(HTMLInputElement.prototype,'setPointerCapture').mockImplementation(()=>undefined)
    const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
    act(()=>root.render(<SessionExecutionControls session={{...session,modelLock:{model:'gpt-5',thinking:'low'}}} agent={agent} onSessionUpdated={()=>undefined} onError={()=>undefined}/>));mounted.push({root,host})
    await act(async()=>{await Promise.resolve();await Promise.resolve()})
    await act(async()=>{host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click()})
    const track=host.querySelector<HTMLElement>('.session-effort-track')!
    Object.defineProperty(track,'getBoundingClientRect',{configurable:true,value:()=>({width:320,height:28,top:0,right:320,bottom:28,left:0,x:0,y:0,toJSON:()=>({})})})
    const range=host.querySelector<HTMLInputElement>('[aria-label="Conversation effort"]')!
    const pointer=(type:string,x:number)=>{const event=new Event(type,{bubbles:true});Object.defineProperties(event,{pointerId:{value:5},clientX:{value:x},clientY:{value:14},button:{value:0}});return event}
    await act(async()=>{range.dispatchEvent(pointer('pointerdown',160));range.dispatchEvent(pointer('pointermove',288));await Promise.resolve()})
    expect(rpc.mock.calls.filter(([method])=>method==='session.model.update')).toHaveLength(0)
    expect(range.getAttribute('aria-valuetext')).toBe('High')
    await act(async()=>{range.dispatchEvent(pointer('pointerup',288));await Promise.resolve();await Promise.resolve()})
    expect(rpc).toHaveBeenCalledWith('session.model.update',expect.objectContaining({sessionId:'session',model:'gpt-5',thinking:'high'}))
    expect(rpc.mock.calls.filter(([method])=>method==='session.model.update')).toHaveLength(1)
  })

  it('cancels an unfinished drag back to its committed value and commits once on release', async () => {
    rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => method === 'runtime.models' ? catalog : { session:{ ...session, modelLock:{ model:params.model, thinking:params.thinking } } })
    vi.spyOn(HTMLInputElement.prototype, 'setPointerCapture').mockImplementation(() => undefined)
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    const lowSession = { ...session, modelLock:{ model:'alpha', thinking:'low' } }
    act(() => root.render(<SessionExecutionControls session={lowSession} agent={agent} onSessionUpdated={() => undefined} onError={() => undefined} />)); mounted.push({ root, host })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const open = () => act(() => host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click())
    const effort = () => host.querySelector<HTMLInputElement>('[aria-label="Conversation effort"]')!
    const setRange = (value: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(effort(), value); effort().dispatchEvent(new Event('input', { bubbles:true })) }
    open()
    await act(async () => { effort().dispatchEvent(new Event('pointerdown', { bubbles:true })); setRange('1'); await Promise.resolve() })
    expect(rpc.mock.calls.filter(([method]) => method === 'session.model.update')).toHaveLength(0)
    await act(async () => { effort().dispatchEvent(new Event('pointercancel', { bubbles:true })) })
    expect(host.querySelector('.session-effort-trigger')?.textContent).toContain('Low')
    expect(rpc.mock.calls.filter(([method]) => method === 'session.model.update')).toHaveLength(0)

    open()
    expect(host.querySelector('[aria-label="Conversation effort"]')).toBeNull()
    open()
    expect(effort().getAttribute('aria-valuetext')).toBe('Low')
    await act(async () => { effort().dispatchEvent(new Event('pointerdown', { bubbles:true })); setRange('1'); effort().dispatchEvent(new Event('pointerup', { bubbles:true })); effort().dispatchEvent(new Event('lostpointercapture', { bubbles:true })); await Promise.resolve(); await Promise.resolve() })
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
    const effort = host.querySelector<HTMLInputElement>('[aria-label="Conversation effort"]')!
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
    const range = host.querySelector<HTMLInputElement>('[aria-label="Conversation effort"]')!
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
    expect(trigger.textContent).toBe('Default')
    expect(trigger.textContent).not.toContain('Ultra')
    await act(async () => { trigger.click() })
    expect(host.textContent).toContain('This model does not report selectable effort levels')
    expect(host.querySelector('[aria-label="Conversation effort"]')).toBeNull()
    expect(rpc.mock.calls.filter(([method]) => method === 'session.model.update')).toHaveLength(0)
  })

  it('keeps a one-tier catalog at one stop and offers provider default as a separate reset', async () => {
    const single={...catalog,models:[{...catalog.models[0],supportedThinking:['low'],defaultThinking:'low'}]}
    rpc.mockImplementation(async(method:string,params:Record<string,unknown>)=>method==='runtime.models'?single:{session:{...session,modelLock:{model:params.model,thinking:params.thinking}}})
    const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
    act(()=>root.render(<SessionExecutionControls session={{...session,modelLock:{model:'alpha',thinking:'low'}}} agent={agent} onSessionUpdated={()=>undefined} onError={()=>undefined}/>));mounted.push({root,host})
    await act(async()=>{await Promise.resolve();await Promise.resolve()})
    await act(async()=>{host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click()})
    const range=host.querySelector<HTMLInputElement>('[aria-label="Conversation effort"]')!
    expect(range.getAttribute('aria-valuemax')).toBe('0')
    expect(host.querySelectorAll('.session-effort-labels button')).toHaveLength(1)
    expect(host.querySelector('.session-effort-footer button')?.textContent).toBe('Provider default')
    await act(async()=>{host.querySelector<HTMLButtonElement>('.session-effort-footer button')!.click();await Promise.resolve();await Promise.resolve()})
    expect(rpc).toHaveBeenCalledWith('session.model.update',expect.objectContaining({model:'alpha',thinking:null}))
  })

  it('labels the catalog value xhigh as Extra high while preserving its raw value for updates', async () => {
    const catalogWithXhigh = { ...catalog, models:[{ ...catalog.models[0], supportedThinking:['low','medium','high','xhigh'] }] }
    rpc.mockImplementation(async (method: string) => method === 'runtime.models' ? catalogWithXhigh : {})
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<SessionExecutionControls session={{ ...session, modelLock:{ model:'alpha', thinking:'high' } }} agent={agent} onSessionUpdated={() => undefined} onError={() => undefined} />))
    mounted.push({ root, host })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(host.querySelector('.session-effort-trigger')?.textContent).toContain('High')
    await act(async () => { host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click() })
    const option = [...host.querySelectorAll<HTMLButtonElement>('.session-effort-labels button')].find((button) => button.textContent === 'Extra high')!
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
    const input = host.querySelector<HTMLInputElement>('[aria-label="Conversation effort"]')!
    const setRange = (value: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles:true })) }
    await act(async () => { input.dispatchEvent(new Event('pointerdown', { bubbles:true })); setRange('0'); input.dispatchEvent(new Event('pointerup', { bubbles:true })); await Promise.resolve(); await Promise.resolve() })
    expect(onError).toHaveBeenCalledOnce()
    expect(onSessionUpdated).not.toHaveBeenCalled()
    expect(host.querySelector('.session-effort-trigger')?.textContent).toContain('High')

    rejectUpdate = false
    const nextSession: Session = { ...session, id:'session-2', modelLock:{ model:'alpha', thinking:'high' } }
    await act(async () => { render(nextSession); await Promise.resolve(); await Promise.resolve() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.session-effort-trigger')!.click() })
    await act(async () => { host.querySelector<HTMLButtonElement>('.session-effort-labels button:first-child')!.click(); await Promise.resolve(); await Promise.resolve() })
    expect(onSessionUpdated).toHaveBeenCalledWith(expect.objectContaining({ id:'session-2' }))
    expect(rpc.mock.calls.filter(([method]) => method === 'session.model.update').at(-1)?.[1]).toMatchObject({ sessionId:'session-2' })
  })
})
