// @vitest-environment happy-dom
// FIX45: the Outputs and Changes cards read the repository itself (`session.repository`), keep the
// conversation's own reported files when Git cannot or does not list them, refresh as the conversation
// and the window change, and offer a Create PR that only asks (it never writes to the repository).
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../tauri', () => ({ rpc: h.rpc, previewMode: false, inDesktop: true }))
vi.mock('../remote/useRemote', () => ({ useRemoteStatus: () => ({ available: false, status: null }) }))
vi.mock('../transport/platform', () => ({ usePlatform: () => ({ editor: true }) }))

import { SessionRail } from './SessionRail'
import { PullRequestDialog } from './PullRequestDialog'
import { CACHE_MAX_ENTRIES, buildRailView, clearRepositoryCache, repositoryCacheSize, samePath, pullRequestPrompt, normalizeRepository, type RepositoryState } from './sessionRepository'
import type { Session } from '../types'

const root = 'C:/work/site'
const file = (name: string, extra: Record<string, unknown> = {}) => ({ path: `${root}/${name}`, repositoryPath: name, change: 'modified', addedLines: 3, removedLines: 1, diff: `@@ -1 +1 @@\n-old ${name}\n+new ${name}`, binary: false, truncated: false, ...extra })
const repo = (extra: Record<string, unknown> = {}) => ({ projectPath: root, repoRoot: root, gitRepo: true, branch: 'feature/rail', detached: false, files: [file('src/App.tsx'), file('docs/new.md', { change: 'added', addedLines: 40, removedLines: 0 })], addedLines: 43, removedLines: 1, truncated: false, error: null, ...extra })
const session = (extra: Partial<Session> = {}): Session => ({ id: 's1', runtimeId: 'rt', agentId: 'a1', projectPath: root, state: 'completed', ...extra })

let host: HTMLDivElement
let reactRoot: Root
let replies: Record<string, unknown | Error | (() => Promise<unknown>)>
const calls = () => h.rpc.mock.calls.map(([method, params]) => [method as string, params as Record<string, unknown>] as const)
const repositoryCalls = () => calls().filter(([method]) => method === 'session.repository')

function Harness({ initial, onCreatePr = vi.fn(), onDiff = vi.fn(), canCreatePr = true, active = true, isManager = false }: { initial: Session; isManager?: boolean; onCreatePr?: (repo: RepositoryState) => void; onDiff?: (path: string, diff: string) => void; canCreatePr?: boolean; active?: boolean }) {
  const [current, setCurrent] = useState<Session>(initial)
  ;(window as unknown as { setSession: (next: Session) => void }).setSession = setCurrent
  return <SessionRail session={current} usage={[]} onOpenFile={vi.fn()} onRevealFile={vi.fn()} onCopyPath={vi.fn()} onDiff={onDiff} onOpenFolder={vi.fn()} botName="Coco" canCreatePr={canCreatePr} onCreatePr={onCreatePr} active={active} isManager={isManager} />
}
const setSession = (next: Session) => act(() => (window as unknown as { setSession: (next: Session) => void }).setSession(next))
async function mount(initial: Session, props: Omit<Parameters<typeof Harness>[0], 'initial'> = {}) {
  await act(async () => { reactRoot.render(<Harness initial={initial} {...props} />); await settle() })
}
async function settle(ms = 0) { for (let index = 0; index < 8; index += 1) await Promise.resolve(); if (ms) await vi.advanceTimersByTimeAsync(ms); for (let index = 0; index < 8; index += 1) await Promise.resolve() }
const rows = () => [...host.querySelectorAll('#rail-changes')].length ? [...(host.querySelector('#rail-changes')?.closest('.rail-card')?.querySelectorAll('.rail-file') ?? [])] : []
const card = (id: string) => host.querySelector(`#rail-${id}`)?.closest('.rail-card') as HTMLElement

