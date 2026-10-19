// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

const nativeBridge = vi.hoisted(() => ({
  isNative: vi.fn<() => boolean>(),
  invokeNative: vi.fn<(command: string, args: { url: string }) => Promise<unknown>>(),
}))

vi.mock('../transport/nativeBridge', () => nativeBridge)

import { openSafeLink } from './openSafeLink'

afterEach(() => {
  vi.restoreAllMocks()
  nativeBridge.isNative.mockReset()
  nativeBridge.invokeNative.mockReset()
})

describe('openSafeLink', () => {
  it('does not fall back to window.open when the native opener rejects', async () => {
    nativeBridge.isNative.mockReturnValue(true)
    nativeBridge.invokeNative.mockRejectedValue(new Error('native opener unavailable'))
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

    await openSafeLink('https://example.invalid/path')

    expect(nativeBridge.invokeNative).toHaveBeenCalledExactlyOnceWith('plugin:opener|open_url', { url: 'https://example.invalid/path' })
    expect(open).not.toHaveBeenCalled()
  })

  it('uses window.open in browser preview with the normalized href', async () => {
    nativeBridge.isNative.mockReturnValue(false)
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

    await openSafeLink('https://example.invalid')

    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.invalid/', '_blank', 'noopener,noreferrer')
    expect(nativeBridge.invokeNative).not.toHaveBeenCalled()
  })

  it.each([
    'javascript:alert(1)',
    'https://user:secret@example.invalid/path',
  ])('rejects unsafe URL %s before either opener path', async (url) => {
    nativeBridge.isNative.mockReturnValue(false)
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)

    await openSafeLink(url)

    expect(open).not.toHaveBeenCalled()
    expect(nativeBridge.invokeNative).not.toHaveBeenCalled()
    expect(nativeBridge.isNative).not.toHaveBeenCalled()
  })
})
