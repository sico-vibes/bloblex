// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const experimentsCss = readFileSync(resolve(process.cwd(), 'src/ui/experiments.css'), 'utf8')

describe('message action toolbar', () => {
  it('lists Copy, Quote, Retry and React in one order everywhere', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    const onReply = vi.fn(), onRetry = vi.fn(), onToggleReaction = vi.fn().mockResolvedValue({})
    await act(async () => root!.render(<MessageActions text="Original **markdown**" reactions={['❤️']} onReply={onReply} onRetry={onRetry} onToggleReaction={onToggleReaction} onError={vi.fn()} />))
    const toolbar = host.querySelector('[role="toolbar"]')!
    expect([...toolbar.querySelectorAll<HTMLButtonElement>('button')].map((button) => button.getAttribute('aria-label'))).toEqual(['Copy message text', 'Quote message', 'Retry this turn', 'React to message'])
    await act(async () => { toolbar.querySelector<HTMLButtonElement>('[aria-label="Quote message"]')!.click() })
    expect(onReply).toHaveBeenCalledOnce()
    await act(async () => { toolbar.querySelector<HTMLButtonElement>('[aria-label="Retry this turn"]')!.click() })
    expect(onRetry).toHaveBeenCalledOnce()
    const reaction = host.querySelector<HTMLButtonElement>('[aria-label="React to message"]')!
    await act(async () => { reaction.click(); await Promise.resolve() })
    expect(document.querySelectorAll('[role="dialog"][aria-label="Choose a reaction"] .message-reaction-option')).toHaveLength(6)
    expect(document.querySelector('[aria-label="Remove your heart reaction"]')?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => { (document.querySelector('[aria-label="Add your celebration reaction"]') as HTMLButtonElement).click(); await Promise.resolve() })
    expect(onToggleReaction).toHaveBeenCalledWith('🎉')
    expect(reaction.getAttribute('aria-expanded')).toBe('false')
  })

  it('reserves the retry slot for a message that cannot be retried', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(<MessageActions text="Old reply" onReply={vi.fn()} onToggleReaction={vi.fn()} onError={vi.fn()} />))
    const toolbar = host.querySelector('[role="toolbar"]')!
    expect(toolbar.querySelector('[aria-label="Retry this turn"]')).toBeNull()
    expect(toolbar.querySelector('.message-action-slot')).not.toBeNull()
    expect([...toolbar.querySelectorAll<HTMLButtonElement>('button')].map((button) => button.getAttribute('aria-label'))).toEqual(['Copy message text', 'Quote message', 'React to message'])
  })

  it('reveals on keyboard focus with 32 px targets and never shifts layout', () => {
    expect(experimentsCss).toMatch(/\.message-action-shell:focus-within \.message-actions\s*\{[^}]*opacity:\s*1/)
    expect(experimentsCss).toMatch(/\.message-action-button\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px/)
    expect(experimentsCss).toMatch(/\.message-action-slot\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px/)
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
