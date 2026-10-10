// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './BlobPage'

const mounted: Array<{ root: Root; host: HTMLDivElement }> = []
function mount(onConfirm: () => void | Promise<void>, onCancel = vi.fn(), onComplete: (() => void) | null = vi.fn(), copy?: { successTitle:string; successBody:string }) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(<ConfirmDialog title="Delete conversation?" body="The transcript in Bloblex will be removed." confirmLabel="Delete" cancelLabel="Cancel" holdToConfirm onConfirm={onConfirm} onCancel={onCancel} {...(onComplete ? { onComplete } : {})} {...copy} />))
  mounted.push({ root, host })
  return host
}

afterEach(() => { for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() } vi.useRealTimers(); vi.unstubAllGlobals() })

describe('destructive hold confirmation', () => {
  it('cancels on pointer and keyboard release, then confirms completed pointer and keyboard holds with reduced motion', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches:true, media:'(prefers-reduced-motion: reduce)', addEventListener:vi.fn(), removeEventListener:vi.fn() })))
    const confirm = vi.fn()
    vi.spyOn(HTMLButtonElement.prototype, 'setPointerCapture').mockImplementation(() => undefined)
    const host = mount(confirm)
    const button = host.querySelector<HTMLButtonElement>('.hold-confirm-button')!
    expect(button.getAttribute('aria-describedby')).toBe('hold-confirm-hint')
    expect(host.textContent).toContain('Press and hold for one second. Releasing early cancels.')
    const pointer = (type: string) => { const event = new Event(type,{bubbles:true}); Object.defineProperty(event,'pointerId',{value:1}); return event }
    await act(async () => { button.dispatchEvent(pointer('pointerdown')); await vi.advanceTimersByTimeAsync(400); button.dispatchEvent(pointer('pointerup')); await vi.advanceTimersByTimeAsync(500) })
    expect(confirm).not.toHaveBeenCalled()
    await act(async () => { button.dispatchEvent(pointer('pointerdown')); await vi.advanceTimersByTimeAsync(1050); button.dispatchEvent(pointer('pointerup')) })
    expect(confirm).toHaveBeenCalledOnce()

    const keyboardConfirm = vi.fn()
    const keyboardHost = mount(keyboardConfirm)
    const keyboardButton = keyboardHost.querySelector<HTMLButtonElement>('.hold-confirm-button')!
    await act(async () => { keyboardButton.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true })); await vi.advanceTimersByTimeAsync(400); keyboardButton.dispatchEvent(new KeyboardEvent('keyup', { key:'Enter', bubbles:true })); await vi.advanceTimersByTimeAsync(500) })
    expect(keyboardConfirm).not.toHaveBeenCalled()
    await act(async () => { keyboardButton.dispatchEvent(new KeyboardEvent('keydown', { key:' ', bubbles:true })); await vi.advanceTimersByTimeAsync(1050); keyboardButton.dispatchEvent(new KeyboardEvent('keyup', { key:' ', bubbles:true })) })
    expect(keyboardConfirm).toHaveBeenCalledOnce()
  })

  it('cancels armed holds on pointercancel, Escape, and window blur', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const confirm = vi.fn()
    vi.spyOn(HTMLButtonElement.prototype, 'setPointerCapture').mockImplementation(() => undefined)
    const host = mount(confirm)
    const button = host.querySelector<HTMLButtonElement>('.hold-confirm-button')!
    const pointer = (type: string) => { const event = new Event(type,{bubbles:true}); Object.defineProperty(event,'pointerId',{value:4}); return event }
    await act(async () => { button.dispatchEvent(pointer('pointerdown')); await vi.advanceTimersByTimeAsync(1100); button.dispatchEvent(pointer('pointercancel')) })
    expect(confirm).not.toHaveBeenCalled()
    expect(button.textContent).toContain('Hold to delete')
    expect(button.classList.contains('holding')).toBe(false)
    await act(async () => { button.dispatchEvent(pointer('pointerdown')); await vi.advanceTimersByTimeAsync(1100); window.dispatchEvent(new Event('blur')) })
    expect(confirm).not.toHaveBeenCalled()
    await act(async () => { button.dispatchEvent(pointer('pointerdown')); await vi.advanceTimersByTimeAsync(1100); host.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true })) })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('waits for the async action, morphs only after success, and leaves a failed action retryable', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches:true, media:'(prefers-reduced-motion: reduce)', addEventListener:vi.fn(), removeEventListener:vi.fn() })))
    vi.spyOn(HTMLButtonElement.prototype, 'setPointerCapture').mockImplementation(() => undefined)
    let rejectFirst!: (error: Error) => void
    const confirm = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject }))
      .mockResolvedValue(undefined)
    const onComplete = vi.fn()
    const onCancel = vi.fn()
    const host = mount(confirm, onCancel, onComplete, { successTitle:'Conversation deleted', successBody:'Saved messages were removed.' })
    const pointer = (type: string) => { const event = new Event(type,{bubbles:true}); Object.defineProperty(event,'pointerId',{value:9}); return event }
    const hold = async () => {
      const button = host.querySelector<HTMLButtonElement>('.hold-confirm-button')!
      await act(async () => { button.dispatchEvent(pointer('pointerdown')); await vi.advanceTimersByTimeAsync(1050); button.dispatchEvent(pointer('pointerup')); await Promise.resolve() })
    }
    await hold()
    expect(confirm).toHaveBeenCalledOnce()
    expect(host.querySelector('.hold-confirm-success')).toBeNull()
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('true')
    expect(host.querySelector<HTMLButtonElement>('.secondary-button')?.disabled).toBe(true)
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true })) })
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()
    expect(onCancel).not.toHaveBeenCalled()
    await act(async () => { rejectFirst(new Error('The conversation is no longer available.')); await Promise.resolve(); await Promise.resolve() })
    expect(host.querySelector('.hold-confirm-success')).toBeNull()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('no longer available')
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBeNull()

    await hold()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(host.querySelector('.hold-confirm-success')).not.toBeNull()
    expect(host.querySelector('.hold-confirm-success h2')?.textContent).toBe('Conversation deleted')
    expect(host.querySelector('.hold-confirm-success p')?.textContent).toBe('Saved messages were removed.')
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    expect(document.activeElement).toBe(host.querySelector('.hold-confirm-success button'))
    expect(onComplete).not.toHaveBeenCalled()
    act(() => host.querySelector<HTMLButtonElement>('.hold-confirm-success button')!.click())
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('uses onCancel as the close fallback when a completed hold has no onComplete callback', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches:true, media:'(prefers-reduced-motion: reduce)', addEventListener:vi.fn(), removeEventListener:vi.fn() })))
    vi.spyOn(HTMLButtonElement.prototype, 'setPointerCapture').mockImplementation(() => undefined)
    const cancel = vi.fn()
    const host = mount(vi.fn().mockResolvedValue(undefined), cancel, null)
    const button = host.querySelector<HTMLButtonElement>('.hold-confirm-button')!
    const pointer = (type: string) => { const event = new Event(type,{bubbles:true}); Object.defineProperty(event,'pointerId',{value:11}); return event }
    await act(async () => { button.dispatchEvent(pointer('pointerdown')); await vi.advanceTimersByTimeAsync(1050); button.dispatchEvent(pointer('pointerup')); await Promise.resolve() })
    expect(host.querySelector('.hold-confirm-success')).not.toBeNull()
    act(() => host.querySelector<HTMLButtonElement>('.hold-confirm-success button')!.click())
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('links panel and matched copy with WAAPI only after an async delete resolves', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches:false, media:'(prefers-reduced-motion: no-preference)', addEventListener:vi.fn(), removeEventListener:vi.fn() })))
    vi.spyOn(window,'requestAnimationFrame').mockImplementation((callback)=>{callback(0);return 1})
    const animations:Array<{element:HTMLElement;keyframes:Keyframe[];options:KeyframeAnimationOptions;finish:()=>void;cancel:ReturnType<typeof vi.fn>}>=[]
    vi.spyOn(HTMLElement.prototype, 'animate').mockImplementation(function(this:HTMLElement,keyframes:Keyframe[]|PropertyIndexedKeyframes|null,options?:number|KeyframeAnimationOptions){
      let finish!:()=>void
      const finished=new Promise<Animation>((resolve)=>{finish=()=>resolve({} as Animation)})
      const cancel=vi.fn()
      const animation={finished,cancel,pause:vi.fn(),play:vi.fn(),currentTime:0} as unknown as Animation
      animations.push({element:this,keyframes:(keyframes??[]) as Keyframe[],options:(typeof options==='number'?{duration:options}:options??{}),finish,cancel})
      return animation
    })
    vi.spyOn(HTMLButtonElement.prototype, 'setPointerCapture').mockImplementation(() => undefined)
    let resolve!: () => void
    const complete = vi.fn()
    const host = mount(() => new Promise<void>((done) => { resolve=done }), vi.fn(), complete, { successTitle:'Conversation deleted', successBody:'Saved messages were removed.' })
    const button = host.querySelector<HTMLButtonElement>('.hold-confirm-button')!
    const pointer = (type:string) => { const event=new Event(type,{bubbles:true});Object.defineProperty(event,'pointerId',{value:21});return event }
    await act(async()=>{button.dispatchEvent(pointer('pointerdown'));await vi.advanceTimersByTimeAsync(1050);button.dispatchEvent(pointer('pointerup'));await Promise.resolve()})
    expect(HTMLElement.prototype.animate).not.toHaveBeenCalled()
    await act(async()=>{resolve();await Promise.resolve();await Promise.resolve()})
    expect(animations.length).toBeGreaterThanOrEqual(7)
    const panel=animations.find((animation)=>animation.element.matches('[role="dialog"]'))!
    expect(panel.options).toEqual(expect.objectContaining({duration:300,easing:'cubic-bezier(0.22, 1, 0.36, 1)',fill:'both'}))
    expect(panel.keyframes[0]).toEqual(expect.objectContaining({left:expect.any(String),top:expect.any(String),width:expect.any(String),height:expect.any(String),borderRadius:expect.any(String),boxShadow:expect.any(String)}))
    const title=animations.find((animation)=>animation.element.matches('[data-morph="title"]'))!
    const body=animations.find((animation)=>animation.element.matches('[data-morph="body"]'))!
    const done=animations.find((animation)=>animation.element.matches('[data-morph="done"]'))!
    expect(title.options?.duration).toBe(150)
    expect(body.options?.duration).toBe(150)
    expect(done.options?.duration).toBe(150)
    expect(done.keyframes[0].transform).toContain('scale(')
    expect(animations.filter((animation)=>animation.element.dataset.morphGhost).some((animation)=>animation.options.duration===80&&animation.keyframes[1].opacity===0)).toBe(true)
    expect(host.querySelector('.hold-confirm-success')).not.toBeNull()
    expect(host.querySelector<HTMLButtonElement>('.hold-confirm-success button')?.disabled).toBe(true)
    await act(async()=>{panel.finish();await Promise.resolve();await Promise.resolve();await vi.advanceTimersByTimeAsync(20)})
    expect(host.querySelector<HTMLButtonElement>('.hold-confirm-success button')?.disabled).toBe(false)
    expect(document.activeElement).toBe(host.querySelector('.hold-confirm-success button'))
    act(()=>host.querySelector<HTMLButtonElement>('.hold-confirm-success button')!.click())
    expect(complete).toHaveBeenCalledOnce()
    expect(panel.cancel).toHaveBeenCalled()
  })
})
