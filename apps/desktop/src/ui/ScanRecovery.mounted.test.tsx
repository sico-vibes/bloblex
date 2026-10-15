// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CheckAgainButton, ScanRecovery } from './ScanRecovery'

let roots: Root[] = []
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(() => { act(() => { for (const root of roots) root.unmount() }); roots = []; document.body.innerHTML = ''; vi.unstubAllGlobals() })
function mount(node: ReactNode) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  act(() => root.render(node))
  return { host, render: (next: ReactNode) => act(() => root.render(next)) }
}
function click(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)
  expect(button).toBeTruthy()
  act(() => button!.click())
}

describe('scan recovery', () => {
  it('remembers the last check and reports a failed scan then a success', () => {
    const onScan = vi.fn()
    const view = mount(<CheckAgainButton name="Codex" found={false} scanning={false} onScan={onScan} />)
    click(view.host, 'Check again')
    expect(onScan).toHaveBeenCalledOnce()
    expect(view.host.querySelector('.scan-check-time')?.textContent).toContain('Checked')

    view.render(<CheckAgainButton name="Codex" found={false} scanning onScan={onScan} />)
    expect([...view.host.querySelectorAll('button')].some((item) => item.textContent === 'Checking…')).toBe(true)
    view.render(<CheckAgainButton name="Codex" found={false} scanning={false} onScan={onScan} />)
    expect(view.host.querySelector('[role="status"]')?.textContent).toBe('Still not found')

    click(view.host, 'Check again')
    view.render(<CheckAgainButton name="Codex" found scanning onScan={onScan} />)
    view.render(<CheckAgainButton name="Codex" found scanning={false} onScan={onScan} />)
    expect(view.host.querySelector('[role="status"]')?.textContent).toBe('Found Codex')
  })

  it('lists each provider install command with Copy and a Check again when a scan finds nothing', () => {
    const view = mount(<ScanRecovery runtimes={[]} scanning={false} error={null} onScan={vi.fn()} />)
    expect(view.host.querySelectorAll('.scan-recovery-provider')).toHaveLength(3)
    expect(view.host.textContent).toContain('irm https://claude.ai/install.ps1 | iex')
    expect(view.host.querySelector('[data-provider="codex"]')).not.toBeNull()
    expect([...view.host.querySelectorAll('button')].filter((item) => item.textContent === 'Check again')).toHaveLength(3)
    expect(view.host.querySelectorAll('[aria-label$="command"]').length).toBeGreaterThanOrEqual(3)
  })

  it('phrases a failed scan through friendlyError', () => {
    const view = mount(<ScanRecovery runtimes={[]} scanning={false} error="timeout: Finding coding agents timed out." onScan={vi.fn()} />)
    expect(view.host.querySelector('.scan-recovery-error')?.textContent).toContain('The coding agent took too long.')
    expect(view.host.querySelector('.scan-recovery-error')?.textContent).not.toContain('timeout:')
  })
})
