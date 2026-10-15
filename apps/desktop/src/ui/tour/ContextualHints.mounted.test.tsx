// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ContextualHints } from './ContextualHints'
import { resetHints } from '../uiPrefs'

let root: Root | null = null
let host: HTMLDivElement | null = null
const added: HTMLElement[] = []

function anchor(selectorKind: 'tour' | 'class', value: string, y: number) {
  const element = document.createElement('div')
  if (selectorKind === 'tour') element.dataset.tour = value
  else element.className = value
  element.getBoundingClientRect = () => ({ x: 40, y, width: 200, height: 40, top: y, left: 40, right: 240, bottom: y + 40, toJSON: () => ({}) }) as DOMRect
  document.body.append(element)
  added.push(element)
}
const flush = async (ms = 700) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) }) }
const titles = () => [...document.querySelectorAll('.coach.hint .coach-title')].map((node) => node.textContent)

beforeEach(() => { try { localStorage.clear() } catch { /* ignore */ } resetHints() })
afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove(); added.splice(0).forEach((element) => element.remove()); document.querySelectorAll('.coach').forEach((node) => node.remove())
  root = null; host = null
})

describe('ContextualHints', () => {
  it('shows only the highest-priority hint when several anchors are on screen, then the next after dismissal', async () => {
    anchor('class', 'plan-card', 120)
    anchor('class', 'team-chip', 320)
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    act(() => root!.render(<ContextualHints enabled />))
    await flush()
    expect(titles()).toEqual(['This is the plan'])
    await act(async () => { document.querySelector<HTMLButtonElement>('.coach.hint button')!.click() })
    await flush()
    expect(titles()).toEqual(['Bots can work together'])
  })

  it('shows nothing when disabled or when the tour is on screen', async () => {
    anchor('class', 'plan-card', 120)
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    act(() => root!.render(<ContextualHints enabled={false} />))
    await flush()
    expect(titles()).toEqual([])
    const tour = document.createElement('div'); tour.className = 'coach modal'; document.body.append(tour); added.push(tour)
    act(() => root!.render(<ContextualHints enabled />))
    await flush()
    expect(titles()).toEqual([])
  })
})
