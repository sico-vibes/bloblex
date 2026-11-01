// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { Keys } from './Keys'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
afterEach(() => { act(() => root.unmount()); host.remove() })
const caps = (keys: string) => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); act(() => root.render(<Keys keys={keys} />)); return [...host.querySelectorAll('kbd')].map((key) => key.textContent) }

describe('Keys', () => {
  it('gives each key its own cap', () => expect(caps('Ctrl+Shift+F')).toEqual(['Ctrl', 'Shift', 'F']))
  it('keeps a plus that is itself the key', () => expect(caps('Ctrl++')).toEqual(['Ctrl', '+']))
  it('shows alternatives side by side', () => expect(caps('Ctrl+K / ⌘K')).toEqual(['Ctrl', 'K', '⌘K']))
})
