// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Runtime, Session } from '../types'
import type { UsageAnalytics, UsageAnalyticsRequest } from '../analyticsTypes'
import { createDraft, draftFromAgent, executionFromAgent } from './agentForm'
import { analyticsFixtures } from './analyticsFixtures'
import { buildAnalyticsRequest, resolvedTimeZone } from './analyticsFormat'

const fetchUsageAnalytics = vi.hoisted(() => vi.fn())

vi.mock('../tauri', () => ({
  inDesktop: true,
  fetchUsageAnalytics,
}))

vi.mock('../blob/BlobCanvas', () => ({
  BlobCanvas: () => null,
}))

import { AnalyticsView } from './AnalyticsView'
import { BlobPage } from './BlobPage'

const now = new Date('2026-10-02T12:00:00.000Z')
const stamp = '2026-10-01T00:00:00.000Z'

function agent(partial: Pick<Agent, 'id' | 'name' | 'color' | 'runtimeId'> & Partial<Agent>): Agent {
  return {
    description: '', instructions: '', model: null, thinking: null, serviceTier: null, customArgs: [], customEnv: {},
    maxConcurrency: 1, defaultProject: null, sortOrder: 0, archived: false, createdAt: stamp, updatedAt: stamp, ...partial,
  }
}

function session(partial: Pick<Session, 'id' | 'projectPath'> & Partial<Session>): Session {
  return { runtimeId: 'runtime-claude', agentId: 'agent-claude', title: '', state: 'idle', updatedAt: stamp, messages: [], ...partial }
}

const claude = agent({ id: 'agent-claude', name: 'Claude', color: 'coral', runtimeId: 'runtime-claude' })
const codex = agent({ id: 'agent-codex', name: 'Codex', color: 'blue', runtimeId: 'runtime-codex' })
const runtime: Runtime = { id: 'runtime-claude', provider: 'claude', status: 'online' }
const sessions = [
  session({ id: 'older', projectPath: 'C:/work/site', updatedAt: '2026-10-01T00:00:00.000Z' }),
  session({ id: 'newer', projectPath: 'c:\\work\\site\\', updatedAt: '2026-10-02T00:00:00.000Z' }),
  session({ id: 'other', projectPath: 'D:\\other\\site', runtimeId: 'runtime-codex', agentId: 'agent-codex', updatedAt: '2026-09-01T00:00:00.000Z' }),
]

function withRuns(runs: number): UsageAnalytics {
  return { ...analyticsFixtures.full, totals: { ...analyticsFixtures.full.totals, runs } }
}

const mounted: Array<{ unmount: () => void }> = []

function mount(node: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  act(() => { root.render(node) })
  const view = {
    host,
    async flush() {
      await act(async () => {
        for (let index = 0; index < 8; index += 1) await Promise.resolve()
      })
    },
    unmount() { act(() => root.unmount()); host.remove() },
  }
  mounted.push(view)
  return view
}

function figure(host: ParentNode, card: string) {
  return host.querySelector(`[data-analytics-card="${card}"] [data-figure]`)?.textContent ?? ''
}

function buttonNamed(host: ParentNode, name: string) {
  return [...host.querySelectorAll('button')].find((button) => (button.textContent ?? '').replace(/\s+/g, ' ').trim() === name)
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error('missing element')
  await act(async () => { (element as HTMLElement).click() })
}

async function chooseProject(host: ParentNode, label: string) {
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Project"]')
  if (!select) throw new Error('missing project filter')
  const option = [...select.options].find((item) => item.text === label)
  if (!option) throw new Error(`missing project ${label}`)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, option.value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function requests(): UsageAnalyticsRequest[] {
  return fetchUsageAnalytics.mock.calls.map((call) => call[0] as UsageAnalyticsRequest)
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fetchUsageAnalytics.mockReset()
  fetchUsageAnalytics.mockResolvedValue(analyticsFixtures.full)
})

afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount()
  vi.unstubAllGlobals()
})

