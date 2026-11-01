// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { PrivateEmail } from './PrivateEmail'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
afterEach(() => { act(() => root.unmount()); host.remove() })
const mount = (text: string) => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); act(() => root.render(<PrivateEmail text={text} />)) }

describe('PrivateEmail', () => {
  it('starts blurred and reveals on a click, then hides again', () => {
    mount('work@example.com')
    const button = host.querySelector('button')!
    expect(button.classList.contains('revealed')).toBe(false)
    expect(button.getAttribute('aria-label')).toBe('Reveal email')
    act(() => button.click())
    expect(button.classList.contains('revealed')).toBe(true)
    expect(button.getAttribute('aria-label')).toBe('Hide email')
    act(() => button.click())
    expect(button.classList.contains('revealed')).toBe(false)
  })

  it('leaves anything that is not an email as plain text', () => {
    mount('Signed in')
    expect(host.querySelector('button')).toBeNull()
    expect(host.textContent).toBe('Signed in')
  })
})
