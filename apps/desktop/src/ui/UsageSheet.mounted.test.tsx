// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageSheet } from './App'

vi.mock('../tauri', () => ({ inDesktop: false, previewMode: false }))
let root: Root
let host: HTMLDivElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); vi.unstubAllGlobals() })
function mount(props: Partial<ComponentProps<typeof UsageSheet>> = {}) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root.render(<UsageSheet summary={{}} period="today" quotas={[]} loading={false} quotaRefreshing={false} onRefreshQuota={vi.fn()} onPeriodChange={vi.fn()} onOpenHistory={vi.fn()} onClose={vi.fn()} {...props} />))
}

describe('usage sheet', () => {
  it('keeps the quota note and divider beside the heading, with a keyboard-focus tooltip', () => {
    mount()
    const heading = host.querySelector('.quota-details .usage-block-heading')!
    expect(heading.querySelector('h3')?.textContent).toBe('Plan usage limits')
    expect(heading.querySelector('.usage-divider')).not.toBeNull()
    expect(heading.textContent).toContain('Reported by each CLI account')
    const info = heading.querySelector<HTMLButtonElement>('[aria-label="About plan usage limits"]')!
    expect(info).not.toBeNull()
    // F1: the explanation the footer used to show stays readable to assistive technology.
    const describedBy = info.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent).toContain('account quota')
    act(() => info.focus())
    const tooltip = [...document.querySelectorAll('[role="tooltip"][data-open="true"]')].find((node) => node.textContent?.includes('Token counts'))
    expect(tooltip?.parentElement).toBe(document.body)
    expect(tooltip?.textContent).toContain('account quota')
    expect(host.querySelector('footer')?.textContent).toBe('Usage history')
  })

  it.each(['today', 'month'] as const)('shows a single empty-period message for %s rather than five N/A rows', (period) => {
    mount({ period, summary: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null } })
    expect(host.querySelector('.usage-token-grid')).toBeNull()
    expect(host.querySelector('.usage-empty-line[data-usage-empty]')?.textContent).toBe(`No usage yet ${period === 'today' ? 'today' : 'this month'}.`)
  })

  it('keeps recorded zeroes and N/A buckets visible for a partially recorded period', () => {
    mount({ summary: { inputTokens: 0, outputTokens: 12 } })
    expect([...host.querySelectorAll('.usage-token strong')].map((node) => node.textContent)).toEqual(['0', '12', 'N/A', 'N/A', 'N/A'])
    expect(host.querySelector('[data-usage-empty]')).toBeNull()
  })

  it('distinguishes a missing summary and loading from an empty period', () => {
    mount({ summary: null })
    expect(host.textContent).toContain('Usage summary unavailable')
    act(() => root.render(<UsageSheet summary={null} period="today" quotas={[]} loading quotaRefreshing={false} onRefreshQuota={vi.fn()} onPeriodChange={vi.fn()} onOpenHistory={vi.fn()} onClose={vi.fn()} />))
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(host.querySelector('[data-usage-empty]')).toBeNull()
  })
})
