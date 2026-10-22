// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SafeMarkdown, SafeMarkdownInline } from './SafeMarkdown'

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
    const links = [...host.querySelectorAll<HTMLAnchorElement>('a.markdown-link')]
    expect(links).toHaveLength(1)
    const click = new MouseEvent('click', { button: 0, bubbles: true, cancelable: true })
    act(() => links[0]!.dispatchEvent(click))
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith('https://example.invalid/')
    expect(click.defaultPrevented).toBe(true)
    expect(host.textContent).toContain('[bad](javascript:alert(1))')
  })

  it.each([
    ['SafeMarkdown', SafeMarkdown],
    ['SafeMarkdownInline', SafeMarkdownInline],
  ] as const)('%s routes pointer activations through onOpenLink', (_name, Renderer) => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    const onOpenLink = vi.fn()
    act(() => root.render(<Renderer text="[web](https://example.invalid)" onOpenLink={onOpenLink} />))
    const link = host.querySelector<HTMLAnchorElement>('a.markdown-link')!
    const url = 'https://example.invalid/'

    const middle = new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })
    act(() => link.dispatchEvent(middle))
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(url)
    expect(middle.defaultPrevented).toBe(true)

    onOpenLink.mockClear()
    const right = new MouseEvent('auxclick', { button: 2, bubbles: true, cancelable: true })
    act(() => link.dispatchEvent(right))
    expect(onOpenLink).not.toHaveBeenCalled()
    expect(right.defaultPrevented).toBe(true)

    for (const modifier of ['ctrlKey', 'metaKey'] as const) {
      onOpenLink.mockClear()
      const modified = new MouseEvent('click', { button: 0, [modifier]: true, bubbles: true, cancelable: true })
      act(() => link.dispatchEvent(modified))
      expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(url)
      expect(modified.defaultPrevented).toBe(true)
    }

    onOpenLink.mockClear()
    const plain = new MouseEvent('click', { button: 0, bubbles: true, cancelable: true })
    act(() => link.dispatchEvent(plain))
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(url)
    expect(plain.defaultPrevented).toBe(true)

    const middleDown = new MouseEvent('mousedown', { button: 1, bubbles: true, cancelable: true })
    act(() => link.dispatchEvent(middleDown))
    expect(middleDown.defaultPrevented).toBe(true)
    expect(link.getAttribute('draggable')).toBe('false')
  })
  it('turns a bare GitHub repository into a labelled link without fetching metadata', () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    const onOpenLink = vi.fn()
    act(() => root.render(<SafeMarkdown text="See https://github.com/hardbeat920/monocode." onOpenLink={onOpenLink} />))
    const link = host.querySelector<HTMLAnchorElement>('a.markdown-repo-link')!
    expect(link.textContent).toBe('GitHub · hardbeat920/monocode')
    expect(link.href).toBe('https://github.com/hardbeat920/monocode')
    expect(host.textContent?.endsWith('.')).toBe(true)
    act(() => link.click())
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(link.href)
  })

})
