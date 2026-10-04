// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SafeMarkdown } from './SafeMarkdown'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
afterEach(() => { if (root) act(() => root.unmount()); host?.remove() })

describe('SafeMarkdown mounted', () => {
  it('renders active content as elements but keeps HTML injection literal', () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    act(() => root.render(<SafeMarkdown text={'# title\n\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>'} onOpenLink={vi.fn()} />))
    expect(host.querySelector('h2')?.textContent).toBe('title')
    expect(host.querySelector('script, img')).toBeNull()
    expect(host.textContent).toContain('<script>alert(1)</script>')
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('opens only a valid web link through its safe opener callback', () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    const onOpenLink = vi.fn()
    act(() => root.render(<SafeMarkdown text="[web](https://example.invalid) [bad](javascript:alert(1))" onOpenLink={onOpenLink} />))
    const links = [...host.querySelectorAll<HTMLButtonElement>('button.markdown-link')]
    expect(links).toHaveLength(1)
    act(() => links[0]!.click())
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith('https://example.invalid/')
    expect(host.textContent).toContain('[bad](javascript:alert(1))')
  })
})
