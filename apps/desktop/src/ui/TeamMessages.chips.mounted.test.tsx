// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chipNeedsShowMore, DelegationChip, ReplyChip } from './TeamMessages'

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  host = null
})

function mount(node: React.ReactNode) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(node))
  return host
}

describe('delegation and reply chips', () => {
  it('starts collapsed and expands in place to the message text', async () => {
    const view = mount(<DelegationChip peer={null} name="Codex" topic="the header" text="Please review the header spacing." />)
    const chip = view.querySelector<HTMLButtonElement>('.team-chip')!
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(view.querySelector('.team-chip-panel')).toBeNull()
    await act(async () => { chip.click() })
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    const panel = view.querySelector('.team-chip-panel')!
    expect(panel.textContent).toContain('Please review the header spacing.')
    expect(panel.querySelector('.team-chip-text')?.classList.contains('clamped')).toBe(true)
    await act(async () => { chip.click() })
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(view.querySelector('.team-chip-panel')).toBeNull()
  })

  it('offers Show more only for a body long enough to be clamped', async () => {
    const shortView = mount(<DelegationChip peer={null} name="Codex" text="Short note." />)
    await act(async () => { shortView.querySelector<HTMLButtonElement>('.team-chip')!.click() })
    expect(shortView.querySelector('.team-chip-more')).toBeNull()

    const long = 'line one\nline two\nline three\nline four\nline five\nline six\nline seven'
    expect(chipNeedsShowMore(long)).toBe(true)
    const longView = mount(<DelegationChip peer={null} name="Codex" text={long} />)
    await act(async () => { longView.querySelector<HTMLButtonElement>('.team-chip')!.click() })
    const more = longView.querySelector<HTMLButtonElement>('.team-chip-more')!
    expect(more.textContent).toBe('Show more')
    await act(async () => { more.click() })
    expect(longView.querySelector('.team-chip-text')?.classList.contains('clamped')).toBe(false)
    expect(longView.querySelector('.team-chip-more')?.textContent).toBe('Show less')
  })

  it('opens the named blob conversation from the expanded link', async () => {
    const onOpen = vi.fn()
    const view = mount(<ReplyChip from={null} name="Codex" text="Here is the answer." onOpenConversation={onOpen} />)
    await act(async () => { view.querySelector<HTMLButtonElement>('.team-chip')!.click() })
    const link = view.querySelector<HTMLButtonElement>('.team-chip-link')!
    expect(link.textContent).toBe('Open Codex\u2019s conversation')
    await act(async () => { link.click() })
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('keeps a chip with no message as a disabled disclosure', () => {
    const view = mount(<DelegationChip peer={null} name="Codex" />)
    const chip = view.querySelector<HTMLButtonElement>('.team-chip')!
    expect(chip.disabled).toBe(true)
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(view.querySelector('.team-chip-panel')).toBeNull()
  })
})
