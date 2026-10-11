// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageActions } from './MessageActions'

let root: Root | null = null
let host: HTMLDivElement | null = null
let originalClipboard: PropertyDescriptor | undefined

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  host = null
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
  originalClipboard = undefined
  vi.restoreAllMocks()
})

describe('message action toolbar', () => {
  it('keeps exactly Reaction, Reply and Copy visible; selection toggles the local reaction', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    const onReply = vi.fn(), onToggleReaction = vi.fn().mockResolvedValue({})
    await act(async () => root!.render(<MessageActions text="Original **markdown**" reactions={['❤️']} onReply={onReply} onToggleReaction={onToggleReaction} onError={vi.fn()} />))
    const toolbar = host.querySelector('[role="toolbar"]')!
    expect(toolbar.querySelectorAll(':scope > button, :scope > div > button')).toHaveLength(3)
    expect(toolbar.querySelector('[aria-label="Copy request ID"]')).toBeNull()
    const reaction = host.querySelector<HTMLButtonElement>('[aria-label="React to message"]')!
    await act(async () => { reaction.click(); await Promise.resolve() })
    expect(document.querySelectorAll('[role="dialog"][aria-label="Choose a reaction"] .message-reaction-option')).toHaveLength(6)
    expect(document.querySelector('[aria-label="Remove your heart reaction"]')?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => { (document.querySelector('[aria-label="Add your celebration reaction"]') as HTMLButtonElement).click(); await Promise.resolve() })
    expect(onToggleReaction).toHaveBeenCalledWith('🎉')
    expect(reaction.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { host!.querySelector<HTMLButtonElement>('[aria-label="Reply to message"]')!.click() })
    expect(onReply).toHaveBeenCalledOnce()
  })

  it('supports keyboard opening, arrow navigation, Escape restoration and exact-text copy', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    const writeText = vi.fn().mockResolvedValue(undefined)
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await act(async () => root!.render(<MessageActions text={'Rich **content**\nwith code'} onReply={vi.fn()} onToggleReaction={vi.fn()} onError={vi.fn()} />))
    const reaction = host.querySelector<HTMLButtonElement>('[aria-label="React to message"]')!
    reaction.focus()
    await act(async () => { reaction.click(); await Promise.resolve() })
    const first = document.querySelector<HTMLButtonElement>('.message-reaction-option')!
    expect(document.activeElement).toBe(first)
    await act(async () => { first.dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowRight', bubbles:true })); await Promise.resolve() })
    expect(document.activeElement).toBe(document.querySelectorAll('.message-reaction-option')[1])
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true })); await Promise.resolve() })
    expect(document.activeElement).toBe(reaction)
    await act(async () => { host!.querySelector<HTMLButtonElement>('[aria-label="Copy message text"]')!.click(); await Promise.resolve() })
    expect(writeText).toHaveBeenCalledExactlyOnceWith('Rich **content**\nwith code')
  })
})
