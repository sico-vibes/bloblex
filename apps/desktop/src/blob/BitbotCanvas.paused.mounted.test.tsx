// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The robot library is replaced by a stub that exposes the `paused` prop, so the
// test checks the decision (who may animate) rather than the pixels.
vi.mock('../vendor/robot-heads', () => ({
  RobotHead: (props: { paused?: boolean; state?: string; size?: number }) => createElement('span', { 'data-testid': 'robot', 'data-paused': String(props.paused), 'data-state': props.state, role: 'img' }),
}))

import { BlobCanvas } from './BlobCanvas'
import { setBitbotsEnabled } from './bitbots'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => {
  if (root) act(() => root!.unmount())
  host?.remove(); root = null; host = null
  setBitbotsEnabled(false)
})

function robotFor(node: React.ReactNode) {
  setBitbotsEnabled(true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(node))
  return host.querySelector<HTMLElement>('[data-testid="robot"]')!
}

describe('which robots are allowed to move', () => {
  it('holds still when a small avatar is idle or asleep', () => {
    expect(robotFor(<BlobCanvas color="#2b49a3" size={50} mood="idle" />).dataset.paused).toBe('true')
  })

  it('animates a small avatar the moment it has something to say', () => {
    expect(robotFor(<BlobCanvas color="#2b49a3" size={50} mood="working" />).dataset.paused).toBe('false')
    expect(robotFor(<BlobCanvas color="#2b49a3" size={50} mood="permission" />).dataset.paused).toBe('false')
  })

  it('keeps big heads (hero, editor) alive even when idle', () => {
    expect(robotFor(<BlobCanvas color="#2b49a3" size={128} mood="idle" />).dataset.paused).toBe('false')
  })

  it('wakes a small idle avatar while the pointer is over it', () => {
    const robot = robotFor(<BlobCanvas color="#2b49a3" size={50} mood="idle" />)
    const frame = robot.parentElement!
    expect(robot.dataset.paused).toBe('true')
    act(() => { frame.dispatchEvent(new Event('pointerover', { bubbles: true })) })
    // React's onPointerEnter is driven by pointerover/pointerenter on the frame.
    act(() => { frame.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })) })
    expect(host!.querySelector<HTMLElement>('[data-testid="robot"]')!.dataset.paused).toBe('false')
  })
})
