// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '../types'

const h = vi.hoisted(() => ({ rpc: vi.fn(), listen: vi.fn() }))
vi.mock('../tauri', () => ({ rpc: h.rpc, listenForDaemonEvents: h.listen }))
import { ApprovalRulesPage } from './ApprovalRulesPage'
import { HealthPage } from './HealthPage'

let root: Root | null = null
let host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  h.rpc.mockReset(); h.listen.mockReset(); h.listen.mockResolvedValue(() => undefined)
  host = document.createElement('div'); document.body.append(host)
})
afterEach(() => { if (root) act(() => root!.unmount()); root = null; host.remove(); vi.unstubAllGlobals() })
async function mount(node: React.ReactNode) {
  root = createRoot(host)
  await act(async () => { root!.render(node); await Promise.resolve(); await Promise.resolve() })
}

describe('Settings → Approvals', () => {
  const agents = [{ id: 'a1', name: 'Codex' }] as Agent[]

  it('lists the saved rules per bot and removes one', async () => {
    h.rpc.mockImplementation(async (method: string) => method === 'permission.rules.list'
      ? { rules: [{ id: 'r1', agentId: 'a1', kind: 'command', label: 'Run `npm test`' }, { id: 'r2', agentId: 'gone', kind: 'edit', label: 'Edit src/a.ts' }] }
      : { deleted: true })
    await mount(<ApprovalRulesPage agents={agents} />)
    expect(host.textContent).toContain('Codex')
    expect(host.textContent).toContain('Run `npm test`')
    expect(host.textContent).toContain('A removed bot')
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Stop always allowing Run `npm test` for Codex"]')!.click(); await Promise.resolve() })
    expect(h.rpc).toHaveBeenCalledWith('permission.rules.delete', { id: 'r1' })
    expect(host.textContent).not.toContain('Run `npm test`')
  })

  it('offers a rule\u2019s scope only when the daemon reports it (Phase 1A), and rescopes through permission.rules.update', async () => {
    h.rpc.mockImplementation(async (method: string) => method === 'permission.rules.list'
      ? { rules: [{ id: 'r1', agentId: 'a1', kind: 'command', label: 'Run tests', projectId: null }, { id: 'r2', agentId: 'a1', kind: 'edit', label: 'Edit files' }] }
      : {})
    await mount(<ApprovalRulesPage agents={agents} projects={[{ id: 'p1', name: 'Korus', path: 'D:\\korus', sortOrder: 0 }]} />)
    const scoped = host.querySelector<HTMLButtonElement>('.select-trigger[aria-label^="Where Codex may always Run tests"]')
    expect(scoped).not.toBeNull()
    // An older daemon sends no projectId and has no permission.rules.update, so its rules get no picker.
    expect(host.querySelector('.select-trigger[aria-label^="Where Codex may always Edit files"]')).toBeNull()
    await act(async () => { scoped!.click(); await Promise.resolve() })
    const only = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === 'Only Korus')!
    await act(async () => { only.click(); await Promise.resolve(); await Promise.resolve() })
    expect(h.rpc).toHaveBeenCalledWith('permission.rules.update', { id: 'r1', scope: 'project', projectId: 'p1' })
  })

  it('says when nothing is saved, and when the list cannot be read', async () => {
    h.rpc.mockResolvedValue({ rules: [] })
    await mount(<ApprovalRulesPage agents={agents} />)
    expect(host.textContent).toContain('Nothing is always allowed yet.')
    act(() => root!.unmount()); root = null
    h.rpc.mockRejectedValue(new Error('not_found'))
    await mount(<ApprovalRulesPage agents={agents} />)
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Saved approvals could not be read.')
  })
})

describe('Settings → Health check', () => {
  it('groups the checks, offers a fix only for problems, and checks again after it', async () => {
    h.rpc.mockImplementation(async (method: string) => method === 'doctor.run' ? { checkedAt: 'now', checks: [
      { id: 'rt-claude', area: 'runtime', label: 'Claude Code', status: 'ok', detail: 'Signed in', fix: null },
      { id: 'rt-codex', area: 'runtime', label: 'Codex', status: 'fail', detail: 'Not found on PATH', fix: { label: 'Scan again', method: 'runtime.refresh', params: {} } },
      { id: 'db', area: 'database', label: 'Database', status: 'ok', detail: 'Integrity check passed', fix: null },
    ] } : {})
    await mount(<HealthPage />)
    expect(host.textContent).toContain('1 thing needs attention.')
    expect(host.textContent).toContain('Coding agents')
    const fixes = [...host.querySelectorAll<HTMLButtonElement>('.health-list button')]
    expect(fixes.map((button) => button.textContent)).toEqual(['Scan again'])
    await act(async () => { fixes[0]!.click(); await Promise.resolve(); await Promise.resolve() })
    expect(h.rpc).toHaveBeenCalledWith('runtime.refresh', {})
    expect(h.rpc.mock.calls.filter(([method]) => method === 'doctor.run')).toHaveLength(2)
  })

  it('explains when the check cannot run', async () => {
    h.rpc.mockRejectedValue(new Error('offline'))
    await mount(<HealthPage />)
    expect(host.textContent).toContain('The health check could not run.')
  })
})
