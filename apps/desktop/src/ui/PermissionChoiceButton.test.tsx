// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PermissionChoiceButton } from './PermissionChoiceButton'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('PermissionChoiceButton mounted deadline guard', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'))
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  it('disables an approval on expiry and never sends its opaque provider choice', async () => {
    const reply = vi.fn()
    const permission = { id: 'p1', status: 'pending', expiresAt: '2026-10-01T12:00:05Z', choices: ['RejectOnce'] }
    await act(async () => root.render(<PermissionChoiceButton permission={permission} choice="RejectOnce" onReply={reply}>Reject once</PermissionChoiceButton>))
    const button = host.querySelector('button')!
    expect(button.disabled).toBe(false)

    await act(async () => { vi.advanceTimersByTime(5001) })
    expect(button.disabled).toBe(true)
    await act(async () => button.click())
    expect(reply).not.toHaveBeenCalled()
  })

  it('preserves the exact choice ID for a live request', async () => {
    const reply = vi.fn()
    const permission = { id: 'p2', status: 'pending', expiresAt: '2026-10-01T12:01:00Z', choices: ['ProviderChoice/α'] }
    await act(async () => root.render(<PermissionChoiceButton permission={permission} choice="ProviderChoice/α" onReply={reply}>Continue</PermissionChoiceButton>))
    await act(async () => host.querySelector('button')!.click())
    expect(reply).toHaveBeenCalledExactlyOnceWith('ProviderChoice/α')
  })
})
