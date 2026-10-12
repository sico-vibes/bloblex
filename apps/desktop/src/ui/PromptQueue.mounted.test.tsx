// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueuedPrompt } from '../types'
import { QueueBanner, SendLaterControl } from './PromptQueue'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = new Date(2026, 9, 12, 10, 0, 0).getTime()
const item = (partial: Partial<QueuedPrompt> & Pick<QueuedPrompt, 'id' | 'text'>): QueuedPrompt => ({
  sessionId: 's1', kind: 'user', dueAt: null, status: 'queued', error: null, position: 0, ...partial,
})

let root: Root
let host: HTMLDivElement
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
const render = (node: ReactNode) => act(() => { root.render(node) })
const q = <T extends Element>(selector: string) => host.querySelector<T>(selector)
const click = (element: Element | null | undefined) => act(() => { (element as HTMLElement).click() })

function banner(items: QueuedPrompt[], extra: Partial<ComponentProps<typeof QueueBanner>> = {}) {
  const handlers = { onSendNow: vi.fn(), onDelete: vi.fn(), onUpdate: vi.fn(), onReorder: vi.fn(), onResume: vi.fn() }
  render(<QueueBanner items={items} paused={false} sessionBusy nowMs={NOW} {...handlers} {...extra} />)
  return handlers
}

describe('QueueBanner', () => {
  it('renders nothing for an empty queue', () => {
    banner([])
    expect(q('.queue-banner')).toBeNull()
  })

  it('lists messages with scheduled times and offers send-next, delete and reorder', () => {
    const items = [
      item({ id: 'a', text: 'first', position: 0 }),
      item({ id: 'b', text: 'second', position: 1 }),
      item({ id: 'c', text: 'later', kind: 'send_later', dueAt: new Date(NOW + 14 * 60_000).toISOString(), position: 2 }),
    ]
    const handlers = banner(items)
    expect(q('.queue-banner')?.getAttribute('aria-label')).toBe('Queued messages: 3')
    expect([...host.querySelectorAll('.queue-text')].map((node) => node.textContent)).toEqual(['first', 'second', 'later'])
    expect(q('.queue-meta')?.textContent).toBe('in 14 min')
    const rows = [...host.querySelectorAll('li')]
    click(rows[1].querySelector('[aria-label="Move up"]'))
    expect(handlers.onReorder).toHaveBeenCalledWith(['b', 'a'])
    expect(rows[0].querySelector('[aria-label="Move up"]')).toBeNull()
    click(rows[0].querySelector('[aria-label="Send next"]'))
    expect(handlers.onSendNow).toHaveBeenCalledWith('a')
    click(rows[1].querySelector('[aria-label="Remove from queue"]'))
    expect(handlers.onDelete).toHaveBeenCalledWith('b')
    // Scheduled items are not part of the manual order.
    expect(rows[2].querySelector('[aria-label="Move up"]')).toBeNull()
    expect(rows[2].querySelector('[aria-label="Move down"]')).toBeNull()
  })

  it('says "Send now" instead of "Send next" when the conversation is idle', () => {
    banner([item({ id: 'a', text: 'hello' })], { sessionBusy: false })
    expect(q('[aria-label="Send now"]')).not.toBeNull()
    expect(q('[aria-label="Send next"]')).toBeNull()
  })

  it('shows a paused queue with a Resume action and failed rows with their reason', () => {
    const handlers = banner([
      item({ id: 'a', text: 'broken', status: 'failed', error: 'Conversation is archived.' }),
      item({ id: 'b', text: 'waiting' }),
    ], { paused: true, sessionBusy: false })
    expect(q('.queue-paused')?.textContent).toContain('a message could not be sent')
    expect(q('.queue-item.failed .queue-meta')?.textContent).toBe('Conversation is archived.')
    expect(q('.queue-item.failed [aria-label="Try again"]')).not.toBeNull()
    click([...host.querySelectorAll('.queue-link')].find((node) => node.textContent === 'Resume'))
    expect(handlers.onResume).toHaveBeenCalledOnce()
  })

  it('edits a queued message inline, saves on Enter and cancels on Escape', () => {
    const handlers = banner([item({ id: 'a', text: 'draft one' })])
    click(q('[aria-label="Edit queued message"]'))
    const input = q<HTMLInputElement>('input.queue-edit')!
    expect(input.value).toBe('draft one')
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => { setValue.call(input, 'draft two'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(handlers.onUpdate).toHaveBeenCalledWith('a', 'draft two')
    expect(q('input.queue-edit')).toBeNull()
    click(q('[aria-label="Edit queued message"]'))
    act(() => { q<HTMLInputElement>('input.queue-edit')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(handlers.onUpdate).toHaveBeenCalledTimes(1)
  })

  it('shows an automatic retry as a timed row that cancels through its own action', () => {
    const onCancelRetry = vi.fn()
    const onDelete = vi.fn()
    banner([item({ id: 'r1', text: 'Please continue.', kind: 'retry', dueAt: new Date(NOW + 5 * 60_000).toISOString() })], { onCancelRetry, onDelete })
    expect(q('.queue-text')?.textContent).toBe('Continue automatically')
    expect(q('.queue-meta')?.textContent).toBe('retrying in 5 min')
    expect(q('[aria-label="Edit queued message"]')).toBeNull()
    expect(q('[aria-label="Move up"]')).toBeNull()
    click(q('[aria-label="Cancel automatic retry"]'))
    expect(onCancelRetry).toHaveBeenCalledOnce()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('shows three rows and expands the rest', () => {
    banner(Array.from({ length: 5 }, (_, index) => item({ id: `m${index}`, text: `msg ${index}`, position: index })))
    expect(host.querySelectorAll('.queue-item')).toHaveLength(3)
    click(q('.queue-more'))
    expect(host.querySelectorAll('.queue-item')).toHaveLength(5)
  })
})

describe('SendLaterControl', () => {
  it('offers presets that return an ISO time and validates a custom time', () => {
    const onSchedule = vi.fn()
    render(<SendLaterControl disabled={false} nowMs={NOW} onSchedule={onSchedule} />)
    click(q('[aria-label="Send later"]'))
    expect(q('.send-later-menu')?.textContent).toContain('Sends only while Bloblex is running')
    const labels = [...host.querySelectorAll('[role="menuitem"] strong')].map((node) => node.textContent)
    expect(labels).toEqual(['In 15 minutes', 'In 1 hour', 'In 3 hours', 'Tomorrow morning'])
    click(host.querySelectorAll('[role="menuitem"]')[1])
    expect(onSchedule).toHaveBeenCalledWith(new Date(NOW + 60 * 60_000).toISOString())
    expect(q('.send-later-menu')).toBeNull()

    click(q('[aria-label="Send later"]'))
    click(q('.send-later-custom button'))
    expect(q('[role="alert"]')?.textContent).toBe('Pick a date and time.')
    expect(onSchedule).toHaveBeenCalledTimes(1)
  })

  it('is disabled when there is nothing to send', () => {
    render(<SendLaterControl disabled nowMs={NOW} onSchedule={vi.fn()} />)
    expect(q<HTMLButtonElement>('[aria-label="Send later"]')?.disabled).toBe(true)
  })
})