beforeEach(() => {
  vi.useFakeTimers()
  clearRepositoryCache()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  replies = { 'session.environment': { projectPath: root, gitRepo: true, branch: 'main', detached: false, host: 'This computer' }, 'session.repository': repo() }
  h.rpc.mockReset()
  h.rpc.mockImplementation(async (method: string) => {
    const reply = replies[method]
    if (reply instanceof Error) throw reply
    return typeof reply === 'function' ? (reply as () => Promise<unknown>)() : reply
  })
  host = document.createElement('div'); document.body.append(host)
  reactRoot = createRoot(host)
})
afterEach(() => { act(() => reactRoot.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('rail repository changes', () => {
  // Owner, 28 October 2026: the Manager has no repository, which is a state to explain, not an error.
  it('explains that the Manager has no code changes instead of showing a Git error', async () => {
    replies['session.repository'] = repo({ gitRepo: false, repoRoot: null, branch: null, files: [], error: 'This project is not a git repository.' })
    await mount(session(), { isManager: true })
    expect(card('changes').textContent).toContain('The Manager works in its own folder')
    expect(card('changes').querySelector('.rail-problem')).toBeNull()
    expect(card('changes').textContent).not.toContain('Git could not be read')
  })

  it('lists the first eight changed files and the rest on request', async () => {
    replies['session.repository'] = repo({ files: Array.from({ length: 12 }, (_, index) => file(`src/f${index}.ts`)) })
    await mount(session())
    expect(rows()).toHaveLength(8)
    const more = card('changes').querySelector<HTMLButtonElement>('.rail-more')!
    expect(more.textContent).toBe('Show all 12 files')
    await act(async () => { more.click(); await settle() })
    expect(rows()).toHaveLength(12)
  })

  it('shows the real branch, every changed file, the totals and says whose changes they are', async () => {
    await mount(session())
    expect(repositoryCalls()).toEqual([['session.repository', { sessionId: 's1' }]])
    const changes = card('changes')
    expect(changes.textContent).toContain('feature/rail')
    expect(changes.textContent).toContain('Every uncommitted change in this repository, not only this conversation')
    expect(rows().map((row) => row.querySelector('.rail-file-name')?.textContent)).toEqual(['App.tsx', 'new.md'])
    expect(changes.querySelector('.rail-diffstat')?.textContent).toBe('+43 −1')
    // The branch shown is the repository's, not the earlier environment reading.
    expect(card('environment').textContent).toContain('feature/rail')
    expect(card('environment').textContent).not.toContain('main')
  })

  it('opens a readable diff through the existing viewer, and lists new files under Outputs', async () => {
    const onDiff = vi.fn()
    await mount(session(), { onDiff })
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-source="repository"] .rail-file-open')!.click() })
    expect(onDiff).toHaveBeenCalledWith(`${root}/src/App.tsx`, expect.stringContaining('+new src/App.tsx'))
    expect(card('outputs').textContent).toContain('new.md')
    expect(card('outputs').textContent).not.toContain('App.tsx')
  })

  it('counts a created file once even when the conversation also reported it, and keeps edits Git no longer lists', async () => {
    await mount(session({ files: [{ id: 'f1', path: `${root}/docs/new.md`, change: 'added' }, { id: 'f2', path: `${root}\\old\\committed.ts`, change: 'modified', diff: '@@ -1 +1 @@\n-a\n+b' }] }))
    expect([...card('outputs').querySelectorAll('.rail-file')]).toHaveLength(1)
    const changes = card('changes')
    expect(changes.textContent).toContain('Edited earlier in this conversation')
    expect(changes.textContent).toContain('committed.ts')
    expect(rows()).toHaveLength(3)
  })

  it('keeps the conversation\'s own files when the folder is clean, not a repository, or Git cannot be read', async () => {
    const history = session({ files: [{ id: 'f1', path: `${root}/src/a.ts`, change: 'modified', diff: '@@ -1 +1 @@\n-a\n+b' }] })
    replies['session.repository'] = repo({ files: [], addedLines: 0, removedLines: 0 })
    await mount(history)
    expect(card('changes').textContent).toContain('No uncommitted changes in site.')
    expect(card('changes').textContent).toContain('a.ts')

    act(() => reactRoot.unmount()); reactRoot = createRoot(host)
    replies['session.repository'] = repo({ gitRepo: false, repoRoot: null, branch: null, files: [] })
    await mount(session({ id: 's2', files: history.files }))
    expect(card('changes').textContent).toContain('not a Git repository')
    expect(card('changes').textContent).toContain('a.ts')
    expect(card('changes').querySelector('.rail-pr')).toBeNull()

    act(() => reactRoot.unmount()); reactRoot = createRoot(host)
    replies['session.repository'] = repo({ error: 'git is not installed.', files: [] })
    await mount(session({ id: 's3', files: history.files }))
    expect(card('changes').querySelector('[role="alert"]')?.textContent).toContain('git is not installed.')
    expect(card('changes').textContent).toContain('Showing what the coding agent reported')
    expect(card('changes').textContent).toContain('a.ts')
    // The failure offers a retry that reads again.
    const before = repositoryCalls().length
    await act(async () => { [...card('changes').querySelectorAll<HTMLButtonElement>('.rail-link')].find((node) => node.textContent === 'Try again')!.click(); await settle() })
    expect(repositoryCalls().length).toBe(before + 1)
  })

  it('says plainly when a diff is binary, cut short, missing, or the file is gone', async () => {
    replies['session.repository'] = repo({ files: [file('logo.png', { binary: true, diff: null, addedLines: null, removedLines: null }), file('big.ts', { truncated: true }), file('gone.ts', { change: 'deleted', diff: null, addedLines: 0, removedLines: 9 }), file('odd.ts', { diff: null })], truncated: true })
    await mount(session())
    const open = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('.rail-file-open')].find((node) => node.textContent?.includes(name))!
    expect(open('logo.png').disabled).toBe(true)
    expect(open('logo.png').title).toContain('Binary file')
    expect(open('logo.png').textContent).toContain('binary')
    expect(open('logo.png').parentElement?.querySelector('.rail-add')).toBeNull()
    expect(open('big.ts').disabled).toBe(false)
    expect(open('big.ts').textContent).toContain('cut short')
    expect(open('gone.ts').disabled).toBe(true)
    expect(open('gone.ts').textContent).toContain('deleted')
    expect(open('gone.ts').parentElement?.querySelector('[aria-label^="Open"]')).toBeNull()
    expect(open('odd.ts').disabled).toBe(true)
    expect(open('odd.ts').title).toContain('did not return a diff')
    expect(card('changes').textContent).toContain('more changed files than are listed')
  })

  it('reserves the card while it first reads, with an accessible status', async () => {
    let finish!: (value: unknown) => void
    replies['session.repository'] = () => new Promise((resolve) => { finish = resolve })
    await mount(session())
    const loading = card('changes').querySelector('[role="status"]')!
    expect(loading.getAttribute('aria-busy')).toBe('true')
    expect(loading.textContent).toContain('Reading the repository')
    expect(loading.querySelectorAll('.skeleton-block').length).toBeGreaterThan(0)
    await act(async () => { finish(repo()); await settle() })
    expect(card('changes').querySelector('[role="status"]')).toBeNull()
    expect(rows()).toHaveLength(2)
  })
})

describe('rail refresh', () => {
  it('reads again when the conversation moves, when the window regains focus, and on a bounded poll', async () => {
    await mount(session({ state: 'working', turns: [{ id: 't1', state: 'working' }] }))
    expect(repositoryCalls()).toHaveLength(1)
    // A command finished and the turn ended.
    await setSession(session({ state: 'completed', turns: [{ id: 't1', state: 'completed' }], tools: [{ id: 'tool-1', state: 'completed' }] }))
    await act(async () => { await settle(700) })
    expect(repositoryCalls()).toHaveLength(2)
    // A burst of focus events inside the minimum gap makes one read at most.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')); await settle() })
    expect(repositoryCalls()).toHaveLength(3)
    // Idle polling is slow (a minute); a running turn polls faster.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(repositoryCalls().length).toBeGreaterThanOrEqual(4)
    const idle = repositoryCalls().length
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(repositoryCalls().length).toBe(idle)
    await setSession(session({ state: 'working', turns: [{ id: 't2', state: 'working' }] }))
    await act(async () => { await settle(700) })
    const working = repositoryCalls().length
    await act(async () => { await vi.advanceTimersByTimeAsync(8_100) })
    expect(repositoryCalls().length).toBeGreaterThan(working)
  })

  it('does not poll a hidden window', async () => {
    await mount(session())
    const before = repositoryCalls().length
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await act(async () => { await vi.advanceTimersByTimeAsync(130_000) })
    expect(repositoryCalls().length).toBe(before)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  })

  it('drops a late reply for a conversation that is no longer open', async () => {
    const pending: Record<string, (value: unknown) => void> = {}
    h.rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'session.environment') return { projectPath: root, gitRepo: true, branch: 'main', detached: false, host: 'This computer' }
      return new Promise((resolve) => { pending[String(params.sessionId)] = resolve })
    })
    await mount(session({ id: 'slow' }))
    await setSession(session({ id: 'fast' }))
    await act(async () => { await settle() })
    await act(async () => { pending.fast(repo({ branch: 'fast-branch', files: [file('fast.ts')] })); await settle() })
    expect(card('changes').textContent).toContain('fast.ts')
    await act(async () => { pending.slow(repo({ branch: 'slow-branch', files: [file('slow.ts')] })); await settle() })
    expect(card('changes').textContent).toContain('fast.ts')
    expect(card('changes').textContent).not.toContain('slow.ts')
    expect(card('changes').textContent).not.toContain('slow-branch')
  })

  it('never asks for a draft conversation and never writes: only reads reach the daemon', async () => {
    await mount(session({ id: 'draft:agent-1' }))
    expect(repositoryCalls()).toHaveLength(0)
    await setSession(session())
    await act(async () => { await settle() })
    expect(repositoryCalls()).toHaveLength(1)
    expect(calls().some(([, params]) => params?.sessionId === 'draft:agent-1')).toBe(false)
    // The workspace, checkpoint, schedule and task cards read too; nothing writes.
    expect(new Set(calls().map(([method]) => method))).toEqual(new Set(['session.environment', 'session.repository', 'session.workspace', 'session.checkpoints', 'automation.list', 'task.list']))
  })
})

