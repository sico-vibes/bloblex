// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalCard } from './ApprovalCard'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
afterEach(() => { if (root) act(() => root.unmount()); host?.remove() })

function mount(node: ReactNode) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); act(() => root.render(node))
}

describe('ApprovalCard keyboard choices', () => {
  it('approves with Enter and denies with Escape from the focused card', async () => {
    const reply = vi.fn()
    mount(<ApprovalCard permission={{ id: 'p', choices: ['AllowOnce', 'RejectOnce'] }} onReply={reply} />)
    const card = host.querySelector('[data-permission-card]') as HTMLElement
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)) })
    expect(document.activeElement).toBe(card)
    act(() => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    act(() => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(reply).toHaveBeenCalledOnce()
    expect(reply).toHaveBeenLastCalledWith('AllowOnce')
    await act(async () => root.render(<ApprovalCard permission={{ id: 'p2', choices: ['AllowOnce', 'RejectOnce'] }} onReply={reply} />))
    const nextCard = host.querySelector('[data-permission-card]') as HTMLElement
    act(() => nextCard.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(reply).toHaveBeenLastCalledWith('RejectOnce')
  })

  it('does not catch typing in the composer', () => {
    const reply = vi.fn()
    mount(<><textarea data-composer="" /><ApprovalCard permission={{ id: 'p', choices: ['Allow', 'Deny'] }} onReply={reply} focusOnMount={false} /></>)
    const composer = host.querySelector('textarea')!
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(reply).not.toHaveBeenCalled()
  })

  it('allows a keyboard retry after the reply fails', async () => {
    const reply = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    mount(<ApprovalCard permission={{ id: 'p', choices: ['Allow', 'Deny'] }} onReply={reply} />)
    const card = host.querySelector('[data-permission-card]') as HTMLElement
    act(() => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    await act(async () => { await Promise.resolve() })
    act(() => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(reply).toHaveBeenCalledTimes(2)
  })
})