describe('analytics view', () => {
  it('renders summary cards for full, lower-bound, empty, and unknown data', async () => {
    fetchUsageAnalytics.mockResolvedValueOnce(analyticsFixtures.full)
    const full = mount(<AnalyticsView sessions={sessions} agents={[claude, codex]} connected now={now} />)
    await full.flush()
    expect(figure(full.host, 'cost')).toContain('12.34')
    expect(figure(full.host, 'cost')).not.toContain('≥')
    expect(figure(full.host, 'tokens')).toBe('1,500')
    expect(figure(full.host, 'runtime')).toBe('2m 3s')
    expect(figure(full.host, 'runs')).toBe('40')
    expect(full.host.querySelector('[data-analytics-card="runs"]')?.textContent).toContain('2 failed')
    expect(full.host.querySelector('[data-analytics-card="runs"]')?.textContent).toContain('1 active')
    const costCard = full.host.querySelector('[data-analytics-card="cost"]')
    const subscriptions = full.host.querySelector('.analytics-subscriptions')
    expect(subscriptions?.textContent).toContain('Subscriptions (not included in usage cost)')
    expect(subscriptions?.textContent).toContain('50.00')
    expect(costCard?.textContent).not.toContain('50.00')
    full.unmount()

    fetchUsageAnalytics.mockResolvedValueOnce(analyticsFixtures.partial)
    const partial = mount(<AnalyticsView sessions={sessions} agents={[codex]} connected now={now} />)
    await partial.flush()
    expect(figure(partial.host, 'cost')).toContain('≥')
    expect(figure(partial.host, 'cost')).toContain('12.34')
    expect(figure(partial.host, 'tokens')).toBe('≥ 100')
    expect(partial.host.querySelector('[data-analytics-card="tokens"]')?.textContent).toContain('Output Unknown')
    expect(partial.host.querySelector('[data-analytics-card="tokens"]')?.textContent).not.toContain('Output 0')
    expect(partial.host.textContent).toContain('7 runs did not report usage')
    expect(partial.host.textContent).toContain('Unpriced models: provider/model')
    expect(partial.host.querySelector('.analytics-leader-row')?.textContent).toContain('≥')
    partial.unmount()

    fetchUsageAnalytics.mockResolvedValueOnce(analyticsFixtures.empty)
    const empty = mount(<AnalyticsView sessions={[]} agents={[]} connected now={now} />)
    await empty.flush()
    expect(figure(empty.host, 'cost')).toBe('Unknown')
    expect(figure(empty.host, 'tokens')).toBe('Unknown')
    expect(figure(empty.host, 'cost')).not.toContain('0')
    expect(figure(empty.host, 'runs')).toBe('0')
    expect(empty.host.textContent).toContain('No usage in this range.')
    empty.unmount()

    fetchUsageAnalytics.mockResolvedValueOnce(analyticsFixtures.unknown)
    const unknown = mount(<AnalyticsView sessions={sessions} agents={[codex]} connected now={now} />)
    await unknown.flush()
    expect(figure(unknown.host, 'cost')).toBe('Unknown')
    expect(unknown.host.querySelector('[data-analytics-card="cost"]')?.textContent).not.toContain('≥')
    expect(unknown.host.querySelector('[data-analytics-card="cost"]')?.textContent).not.toContain('$0')
    expect(figure(unknown.host, 'tokens')).toContain('≥')
    expect(figure(unknown.host, 'tokens')).toContain('60')
    expect(unknown.host.textContent).toContain('Cache read Unknown')
    expect(unknown.host.textContent).not.toContain('Cache read 0')
    expect(unknown.host.querySelector('.analytics-leader-row [data-fraction]')?.getAttribute('data-fraction')).toBe('null')
  })

  it('draws null buckets as no-data gaps and toggles metric values', async () => {
    const view = mount(<AnalyticsView sessions={sessions} agents={[claude, codex]} connected now={now} />)
    await view.flush()
    const gap = view.host.querySelector('[data-bucket-start="2026-09-30T23:00:00.000Z"]')
    expect(gap?.getAttribute('role')).toBe('img')
    expect(gap?.getAttribute('tabindex')).toBe('0')
    expect(gap?.getAttribute('data-gap')).toBe('true')
    expect(gap?.getAttribute('data-value')).toBe('null')
    expect(gap?.getAttribute('aria-label')).toMatch(/no data$/)
    expect(gap?.querySelector('title')?.textContent).toMatch(/no data$/)
    const summary = view.host.querySelector('p[role="img"]')
    expect(summary?.textContent).toContain('Tokens')
    expect(summary?.textContent).toContain('no data')
    const tall = view.host.querySelector('[data-value="400"]')
    const short = view.host.querySelector('[data-value="100"]')
    expect(Number(tall?.getAttribute('height'))).toBeGreaterThan(Number(short?.getAttribute('height')))
    const callsBefore = fetchUsageAnalytics.mock.calls.length
    await click(buttonNamed(view.host.querySelector('[aria-label="Chart metric"]') ?? view.host, 'Runs'))
    const zero = view.host.querySelector('[data-bucket-start="2026-09-30T23:00:00.000Z"]')
    expect(zero?.getAttribute('data-gap')).toBe('false')
    expect(zero?.getAttribute('data-value')).toBe('0')
    expect(zero?.getAttribute('aria-label')).not.toContain('no data')
    expect(view.host.querySelector('p[role="img"]')?.textContent).toContain('Runs')
    expect(fetchUsageAnalytics.mock.calls.length).toBe(callsBefore)
    await click(buttonNamed(view.host.querySelector('[aria-label="Chart metric"]') ?? view.host, 'Cost'))
    expect(view.host.querySelector('[data-bucket-start="2026-09-30T23:00:00.000Z"]')?.getAttribute('data-value')).toBe('null')
  })

  it('labels the legacy row and the DST week in local time', async () => {
    fetchUsageAnalytics.mockResolvedValueOnce(analyticsFixtures.legacy)
    const legacy = mount(<AnalyticsView sessions={sessions} agents={[codex]} connected now={now} />)
    await legacy.flush()
    expect(legacy.host.textContent).toContain('Unassigned sessions')
    const fractions = [...legacy.host.querySelectorAll('[data-fraction]')].map((node) => node.getAttribute('data-fraction'))
    expect(fractions).toEqual(['1', '0.2'])
    legacy.unmount()

    fetchUsageAnalytics.mockResolvedValueOnce(analyticsFixtures.dst)
    const dst = mount(<AnalyticsView sessions={sessions} agents={[claude]} connected now={now} />)
    await dst.flush()
    const shifted = dst.host.querySelector('[data-bucket-start="2026-03-29T23:00:00.000Z"]')
    expect(shifted?.getAttribute('aria-label')).toContain('30')
    expect(shifted?.getAttribute('aria-label')).not.toContain('29')
    expect(dst.host.querySelector('p[role="img"]')?.textContent).toContain('Weekly')
  })

  it('sends range, timezone, bucket, project path, and a fixed agent id', async () => {
    const tz = resolvedTimeZone()
    const view = mount(<AnalyticsView agentId="agent-claude" sessions={sessions} agents={[claude, codex]} connected now={now} />)
    await view.flush()
    expect(requests()[0]).toEqual(buildAnalyticsRequest({ days: 7, bucket: 'day', now, timeZone: tz, agentId: 'agent-claude' }))
    expect(requests()[0]?.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    await click(buttonNamed(view.host, '30 days'))
    await view.flush()
    await click(buttonNamed(view.host, 'Weekly'))
    await view.flush()
    await chooseProject(view.host, 'site · work')
    await view.flush()
    const latest = requests().at(-1)
    expect(latest).toEqual(buildAnalyticsRequest({
      days: 30,
      bucket: 'week',
      now,
      timeZone: tz,
      agentId: 'agent-claude',
      projectPath: 'c:\\work\\site\\',
    }))
    expect(latest?.projectPath).not.toBe('c:\\work\\site')
  })

  it('ignores a stale analytics response after the range changes', async () => {
    let resolveFirst: ((value: UsageAnalytics) => void) | undefined
    let resolveSecond: ((value: UsageAnalytics) => void) | undefined
    fetchUsageAnalytics.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
    fetchUsageAnalytics.mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const view = mount(<AnalyticsView sessions={sessions} agents={[claude]} connected now={now} />)
    await view.flush()
    await click(buttonNamed(view.host, '90 days'))
    await view.flush()
    expect(requests()).toHaveLength(2)
    expect(requests()[1]?.from).toBe(buildAnalyticsRequest({ days: 90, bucket: 'day', now, timeZone: resolvedTimeZone() }).from)
    await act(async () => { resolveSecond?.(withRuns(222)) })
    await view.flush()
    expect(figure(view.host, 'runs')).toBe('222')
    await act(async () => { resolveFirst?.(withRuns(111)) })
    await view.flush()
    expect(figure(view.host, 'runs')).toBe('222')
    expect(figure(view.host, 'runs')).not.toBe('111')
  })

  it('shows an error state and does not invent zeroes', async () => {
    fetchUsageAnalytics.mockRejectedValueOnce(new Error('not_found: missing'))
    const view = mount(<AnalyticsView agentId="missing-agent" sessions={[]} agents={[]} connected now={now} />)
    await view.flush()
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('That blob is no longer available.')
    expect(view.host.querySelector('[data-analytics-card="cost"]')).toBeNull()
    expect(view.host.textContent).not.toContain('$0')
    fetchUsageAnalytics.mockResolvedValueOnce(analyticsFixtures.empty)
    await click(buttonNamed(view.host, 'Try again'))
    await view.flush()
    expect(figure(view.host, 'tokens')).toBe('Unknown')
  })

  it('hides numbers while the daemon is disconnected', () => {
    const view = mount(<AnalyticsView sessions={sessions} agents={[claude]} connected={false} now={now} />)
    expect(view.host.textContent).toContain('Connect to the local runtime to load usage.')
    expect(fetchUsageAnalytics).not.toHaveBeenCalled()
    expect(view.host.querySelector('[data-analytics-card="cost"]')).toBeNull()
  })

  it('reuses the analytics view on the blob Usage tab with the blob id fixed', async () => {
    const draft = draftFromAgent(claude)
    const view = mount(<BlobPage
      mode="edit"
      agent={claude}
      draft={draft}
      runtime={runtime}
      session={sessions[1] ?? null}
      runtimes={[runtime]}
      sessions={sessions.filter((item) => item.agentId === claude.id)}
      legacyCount={0}
      connected
      saving={false}
      dirty={false}
      ready
      canStartSession={false}
      error={null}
      remoteNotice={null}
      errors={{}}
      execution={executionFromAgent(claude)}
      onDraftChange={() => undefined}
      onBack={() => undefined}
      onSave={() => undefined}
      onCancel={() => undefined}
      onArchive={() => undefined}
      onNewSession={() => undefined}
      onOpenSession={() => undefined}
    />)
    expect(view.host.textContent).not.toContain('not available yet')
    const usageTab = [...view.host.querySelectorAll('.blob-page-column > .blob-tabs [role="tab"]')].find((tab) => tab.textContent === 'Usage')
    await click(usageTab)
    await view.flush()
    expect(view.host.querySelector('[data-analytics-root="embedded"]')).not.toBeNull()
    expect(view.host.querySelector('.analytics-page')).toBeNull()
    expect(requests().every((request) => request.agentId === 'agent-claude')).toBe(true)
    expect(figure(view.host, 'runs')).toBe('40')
    view.unmount()

    fetchUsageAnalytics.mockClear()
    const created = mount(<BlobPage
      mode="create"
      agent={null}
      draft={createDraft([runtime], runtime.id)}
      runtime={runtime}
      session={null}
      runtimes={[runtime]}
      sessions={[]}
      legacyCount={0}
      connected
      saving={false}
      dirty={false}
      ready={false}
      canStartSession={false}
      error={null}
      remoteNotice={null}
      errors={{}}
      execution={executionFromAgent(null)}
      onDraftChange={() => undefined}
      onBack={() => undefined}
      onSave={() => undefined}
      onCancel={() => undefined}
      onArchive={() => undefined}
      onNewSession={() => undefined}
      onOpenSession={() => undefined}
    />)
    const createUsage = [...created.host.querySelectorAll('.blob-page-column > .blob-tabs [role="tab"]')].find((tab) => tab.textContent === 'Usage')
    await click(createUsage)
    await created.flush()
    expect(created.host.textContent).toContain('Save this blob to see its usage.')
    expect(fetchUsageAnalytics).not.toHaveBeenCalled()
  })

  it('keeps a failed-run message and drops anything else on the row', async () => {
    fetchUsageAnalytics.mockResolvedValueOnce({
      ...analyticsFixtures.partial,
      errors: [{ ...analyticsFixtures.partial.errors[0], prompt: 'SECRET_PROMPT', message: 'safe short text' }],
    })
    const view = mount(<AnalyticsView sessions={sessions} agents={[codex]} connected now={now} />)
    await view.flush()
    await click(buttonNamed(view.host, 'Errors'))
    expect(view.host.querySelector('[role="tabpanel"]')?.textContent).toContain('safe short text')
    expect(view.host.textContent).not.toContain('SECRET_PROMPT')
  })
})
