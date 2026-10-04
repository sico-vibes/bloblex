// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WardrobeGrid } from './WardrobeGrid'
import { updateParams, type AgentDraft } from './agentForm'

vi.mock('../blob/BlobCanvas', () => ({ BlobCanvas: ({ outfit }: { outfit: string }) => <span data-outfit={outfit} /> }))

describe('wardrobe grid', () => {
  let root: Root | null = null
  let host: HTMLElement | null = null
  afterEach(() => {
    if (root) act(() => root!.unmount())
    host?.remove()
    root = null
    host = null
  })

  it('exposes radio selection and supports arrow-key selection', () => {
    const change = vi.fn()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(<WardrobeGrid color="#abc" value="auto" createdAt="2024-02-01T12:00:00Z" onChange={change} />))
    const radios = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(host.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Blob outfit')
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
    expect(radios[0].getAttribute('aria-label')).toContain('currently')
    act(() => radios[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(change).toHaveBeenCalledWith('none')
    expect(document.activeElement).toBe(radios[1])
    const baseline: AgentDraft = { name: 'A', description: '', instructions: '', color: 'mint', outfit: 'auto', runtimeId: 'rt', defaultProject: null, model: null, thinking: null, serviceTier: null, approvalMode: null }
    expect(updateParams('agent-a', { ...baseline, outfit: change.mock.calls[0][0] }, baseline)).toEqual({ agentId: 'agent-a', outfit: 'none' })
  })
})
