// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageActions, MessageReactionBadges } from './MessageActions'

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

describe('message toolbar copy feedback', () => {
  it('confirms a copy with a check mark and announces it, then goes back to the copy icon', async () => {
    vi.useFakeTimers()
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
    await act(async () => root!.render(<MessageActions text="hello" time="07:47 PM" onReply={vi.fn()} onToggleReaction={vi.fn()} onError={vi.fn()} />))
    expect(host.querySelector('.message-action-time')?.textContent).toBe('07:47 PM')
    await act(async () => { host!.querySelector<HTMLButtonElement>('[aria-label="Copy message text"]')!.click(); await Promise.resolve() })
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Copied"]')?.classList.contains('copied')).toBe(true)
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Copied to clipboard')
    await act(async () => { vi.advanceTimersByTime(1600) })
    expect(host.querySelector('[aria-label="Copy message text"]')).not.toBeNull()
  })
})

describe('message reaction badge', () => {
  it('shows one reaction and lets you take it back', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    const onRemove = vi.fn()
    await act(async () => root!.render(<MessageReactionBadges reactions={['👍', '❤️']} onRemove={onRemove} />))
    const badges = host.querySelectorAll('.message-reaction-badge')
    expect(badges).toHaveLength(1)
    expect(badges[0].textContent).toBe('👍')
    await act(async () => { (badges[0] as HTMLButtonElement).click() })
    expect(onRemove).toHaveBeenCalledWith('👍')
  })

  it('is only a mark when nothing can remove it, and absent without a reaction', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(<MessageReactionBadges reactions={['😮']} />))
    expect(host.querySelector('button.message-reaction-badge')).toBeNull()
    expect(host.querySelector('span.message-reaction-badge')?.getAttribute('aria-label')).toBe('Your reaction: Surprised')
    await act(async () => root!.render(<MessageReactionBadges reactions={[]} />))
    expect(host.querySelector('.message-reaction-badge')).toBeNull()
  })
})
