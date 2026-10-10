// @vitest-environment happy-dom
import { chooseOptionByLabel, selectOptions, selectValue } from './testSelect'
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Runtime, Session } from '../types'
import type { UsageAnalytics, UsageAnalyticsRequest } from '../analyticsTypes'
import { draftFromAgent, executionFromAgent } from './agentForm'
import { analyticsFixtures } from './analyticsFixtures'
import { ANALYTICS_STORAGE_KEY, OFFENDER_RATE_MIN_RUNS, buildAnalyticsRequest, resolvedTimeZone } from './analyticsFormat'
import { analyticsProjectChoices } from './rosterSelectors'

const fetchUsageAnalytics = vi.hoisted(() => vi.fn())

vi.mock('../tauri', () => ({
  inDesktop: true,
  previewMode: false,
  fetchUsageAnalytics,
  rpc: async () => null,
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
  await chooseOptionByLabel(host, 'Project', label)
}

function requests(): UsageAnalyticsRequest[] {
  return fetchUsageAnalytics.mock.calls.map((call) => call[0] as UsageAnalyticsRequest)
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // In-memory storage so the tests do not depend on the runtime's own localStorage.
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => store.clear(),
  })
  fetchUsageAnalytics.mockReset()
  fetchUsageAnalytics.mockResolvedValue(analyticsFixtures.full)
})

afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount()
  vi.unstubAllGlobals()
})