describe('rail Create PR', () => {
  it('asks to review first: the card only reports the repository it would use', async () => {
    const onCreatePr = vi.fn()
    await mount(session(), { onCreatePr })
    const button = card('changes').querySelector<HTMLButtonElement>('.rail-pr')!
    expect(button.textContent).toBe('Create PR')
    expect(button.disabled).toBe(false)
    await act(async () => { button.click() })
    expect(onCreatePr).toHaveBeenCalledTimes(1)
    expect(onCreatePr.mock.calls[0][0]).toMatchObject({ branch: 'feature/rail', repoRoot: root, addedLines: 43 })
    // Opening the review sends nothing to the daemon.
    expect(calls().some(([method]) => method === 'session.prompt' || method === 'session.queue.add')).toBe(false)
  })

  it('is disabled, with the reason, when there is nothing to put in a pull request or the bot cannot take a message', async () => {
    replies['session.repository'] = repo({ files: [], addedLines: 0, removedLines: 0 })
    await mount(session())
    const clean = card('changes').querySelector<HTMLButtonElement>('.rail-pr')!
    expect(clean.disabled).toBe(true)
    expect(clean.title).toContain('no changes')
    act(() => reactRoot.unmount()); reactRoot = createRoot(host)
    replies['session.repository'] = repo()
    await mount(session({ id: 's9' }), { canCreatePr: false })
    const offline = card('changes').querySelector<HTMLButtonElement>('.rail-pr')!
    expect(offline.disabled).toBe(true)
    expect(offline.title).toContain('Reconnect')
  })
})

