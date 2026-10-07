// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationOutline, outlineItemsFromMessages } from './ConversationOutline'
import type { JsonRecord } from '../types'

const mounted: Array<{ root: Root; host: HTMLDivElement }> = []
const raw = [
  { id:'u1', value:{ role:'user', turnId:'t1', content:'Please inspect the project structure.' } },
  { id:'tool1', value:{ role:'assistant', toolName:'read_file', content:'src/app.ts' } },
  { id:'a1', value:{ role:'assistant', turnId:'t1', content:'The app has one main route and three feature modules.' } },
  { id:'u2', value:{ role:'user', turnId:'t2', content:'Now explain the entry point.' } },
  { id:'a2', value:{ role:'assistant', turnId:'t2', content:'The entry point mounts the React shell.' } },
] satisfies Array<{ id: string; value: JsonRecord }>
const items = outlineItemsFromMessages(raw, 'Codex')

function mount(nextItems = items, sessionId = 's1') {
  const host = document.createElement('div'); document.body.append(host)
  const list = document.createElement('section'); list.className = 'message-list'; host.append(list)
  const root = createRoot(host)
  const render = (values = nextItems, id = sessionId) => root.render(<section className="message-list">{values.map((item) => <article key={item.anchor} id={item.anchor} />)}<ConversationOutline items={values} sessionId={id} /></section>)
  act(() => render())
  const actualList = host.querySelector('.message-list')!
  mounted.push({ root, host })
  return { host, actualList, render }
}

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('matchMedia', vi.fn(() => ({ matches:true }))) })
afterEach(() => { for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() } vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('conversation outline', () => {
  it('pairs actual user and assistant previews and excludes tool activity', () => {
    expect(items).toHaveLength(4)
    expect(items[0]).toMatchObject({ role:'You', userText:'Please inspect the project structure.', assistantText:'The app has one main route and three feature modules.' })
    expect(items[2]).toMatchObject({ role:'You', userText:'Now explain the entry point.', assistantText:'The entry point mounts the React shell.' })
  })

  it('does not pair unanswered prompts across a later user turn and describes previews by role', () => {
    const values = outlineItemsFromMessages([
      { id:'u-open', value:{ role:'user', content:'First unanswered prompt.' } },
      { id:'a-other', value:{ role:'assistant', turnId:'known-turn', content:'This belongs to another turn.' } },
      { id:'u-next', value:{ role:'user', content:'Second prompt.' } },
      { id:'a-next', value:{ role:'assistant', content:'Reply to the second prompt.' } },
    ], 'Assistant')
    expect(values[0]).toMatchObject({ userText:'First unanswered prompt.', assistantText:undefined })
    expect(values[2]).toMatchObject({ userText:'Second prompt.', assistantText:'Reply to the second prompt.' })
    const view = mount(values)
    const slider = view.host.querySelector<HTMLElement>('[role="slider"]')!
    expect(slider.getAttribute('aria-valuetext')).toContain('You:')
  })

  it('keeps hover preview separate from scroll active and navigates even at the current index', async () => {
    const { host } = mount()
    const track = host.querySelector<HTMLDivElement>('[role="slider"]')!
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ top:0, bottom:200, left:0, right:20, width:20, height:200, x:0, y:0, toJSON:() => ({}) })
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined)
    const pointer = (type: string, y: number) => { const event = new Event(type, { bubbles:true, cancelable:true }); Object.defineProperties(event, { pointerId:{ value:7 }, clientY:{ value:y } }); return event }
    await act(async () => { track.dispatchEvent(pointer('pointermove', 175)) })
    expect(track.getAttribute('aria-valuenow')).toBe('1')
    expect(host.querySelector('.conversation-outline-preview')?.textContent).toContain('Now explain the entry point.')
    expect(host.querySelector('.conversation-outline-preview')?.textContent).toContain('The entry point mounts the React shell.')
    expect(scroll).not.toHaveBeenCalled()

    await act(async () => { track.dispatchEvent(pointer('pointerdown', 0)); track.dispatchEvent(pointer('pointerup', 0)) })
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block:'center', behavior:'auto' }))
    expect(scroll).toHaveBeenCalledTimes(1)
  })

  it('keeps the preview through the source 80ms mouse leave and 1400ms touch settle windows',async()=>{
    vi.useFakeTimers()
    const {host}=mount()
    const nav=host.querySelector('nav.conversation-outline')!
    const track=host.querySelector<HTMLDivElement>('[role="slider"]')!
    track.blur()
    const event=(type:string,pointerType:string,extra:Record<string,number>={})=>new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:3,pointerType,clientY:20,...extra})
    await act(async()=>{track.dispatchEvent(event('pointermove','mouse'))})
    await act(async()=>{nav.dispatchEvent(event('pointerout','mouse'));await vi.advanceTimersByTimeAsync(79)})
    expect(host.querySelector('.conversation-outline-preview')).not.toBeNull()
    await act(async()=>{await vi.advanceTimersByTimeAsync(1)})
    expect(host.querySelector('.conversation-outline-preview')).toBeNull()
    await act(async()=>{track.dispatchEvent(event('pointermove','touch'))})
    expect(host.querySelector('.conversation-outline-preview')).not.toBeNull()
    const timers=vi.spyOn(window,'setTimeout')
    await act(async()=>{track.dispatchEvent(event('pointerdown','touch'));track.dispatchEvent(event('pointerup','touch'))})
    expect(timers.mock.calls.map((call)=>call[1])).toContain(1400)
    await act(async()=>{await vi.advanceTimersByTimeAsync(1399)})
    expect(host.querySelector('.conversation-outline-preview')).not.toBeNull()
    await act(async()=>{await vi.advanceTimersByTimeAsync(1)})
    expect(host.querySelector('.conversation-outline-preview')).toBeNull()
  })

  it('clamps after messages shrink and resets its position when the session changes', async () => {
    const { host, render } = mount()
    const track = host.querySelector<HTMLDivElement>('[role="slider"]')!
    await act(async () => { track.dispatchEvent(new KeyboardEvent('keydown', { key:'End', bubbles:true, cancelable:true })) })
    expect(track.getAttribute('aria-valuenow')).toBe('4')
    await act(async () => { render(items.slice(0, 2), 's1') })
    expect(host.querySelector('[role="slider"]')?.getAttribute('aria-valuenow')).toBe('2')
    const smaller = items.slice(0, 2)
    await act(async () => { render(smaller, 's2') })
    expect(host.querySelector('[role="slider"]')?.getAttribute('aria-valuenow')).toBe('1')
  })
})
