// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CreatedBotChip, DelegationChip, ReplyChip } from './TeamMessages'

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
  it('opens the conversation between the two bots in one click', async () => {
    const onOpen = vi.fn()
    const view = mount(<DelegationChip peer={null} name="Codex" topic="the header" text="Please review the header spacing." onOpenConversation={onOpen} />)
    const chip = view.querySelector<HTMLButtonElement>('.team-chip')!
    expect(chip.getAttribute('aria-label')).toBe('Messaged Codex about the header. Open the conversation')
    expect(chip.getAttribute('title')).toBe('Please review the header spacing.')
    expect(chip.hasAttribute('aria-expanded')).toBe(false)
    await act(async () => { chip.click() })
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('opens a relayed reply the same way', async () => {
    const onOpen = vi.fn()
    const view = mount(<ReplyChip from={null} name="Codex" text="Here is the answer." onOpenConversation={onOpen} />)
    await act(async () => { view.querySelector<HTMLButtonElement>('.team-chip')!.click() })
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('stays disabled when there is no conversation to open', () => {
    const view = mount(<DelegationChip peer={null} name="Codex" />)
    expect(view.querySelector<HTMLButtonElement>('.team-chip')!.disabled).toBe(true)
  })
})

describe('created-bot chip', () => {
  it('shows the new bot by name with its role and opens it', async () => {
    const onOpen = vi.fn()
    const view = mount(<CreatedBotChip agent={null} name="Dex" detail="Engineer · crewspan" onOpen={onOpen} />)
    const chip = view.querySelector<HTMLButtonElement>('.team-chip.created')!
    expect(chip.textContent).toContain('Dex')
    expect(chip.textContent).toContain('Engineer · crewspan')
    expect(chip.getAttribute('aria-label')).toBe('Created bot Dex, Engineer · crewspan. Open Dex')
    await act(async () => { chip.click() })
    expect(onOpen).toHaveBeenCalledOnce()
  })
})