describe('rail Create PR and a failed read', () => {
  it('does not offer a pull request from a stale reading after the repository stops answering', async () => {
    await mount(session())
    expect(card('changes').querySelector<HTMLButtonElement>('.rail-pr')!.disabled).toBe(false)
    replies['session.repository'] = new Error('daemon stopped')
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); window.dispatchEvent(new Event('focus')); await settle() })
    const button = card('changes').querySelector<HTMLButtonElement>('.rail-pr')!
    expect(button.disabled).toBe(true)
    expect(button.title).toContain('could not be read just now')
    expect(card('changes').querySelector('[role="alert"]')?.textContent).toContain('could not be read')
    expect(card('changes').textContent).toContain('App.tsx')
  })

  it('reads nothing while the rail is hidden, and reads as soon as it is shown', async () => {
    await mount(session(), { active: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(130_000); window.dispatchEvent(new Event('focus')); await settle() })
    expect(repositoryCalls()).toHaveLength(0)
    act(() => reactRoot.unmount()); reactRoot = createRoot(host)
    await mount(session(), { active: true })
    expect(repositoryCalls()).toHaveLength(1)
  })
})

describe('pull request review', () => {
  const state = normalizeRepository(repo())!
  const mountDialog = async (onSend: () => Promise<void>, onClose = vi.fn(), busy = false) => {
    await act(async () => { reactRoot.render(<PullRequestDialog sessionId="s1" repository={state} botName="Coco" busy={busy} onSend={onSend} onClose={onClose} />); await settle() })
    return onClose
  }

  it('names the branch, repository and size, and says nothing happens until the owner confirms', async () => {
    await mountDialog(async () => undefined)
    const dialog = host.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('feature/rail')
    expect(dialog.textContent).toContain('site')
    expect(dialog.textContent).toContain('2 files')
    expect(dialog.textContent).toContain('+43')
    expect(dialog.textContent).toContain('not only this conversation')
    expect(dialog.getAttribute('aria-labelledby')).toBe('pr-dialog-title')
  })

  it('closes only after the message is accepted, and stays open with the reason when it is refused', async () => {
    let fail = true
    const onSend = vi.fn(async () => { if (fail) throw new Error('not_signed_in') })
    const onClose = await mountDialog(onSend)
    const confirm = () => [...host.querySelectorAll<HTMLButtonElement>('.blob-dialog-actions button')].find((node) => node.textContent?.startsWith('Ask'))!
    await act(async () => { confirm().click(); await settle() })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    // The refusal is shown in the app's own words, never as a raw daemon code.
    expect(host.querySelector('[role="alert"]')?.textContent).toBeTruthy()
    expect(host.querySelector('[role="alert"]')?.textContent).not.toContain('not_signed_in')
    fail = false
    await act(async () => { confirm().click(); await settle() })
    expect(onSend).toHaveBeenCalledTimes(2)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('tells the owner when the request will wait behind a running turn', async () => {
    await mountDialog(async () => undefined, vi.fn(), true)
    expect(host.textContent).toContain('waits until the current turn ends')
  })

  it('writes the request as an explicit instruction that protects unrelated work and never invents success', () => {
    const prompt = pullRequestPrompt(state)
    expect(prompt).toContain('feature/rail')
    expect(prompt).toContain('git status and git diff')
    expect(prompt).toMatch(/Leave unrelated work alone/)
    expect(prompt).toMatch(/main, master or the repository's default branch, create a suitably named branch/)
    expect(prompt).toMatch(/GitHub CLI \(gh\)/)
    expect(prompt).toMatch(/stop and tell me what is needed/)
    expect(prompt).toMatch(/pull request link, or with exactly what failed/)
  })
})

describe('repository paths and cache', () => {
  it('treats a project-relative path and the repository absolute path as one file, case-insensitively on Windows paths only', () => {
    expect(samePath('src/a.ts', 'C:/work/site/src/a.ts', 'C:/work/site')).toBe(true)
    expect(samePath('.\\src\\A.ts', 'C:\\work\\site\\src\\a.ts', 'C:/work/site')).toBe(true)
    expect(samePath('src/b.ts', 'C:/work/site/src/a.ts', 'C:/work/site')).toBe(false)
    expect(samePath('src/a.ts', '/home/me/site/src/A.ts', '/home/me/site')).toBe(false)
    expect(samePath('src/a.ts', '/home/me/site/src/a.ts', '/home/me/site')).toBe(true)
  })

  it('lists a relative history path once, not again beside the same file from Git', () => {
    const state = normalizeRepository(repo())!
    const view = buildRailView(session({ files: [{ id: 'h1', path: 'docs/new.md', change: 'added' }, { id: 'h2', path: 'src/App.tsx', change: 'modified' }, { id: 'h3', path: 'C:\\work\\site\\other.ts', change: 'modified' }, { id: 'h4', path: 'other.ts', change: 'modified' }] }), state)
    expect(view.created.map((file) => file.name)).toEqual(['new.md'])
    expect(view.earlier.map((file) => file.name)).toEqual(['other.ts'])
  })

  it('keeps only a few readings, so whole diffs are not held for every conversation ever opened', async () => {
    h.rpc.mockImplementation(async (method: string) => method === 'session.repository' ? repo() : { projectPath: root, gitRepo: true, branch: 'main', detached: false, host: 'x' })
    for (let index = 0; index < CACHE_MAX_ENTRIES + 4; index += 1) {
      act(() => reactRoot.unmount()); reactRoot = createRoot(host)
      await mount(session({ id: `many-${index}` }))
    }
    expect(repositoryCacheSize()).toBeLessThanOrEqual(CACHE_MAX_ENTRIES)
    // An evicted conversation reads fresh; a reading never shows under another conversation's id.
    act(() => reactRoot.unmount()); reactRoot = createRoot(host)
    replies['session.repository'] = () => new Promise(() => undefined)
    h.rpc.mockImplementation(async (method: string) => method === 'session.repository' ? new Promise(() => undefined) : { projectPath: root, gitRepo: true, branch: 'main', detached: false, host: 'x' })
    await mount(session({ id: 'never-read' }))
    expect(card('changes').querySelector('[role="status"]')).not.toBeNull()
    expect(card('changes').textContent).not.toContain('App.tsx')
  })
})

describe('repository reply parsing', () => {
  it('accepts only well-formed replies and fills honest defaults', () => {
    expect(normalizeRepository(null)).toBeNull()
    expect(normalizeRepository('nope')).toBeNull()
    const parsed = normalizeRepository({ gitRepo: true, files: [{ path: 'a.ts', change: 'weird', addedLines: -1 }, 5, { nothing: true }], truncated: 'yes' })!
    expect(parsed.files).toEqual([{ path: 'a.ts', repositoryPath: 'a.ts', change: 'modified', addedLines: null, removedLines: null, diff: null, binary: false, truncated: false, staged: 'none' }])
    expect(parsed.truncated).toBe(false)
    expect(parsed.addedLines).toBe(0)
  })
})
