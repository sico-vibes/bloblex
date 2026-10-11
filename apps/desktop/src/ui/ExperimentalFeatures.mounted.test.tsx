// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeReview, MessageActions, MessageSearch, ShortcutSheet, UndoToasts, highlightMatch, type UndoToast } from './ExperimentalFeatures'

const h = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../tauri', () => ({ rpc: h.rpc }))
vi.mock('../blob/BlobCanvas', () => ({ BlobCanvas: () => <span /> }))
let roots: Root[] = []
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); h.rpc.mockReset() })
afterEach(() => { act(() => { for (const root of roots) root.unmount() }); roots = []; document.body.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function mount(node: ReactNode) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  act(() => root.render(node))
  return { host, render: (next: ReactNode) => act(() => root.render(next)) }
}
async function tick(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
function click(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text || b.getAttribute('aria-label') === text)
  expect(button).toBeTruthy(); act(() => button!.click())
}

describe('experimental surfaces', () => {
  it('opens the stored diff, dismisses Keep, and requests confirmation through Revert', () => {
    const file = { id: 'f', path: 'src/a.ts', turnId: 't', detail: { diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n' } }
    const onDiff = vi.fn(), onKeep = vi.fn(), onRevert = vi.fn()
    const view = mount(<ChangeReview files={[file]} dismissed={[]} onKeep={onKeep} onRevert={onRevert} onDiff={onDiff} />)
    expect(view.host.textContent).toContain('+1 / −1')
    click(view.host, 'src/a.ts'); expect(onDiff).toHaveBeenCalledWith('src/a.ts', file.detail.diff)
    click(view.host, 'Keep'); expect(onKeep).toHaveBeenCalledWith('f')
    click(view.host, 'Revert'); expect(onRevert).toHaveBeenCalledWith(file)
    view.render(<ChangeReview files={[file]} dismissed={['f']} onKeep={onKeep} onRevert={onRevert} onDiff={onDiff} />)
    expect(view.host.querySelector('section')).toBeNull()
  })
  it('copies exact text and gives older user messages Edit but no Retry', async () => {
    const copy = vi.fn().mockResolvedValue(undefined), edit = vi.fn(), retry = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
    const view = mount(<MessageActions text="Exact **text**" user latest={false} disabled={false} onEdit={edit} onRetry={retry} onError={vi.fn()} />)
    click(view.host, 'Copy message'); await tick()
    expect(copy).toHaveBeenCalledWith('Exact **text**')
    expect(view.host.querySelector('[aria-label="Retry message"]')).toBeNull()
    click(view.host, 'Edit message'); expect(edit).toHaveBeenCalledOnce()
    view.render(<MessageActions text="Exact **text**" user latest disabled={false} onEdit={edit} onRetry={retry} onError={vi.fn()} />)
    click(view.host, 'Retry message'); expect(retry).toHaveBeenCalledOnce()
  })
  it('assistant actions only offer Copy and busy Retry stays disabled', () => {
    const props = { text: 'Reply', disabled: false, onEdit: vi.fn(), onRetry: vi.fn(), onError: vi.fn() }
    const view = mount(<MessageActions {...props} user={false} latest />)
    expect(view.host.querySelectorAll('button')).toHaveLength(1)
    view.render(<MessageActions {...props} user latest disabled />)
    expect(view.host.querySelector<HTMLButtonElement>('[aria-label="Retry message"]')?.disabled).toBe(true)
  })
  it('highlights literal matches without interpreting markup', () => {
    const view = mount(<div>{highlightMatch('<script> 50%_ match', '50%_')}</div>)
    expect(view.host.querySelector('mark')?.textContent).toBe('50%_')
    expect(view.host.querySelector('script')).toBeNull()
  })
  it('searches with a bounded debounce and opens the selected normalized result by keyboard', async () => {
    const result = { messageId: 'm', sessionId: 's', blobId: null, title: 'Title', role: 'assistant', createdAt: '2026-10-10T12:00:00Z', snippet: 'A literal needle match' }
    h.rpc.mockResolvedValue({ results: [result] })
    const choose = vi.fn(), close = vi.fn()
    const view = mount(<MessageSearch agents={[]} onChoose={choose} onClose={close} />)
    const input = view.host.querySelector<HTMLInputElement>('input')!
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'needle'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) })
    await tick(200)
    expect(h.rpc).toHaveBeenCalledWith('search.messages', { query: 'needle' })
    expect(view.host.querySelector('mark')?.textContent).toBe('needle')
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(choose).toHaveBeenCalledWith(result); expect(close).toHaveBeenCalledOnce()
  })
  it('shortcut sheet closes through Esc and restores the trigger focus', async () => {
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus()
    const close = vi.fn()
    const view = mount(<ShortcutSheet speechEnabled={false} onClose={close} />)
    await tick(20)
    expect(view.host.querySelector('[role="dialog"]')?.textContent).not.toContain('Ctrl+E')
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(close).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(trigger)
  })
  it('stacks accessible toasts, cancels through Undo and expires at eight seconds', async () => {
    const undo = vi.fn().mockResolvedValue(undefined), remove = vi.fn()
    const toasts: UndoToast[] = [{ id: 'a', text: 'Archived Blob', deadline: Date.now() + 8000, undo }, { id: 'b', text: 'Deleted conversation', deadline: Date.now() + 8000, undo }]
    const view = mount(<UndoToasts toasts={toasts} onRemove={remove} onError={vi.fn()} />)
    expect(view.host.querySelectorAll('[role="status"]')).toHaveLength(2)
    click(view.host, 'Undo'); await tick()
    expect(undo).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledWith('a')
    remove.mockClear()
    await tick(7999); expect(remove).not.toHaveBeenCalled()
    await tick(1); expect(remove).toHaveBeenCalledWith('b')
  })
})
