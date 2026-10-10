// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './BlobPage'
import { ActivitySummaryLine } from './ActivityDetails'
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

  it('collapses a turn into one summary line and opens each step into its real details', async () => {
    const grouped = groupConversationActivity([
      { kind: 'message', id: 'm-1' },
      { kind: 'activity', id: 'tool-1', activityKind: 'tool', activity: { title: 'npm test', kind: 'commandExecution', state: 'failed', detail: { command: 'npm test', output: '1 failing', exitCode: 1 } } },
      { kind: 'activity', id: 'tool-2', activityKind: 'tool', activity: { title: 'bloblex · message_blob', kind: 'mcpToolCall', state: 'completed', detail: { tool: 'bloblex · message_blob', input: '{ "blob": "Gogo" }', result: 'Sent to Gogo.' } } },
      { kind: 'activity', id: 'file-1', activityKind: 'file', activity: { path: 'src/a.ts', detail: { path: 'src/a.ts', diff: '+one line' } } },
      { kind: 'message', id: 'm-2' },
    ])[1]
    if (grouped.kind !== 'activity-group') throw new Error('expected grouped activity')
    const view = mount(<ActivitySummaryLine group={grouped} />)
    views.push(view)
    const toggle = view.host.querySelector<HTMLButtonElement>('.activity-summary-toggle')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe('Ran 1 command · used 1 tool · edited 1 file · 1 failed')
    expect(view.host.querySelector('.activity-steps')).toBeNull()
    await act(async () => { toggle.click() })
    const steps = [...view.host.querySelectorAll<HTMLButtonElement>('.activity-step-head')]
    expect(steps.map((step) => step.querySelector('.activity-step-title')?.textContent)).toEqual(['npm test', 'Messaged a teammate', 'src/a.ts'])
    await act(async () => { steps[0].click(); steps[1].click() })
    const details = [...view.host.querySelectorAll('.activity-step-detail')].map((detail) => detail.textContent)
    expect(details[0]).toContain('1 failing')
    expect(details[0]).toContain('Exit code 1')
    expect(details[1]).toContain('Sent to Gogo.')
  })

  it('shows a running turn as working without opening it', () => {
    const grouped = groupConversationActivity([
      { kind: 'message', id: 'm-live' },
      { kind: 'activity', id: 'tool-live', activityKind: 'tool', activity: { title: 'npm test', kind: 'commandExecution', state: 'running' } },
    ])[1]
    if (grouped.kind !== 'activity-group') throw new Error('expected trailing activity group')
    const view = mount(<ActivitySummaryLine group={grouped} />)
    views.push(view)
    const summary = view.host.querySelector<HTMLButtonElement>('.activity-summary-toggle')!
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    expect(summary.textContent).toContain('Working · Ran 1 command')
  })
})
