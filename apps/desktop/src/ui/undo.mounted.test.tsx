// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UndoToasts } from './ExperimentalFeatures'
import { removeUndoToast, resetUndoToasts, useUndoToasts, useUndoable } from './undo'

vi.mock('../tauri', () => ({ rpc: vi.fn() }))
vi.mock('../blob/BlobCanvas', () => ({ BlobCanvas: () => <span /> }))

let roots: Root[] = []
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); resetUndoToasts() })
afterEach(() => { act(() => { for (const root of roots) root.unmount() }); roots = []; document.body.innerHTML = ''; resetUndoToasts(); vi.useRealTimers(); vi.unstubAllGlobals() })
function mount(node: ReactNode) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  act(() => root.render(node))
  return { host, render: (next: ReactNode) => act(() => root.render(next)) }
}
async function tick(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
function click(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)
  expect(button).toBeTruthy()
  act(() => button!.click())
}

function Harness({ log }: { log: (entry: string) => void }) {
  const archive = useUndoable<[string]>(async (name) => log('do:archive:' + name), async (name) => log('undo:archive:' + name), (name) => `Archived '${name}'.`)
  const remove = useUndoable<[string]>(async (name) => log('do:delete:' + name), async (name) => log('undo:delete:' + name), (name) => `Deleted '${name}'.`)
  const rename = useUndoable<[string, string]>(async (a, b) => log('do:rename:' + a + ':' + b), async (a, b) => log('undo:rename:' + a + ':' + b), (a, b) => `Renamed '${a}' to '${b}'.`)
  const move = useUndoable<[string, string]>(async (a, b) => log('do:move:' + a + ':' + b), async (a, b) => log('undo:move:' + a + ':' + b), (a, b) => `Moved '${a}' to ${b}.`)
  const project = useUndoable<[string]>(async (name) => log('do:project:' + name), async (name) => log('undo:project:' + name), (name) => `Deleted project '${name}'.`)
  const toasts = useUndoToasts()
  return <>
    <button onClick={() => void archive('One')}>archive</button>
    <button onClick={() => void remove('Two')}>delete</button>
    <button onClick={() => void rename('Old', 'New')}>rename</button>
    <button onClick={() => void move('Blob', 'Work')}>move</button>
    <button onClick={() => void project('Proj')}>project</button>
    <UndoToasts toasts={toasts} onRemove={removeUndoToast} onError={() => undefined} />
  </>
}

const CASES: Array<[button: string, toast: string, did: string, undid: string]> = [
  ['archive', "Archived 'One'.", 'do:archive:One', 'undo:archive:One'],
  ['delete', "Deleted 'Two'.", 'do:delete:Two', 'undo:delete:Two'],
  ['rename', "Renamed 'Old' to 'New'.", 'do:rename:Old:New', 'undo:rename:Old:New'],
  ['move', "Moved 'Blob' to Work.", 'do:move:Blob:Work', 'undo:move:Blob:Work'],
  ['project', "Deleted project 'Proj'.", 'do:project:Proj', 'undo:project:Proj'],
]

describe('useUndoable', () => {
  it.each(CASES)('%s action shows its toast and Undo reverses it', async (button, toast, did, undid) => {
    const log = vi.fn()
    const view = mount(<Harness log={log} />)
    await act(async () => { click(view.host, button); await Promise.resolve() })
    expect(log).toHaveBeenCalledWith(did)
    expect(view.host.querySelector('.undo-toast')?.textContent).toContain(toast)
    click(view.host, 'Undo')
    await tick()
    expect(log).toHaveBeenCalledWith(undid)
    expect(view.host.querySelector('.undo-toast')).toBeNull()
  })

  it('dismisses with Escape without undoing', async () => {
    const log = vi.fn()
    const view = mount(<Harness log={log} />)
    await act(async () => { click(view.host, 'archive'); await Promise.resolve() })
    const toast = view.host.querySelector<HTMLElement>('.undo-toast')!
    act(() => toast.focus())
    act(() => toast.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(view.host.querySelector('.undo-toast')).toBeNull()
    expect(log.mock.calls.some(([entry]) => String(entry).startsWith('undo:'))).toBe(false)
  })

  it('pauses the timer while focused and resumes on blur', async () => {
    const log = vi.fn()
    const view = mount(<Harness log={log} />)
    await act(async () => { click(view.host, 'archive'); await Promise.resolve() })
    const toast = view.host.querySelector<HTMLElement>('.undo-toast')!
    act(() => toast.focus())
    await tick(5000)
    expect(view.host.querySelector('.undo-toast')).not.toBeNull()
    act(() => toast.blur())
    await tick(7999)
    expect(view.host.querySelector('.undo-toast')).not.toBeNull()
    await tick(1)
    expect(view.host.querySelector('.undo-toast')).toBeNull()
  })

  it('pauses the timer while hovered', async () => {
    const log = vi.fn()
    const view = mount(<Harness log={log} />)
    await act(async () => { click(view.host, 'archive'); await Promise.resolve() })
    const toast = view.host.querySelector<HTMLElement>('.undo-toast')!
    act(() => toast.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await tick(5000)
    expect(view.host.querySelector('.undo-toast')).not.toBeNull()
    act(() => toast.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    await tick(7999)
    expect(view.host.querySelector('.undo-toast')).not.toBeNull()
    await tick(1)
    expect(view.host.querySelector('.undo-toast')).toBeNull()
  })
})