describe('analytics view', () => {
  it('keeps monetary valuation and budget controls out of analytics', async () => {
    fetchUsageAnalytics.mockResolvedValueOnce(analyticsFixtures.partial)
    const view = mount(<AnalyticsView sessions={sessions} agents={[claude, codex]} connected now={now} />)
    await view.flush()
    expect(view.host.querySelector('[data-analytics-card="cost"]')).toBeNull()
    expect(view.host.querySelector('.analytics-budget-card')).toBeNull()
    expect(view.host.textContent).not.toMatch(/set prices|subscription/i)
  })

  it('renders summary cards for full, lower-bound, empty, and unknown data', async () => {
    fetchUsageAnalytics.mockResolvedValueOnce(analyticsFixtures.full)
    const full = mount(<AnalyticsView sessions={sessions} agents={[claude, codex]} connected now={now} />)
    await full.flush()
    expect(figure(full.host, 'tokens')).toBe('1,500')
    expect(figure(full.host, 'runtime')).toBe('2m 3s')
    expect(figure(full.host, 'runs')).toBe('40')
    expect(full.host.querySelector('[data-analytics-card="runs"]')?.textContent).toContain('2 failed')
    expect(full.host.querySelector('[data-analytics-card="runs"]')?.textContent).toContain('1 active')
    expect(full.host.querySelector('[data-analytics-card="cost"]')).toBeNull()
    expect(full.host.textContent).not.toMatch(/subscription|\$|£/i)
    full.unmount()

    fetchUsageAnalytics.mockResolvedValueOnce(analyticsFixtures.partial)
    const partial = mount(<AnalyticsView sessions={sessions} agents={[codex]} connected now={now} />)
    await partial.flush()
    expect(figure(partial.host, 'tokens')).toBe('≥ 100')
    expect(partial.host.querySelector('[data-analytics-card="tokens"]')?.textContent).toContain('Output Unknown')
    expect(partial.host.querySelector('[data-analytics-card="tokens"]')?.textContent).not.toContain('Output 0')
    expect(partial.host.textContent).toContain('7 runs did not report usage')
    expect(partial.host.querySelector('.analytics-leader-row')?.textContent).toContain('≥')
    partial.unmount()

    fetchUsageAnalytics.mockResolvedValueOnce(analyticsFixtures.empty)
    const empty = mount(<AnalyticsView sessions={[]} agents={[]} connected now={now} />)
    await empty.flush()
    expect(figure(empty.host, 'tokens')).toBe('Unknown')
    expect(empty.host.querySelector('[data-analytics-card="cost"]')).toBeNull()
    expect(figure(empty.host, 'runs')).toBe('0')
    empty.unmount()

    fetchUsageAnalytics.mockResolvedValueOnce(analyticsFixtures.unknown)
    const unknown = mount(<AnalyticsView sessions={sessions} agents={[codex]} connected now={now} />)
    await unknown.flush()
    expect(unknown.host.querySelector('[data-analytics-card="cost"]')).toBeNull()
    expect(figure(unknown.host, 'tokens')).not.toContain('≥')
    expect(figure(unknown.host, 'tokens')).toContain('60')
    expect(unknown.host.textContent).toContain('Cache read Unknown')
    expect(unknown.host.textContent).not.toContain('Cache read 0')
    expect(unknown.host.querySelector('.analytics-leader-row [data-fraction]')?.getAttribute('data-fraction')).toBe('1')
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
    await click(buttonNamed(view.host.querySelector('[aria-label="Chart metric"]') ?? view.host, 'Time'))
    expect(view.host.querySelector('[data-bucket-start="2026-09-30T23:00:00.000Z"]')?.getAttribute('data-value')).toBe('0')
  })

  it('labels the legacy row and the DST week in local time', async () => {
    fetchUsageAnalytics.mockResolvedValueOnce(analyticsFixtures.legacy)
    const legacy = mount(<AnalyticsView sessions={sessions} agents={[codex]} connected now={now} />)
    await legacy.flush()
    expect(legacy.host.textContent).toContain('Unassigned sessions')
    const fractions = [...legacy.host.querySelectorAll('[data-fraction]')].map((node) => node.getAttribute('data-fraction'))
    expect(fractions).toHaveLength(2)
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

  it('keeps per-blob pricing and budget controls out of the blob editor', async () => {
    const view = mount(<BlobPage
      mode="edit"
      agent={claude}
      draft={draftFromAgent(claude)}
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
    expect(buttonNamed(view.host, 'Show usage')).toBeUndefined()
    expect(view.host.textContent).not.toMatch(/budget|price|subscription|cost/i)
    expect(view.host.querySelector('[data-analytics-root="embedded"]')).toBeNull()
  })

  it('ranks error classes, withholds thin rates, and drills into safe reasons', async () => {
    const codexRow = analyticsFixtures.full.leaderboard[0]
    const claudeRow = analyticsFixtures.full.leaderboard[1]
    if (!codexRow || !claudeRow) throw new Error('fixture rows missing')
    fetchUsageAnalytics.mockResolvedValueOnce({
      ...analyticsFixtures.full,
      leaderboard: [
        { ...codexRow, runs: 20, failedRuns: 3 },
        { ...claudeRow, agentId: 'missing', agentName: 'Ghost', runs: 2, failedRuns: 1 },
      ],
      errors: [
        { turnId: 'p1', sessionId: 's', agentId: 'agent-codex', at: '2026-10-01T15:04:00.000Z', message: 'Provider stopped the turn.', failureClass: 'provider' },
        { turnId: 'p2', sessionId: 's', agentId: 'agent-codex', at: '2026-10-01T15:05:00.000Z', message: 'Provider stopped another turn.', failureClass: 'provider' },
        { turnId: 'p3', sessionId: 's', agentId: 'agent-codex', at: '2026-10-01T15:06:00.000Z', message: 'Provider stopped a third turn.', failureClass: 'provider' },
        { turnId: 'u1', sessionId: 's', agentId: 'missing', at: '2026-10-01T12:00:00.000Z', message: 'The turn stopped.', failureClass: 'nope-class', prompt: 'SECRET_PROMPT', raw: { error: 'SECRET_JSON' } },
        { turnId: 'n1', sessionId: 's', agentId: null, at: '2026-10-01T11:00:00.000Z', message: 'Unassigned turn failed.' },
      ],
    })
    const view = mount(<AnalyticsView sessions={sessions} agents={[codex]} connected now={now} />)
    await view.flush()
    await click(buttonNamed(view.host, 'Errors'))
    const mix = view.host.querySelector('[data-analytics-mix]')
    expect(mix?.getAttribute('aria-label')).toContain('Provider error 3')
    expect(mix?.getAttribute('aria-label')).toContain('Other 2')
    expect(mix?.getAttribute('aria-label')).not.toContain('nope-class')
    expect(view.host.textContent).toContain('Provider error 3')
    expect(view.host.textContent).toContain('Permission denied 0')
    expect(view.host.textContent).not.toContain('nope-class')
    expect(view.host.textContent).not.toContain('SECRET_PROMPT')
    expect(view.host.textContent).not.toContain('SECRET_JSON')
    const offenders = [...view.host.querySelectorAll('[data-offender]')].map((node) => node.getAttribute('data-offender'))
    expect(offenders).toEqual(['agent-codex', 'other', 'unassigned'])
    const codexButton = view.host.querySelector('[data-offender="agent-codex"]')
    const otherButton = view.host.querySelector('[data-offender="other"]')
    expect(codexButton?.getAttribute('aria-label')).toContain(new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }).format(3 / 20))
    expect(otherButton?.textContent).toContain(`Rate needs at least ${OFFENDER_RATE_MIN_RUNS} runs`)
    expect(otherButton?.textContent).not.toContain('%')
    await click(otherButton)
    const turns = view.host.querySelector('[data-analytics-turns]')
    expect(turns?.textContent).toContain('The turn stopped.')
    expect(turns?.textContent).toContain('Other')
    expect(turns?.textContent).not.toContain('Provider stopped the turn.')
    expect(turns?.querySelector('[data-failure-class="other"]')?.textContent).toBe('Other')
    expect(view.host.textContent).not.toContain('Ghost')
  })

  it('shows the time zone and update clock, a skeleton, and a refresh', async () => {
    let resolveLoad: ((value: unknown) => void) | undefined
    fetchUsageAnalytics.mockImplementationOnce(() => new Promise((resolve) => { resolveLoad = resolve }))
    const view = mount(<AnalyticsView sessions={sessions} agents={[codex]} connected now={now} />)
    expect(view.host.querySelector('[data-analytics-skeleton="true"]')?.getAttribute('aria-label')).toBe('Loading analytics')
    expect(view.host.querySelector('[data-analytics-card="cost"]')).toBeNull()
    await act(async () => { resolveLoad?.(analyticsFixtures.full) })
    await view.flush()
    expect(view.host.querySelector('[data-analytics-skeleton="true"]')).toBeNull()
    expect(view.host.textContent).toContain('Time zone Europe/London')
    expect(view.host.textContent).toContain('Updated 13:00')
    const calls = fetchUsageAnalytics.mock.calls.length
    await click(buttonNamed(view.host, 'Refresh'))
    await view.flush()
    expect(fetchUsageAnalytics.mock.calls.length).toBe(calls + 1)
    expect(view.host.textContent).toContain('Updated 13:00')
  })

  it('persists range, bucket, metric, and tab, and resets a missing project to All', async () => {
    localStorage.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify({ days: 90, bucket: 'week', metric: 'cost', panel: 'errors', projectKey: 'c:\\missing-project' }))
    const view = mount(<AnalyticsView sessions={sessions} agents={[claude, codex]} connected now={now} />)
    await view.flush()
    const tz = resolvedTimeZone()
    expect(requests()[0]).toEqual(buildAnalyticsRequest({ days: 90, bucket: 'week', now, timeZone: tz }))
    expect(requests()[0]?.projectPath).toBeUndefined()
    expect(view.host.querySelector('#analytics-tab-errors')?.getAttribute('aria-selected')).toBe('true')
    expect(selectValue(view.host, 'Project')).toBe('')
    const offered = (await selectOptions(view.host, 'Project')).map((option) => option.value)
    expect(offered).toEqual(['', ...analyticsProjectChoices(sessions).map((option) => option.key)])
    expect(offered).not.toContain('c:\\missing-project')
    await click(buttonNamed(view.host, 'Overview'))
    expect(view.host.querySelector('[aria-label="Chart metric"] [aria-pressed="true"]')?.textContent).toBe('Tokens')
    await click(buttonNamed(view.host, '30 days'))
    await view.flush()
    expect(JSON.parse(localStorage.getItem(ANALYTICS_STORAGE_KEY) ?? '{}')).toMatchObject({ days: 30, bucket: 'week', metric: 'tokens', panel: 'overview' })
    await click(buttonNamed(view.host, 'Errors'))
    expect(JSON.parse(localStorage.getItem(ANALYTICS_STORAGE_KEY) ?? '{}').panel).toBe('errors')
    view.unmount()

    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    try {
      fetchUsageAnalytics.mockResolvedValueOnce(analyticsFixtures.full)
      const resilient = mount(<AnalyticsView sessions={sessions} agents={[codex]} connected now={now} />)
      await resilient.flush()
      expect(figure(resilient.host, 'runs')).toBe('40')
      await click(buttonNamed(resilient.host, '30 days'))
      await resilient.flush()
      expect(requests().at(-1)?.from).toBe(buildAnalyticsRequest({ days: 30, bucket: 'day', now, timeZone: tz }).from)
    } finally {
      setItem.mockRestore()
      getItem.mockRestore()
    }
  })

  it('drops a project that is no longer in the session list', async () => {
    function Harness() {
      const [list, setList] = useState(sessions)
      return <>
        <button type="button" onClick={() => setList([])}>Clear projects</button>
        <AnalyticsView sessions={list} agents={[claude, codex]} connected now={now} />
      </>
    }
    const view = mount(<Harness />)
    await view.flush()
    await chooseProject(view.host, 'site · work')
    await view.flush()
    expect(requests().at(-1)?.projectPath).toBe('c:\\work\\site\\')
    await click(buttonNamed(view.host, 'Clear projects'))
    await view.flush()
    expect(selectValue(view.host, 'Project')).toBe('')
    expect((await selectOptions(view.host, 'Project')).map((option) => option.label)).toEqual(['All projects'])
    expect(requests().at(-1)?.projectPath).toBeUndefined()
  })

  it('moves analytics tabs with the arrow keys', async () => {
    const view = mount(<AnalyticsView sessions={sessions} agents={[codex]} connected now={now} />)
    await view.flush()
    const overview = view.host.querySelector<HTMLButtonElement>('#analytics-tab-overview')
    overview?.focus()
    await act(async () => { overview?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
    expect(view.host.querySelector('#analytics-tab-errors')?.getAttribute('aria-selected')).toBe('true')
    expect(view.host.querySelector('#analytics-tab-errors')?.getAttribute('aria-label') ?? view.host.querySelector('#analytics-tab-errors')?.textContent).toBe('Errors')
    view.unmount()
  })
})
