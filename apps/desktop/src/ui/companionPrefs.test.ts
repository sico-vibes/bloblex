import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyFocusMode, focusMode, focusModeFromSettings, FOCUS_MODE_KEY, resetFocusMode, saveFocusMode, subscribeFocusMode } from './companionPrefs'

vi.mock('../tauri', () => ({ rpc: vi.fn(async () => ({})) }))
vi.mock('../transport/nativeBridge', () => ({ emitNative: vi.fn(async () => undefined) }))

afterEach(() => { resetFocusMode() })

describe('companion focus mode', () => {
  it('reads only a true boolean from either settings shape', () => {
    expect(focusModeFromSettings({ settings: { [FOCUS_MODE_KEY]: true } })).toBe(true)
    expect(focusModeFromSettings({ [FOCUS_MODE_KEY]: true })).toBe(true)
    expect(focusModeFromSettings({ settings: { [FOCUS_MODE_KEY]: 'true' } })).toBe(false)
    expect(focusModeFromSettings({ settings: {} })).toBe(false)
    expect(focusModeFromSettings(null)).toBe(false)
  })

  it('notifies subscribers only when the value changes', () => {
    const seen: boolean[] = []
    const stop = subscribeFocusMode((value) => seen.push(value))
    applyFocusMode(true)
    applyFocusMode(true)
    applyFocusMode(false)
    stop()
    expect(seen).toEqual([true, false])
    expect(focusMode()).toBe(false)
  })

  it('saves through the daemon and tells the other window', async () => {
    const { rpc } = await import('../tauri')
    const { emitNative } = await import('../transport/nativeBridge')
    await saveFocusMode(true)
    expect(rpc).toHaveBeenCalledWith('settings.set', { key: FOCUS_MODE_KEY, value: true })
    expect(emitNative).toHaveBeenCalledWith('bloblex-companion-focus-changed', true)
    expect(focusMode()).toBe(true)
  })
})
