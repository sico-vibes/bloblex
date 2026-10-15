// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { Skeleton } from './Skeleton'

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  host = null
})

function mount(node: ReactNode) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(node))
  return host
}

describe('Skeleton', () => {
  it('renders the requested number of blocks for the default text variant', () => {
    const view = mount(<Skeleton lines={3} />)
    const skeleton = view.querySelector('.skeleton')!
    expect(skeleton.classList.contains('skeleton-text')).toBe(true)
    expect(skeleton.getAttribute('aria-hidden')).toBe('true')
    expect(view.querySelectorAll('.skeleton-block')).toHaveLength(3)
  })

  it('supports row and pill variants and clamps to at least one block', () => {
    const row = mount(<Skeleton variant="row" lines={4} />)
    expect(row.querySelector('.skeleton-row')).not.toBeNull()
    expect(row.querySelectorAll('.skeleton-block')).toHaveLength(4)
    const pill = mount(<Skeleton variant="pill" lines={0} />)
    expect(pill.querySelector('.skeleton-pill')).not.toBeNull()
    expect(pill.querySelectorAll('.skeleton-block')).toHaveLength(1)
  })

  it('is decorative and carries no text of its own', () => {
    const view = mount(<Skeleton lines={2} />)
    expect(view.querySelector('.skeleton')?.textContent).toBe('')
  })
})
