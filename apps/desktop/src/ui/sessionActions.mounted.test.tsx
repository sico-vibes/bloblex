// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './BlobPage'
import { ActivityGroupRow } from './App'
import { groupConversationActivity } from './conversation'

vi.mock('../desktopIntegrations', () => ({ autostartEnabled: async () => false, setAutostartEnabled: async () => undefined, sendDesktopNotification: async () => undefined, flashMainWindow: async () => undefined }))

function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  act(() => root.render(node))
  return {
    host,
    rerender(next: ReactNode) { act(() => root.render(next)) },
    unmount() { act(() => root.unmount()); host.remove() },
  }
}

const views: Array<{ unmount: () => void }> = []
afterEach(() => { for (const view of views.splice(0)) view.unmount() })


describe('mounted conversation controls', () => {
  it('shows the exact delete confirmation and returns focus when cancelled', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const cancelled = vi.fn()
    const confirmed = vi.fn()
    const view = mount(<ConfirmDialog title="Delete this conversation?" body="This removes it and its messages from Bloblex. The coding agent's own history is not touched." confirmLabel="Delete" cancelLabel="Cancel" onConfirm={confirmed} onCancel={cancelled} />)
    views.push({ unmount: () => { view.unmount(); trigger.remove() } })
    expect(view.host.querySelector('[role="dialog"]')?.textContent).toContain('The coding agent\'s own history is not touched.')
    await act(async () => { [...view.host.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')?.click() })
    expect(cancelled).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(trigger)
    await act(async () => { [...view.host.querySelectorAll('button')].find((button) => button.textContent === 'Delete')?.click() })
    expect(confirmed).toHaveBeenCalledOnce()
  })

  it('expands grouped activity, starts failed groups open, and keeps expansion across rerenders', async () => {
    const grouped = groupConversationActivity([
      { kind: 'message', id: 'm-1' },
      { kind: 'activity', id: 'tool-1', activityKind: 'tool', activity: { title: 'Compile', state: 'failed' } },
      { kind: 'activity', id: 'file-1', activityKind: 'file', activity: { operation: 'edit', path: 'src/a.ts' } },
      { kind: 'message', id: 'm-2' },
    ])[1]
    if (grouped.kind !== 'activity-group') throw new Error('expected grouped activity')
    const view = mount(<ActivityGroupRow group={grouped} />)
    views.push(view)
    const button = view.host.querySelector<HTMLButtonElement>('.activity-group-toggle')!
    expect(button.textContent).toContain('1 failed')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(view.host.querySelectorAll('.timeline-activity')).toHaveLength(2)
    await act(async () => { button.click() })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    view.rerender(<ActivityGroupRow group={grouped} />)
    expect(view.host.querySelector('.activity-group-toggle')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('shows an open running summary for a trailing activity run', () => {
    const grouped = groupConversationActivity([
      { kind: 'message', id: 'm-live' },
      { kind: 'activity', id: 'tool-done', activityKind: 'tool', activity: { title: 'Read files', state: 'completed' } },
      { kind: 'activity', id: 'tool-live', activityKind: 'tool', activity: { title: 'npm test', state: 'running' } },
    ])[1]
    if (grouped.kind !== 'activity-group') throw new Error('expected trailing activity group')
    const view = mount(<ActivityGroupRow group={grouped} />)
    views.push(view)
    const summary = view.host.querySelector<HTMLButtonElement>('.activity-group-toggle')!
    expect(summary.getAttribute('aria-expanded')).toBe('true')
    expect(summary.textContent).toContain('Running npm test…')
    expect(view.host.querySelectorAll('.timeline-activity')).toHaveLength(2)
  })
})
