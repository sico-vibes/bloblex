// @vitest-environment happy-dom
// Phase 3: the review screen, the pull request form, adding projects, leftover task copies and search.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.fn()
const openProjectFolder = vi.fn()
const pushUndoToast = vi.fn()
vi.mock('../tauri', () => ({
  inDesktop: true,
  rpc: (...args: unknown[]) => rpc(...args),
  openProjectFolder: (...args: unknown[]) => openProjectFolder(...args),
  revealInExplorer: vi.fn(),
  openExternal: vi.fn(),
}))
vi.mock('./undo', () => ({ pushUndoToast: (...args: unknown[]) => pushUndoToast(...args) }))
vi.mock('./openSafeLink', () => ({ openSafeLink: vi.fn() }))

import { ChangesView } from './ChangesView'
import { DiffBody, commentsMessage, type LineComment } from './DiffBody'
import { PullRequestDialog, pullRequestPlan, type PullRequestDraft } from './PullRequestDialog'
import { CloneProject, DiscoverProjects, cloneUrlProblem, nameFromCloneUrl } from './ProjectSources'
import { AbandonedWorktrees, wouldLose } from './AbandonedWorktrees'
import { FileMentionOptions, HighlightedPath, ProjectSearchDialog, groupByFile } from './ProjectSearch'
import { parseCopyFiles } from './ProjectSettingsDialog'
import type { RepositoryState } from './sessionRepository'

const DIFF = ['diff --git a/a.ts b/a.ts', '@@ -1,3 +1,3 @@', ' first', '-old line', '+new line', ' last'].join('\n')
const file = (repositoryPath: string, staged = 'none') => ({ path: `C:/r/${repositoryPath}`, repositoryPath, change: 'modified', addedLines: 1, removedLines: 1, diff: DIFF, binary: false, truncated: false, staged })
const repository = (files = [file('src/a.ts'), file('src/b.ts')]) => ({ projectPath: 'C:/r', repoRoot: 'C:/r', gitRepo: true, branch: 'bitbots/x', detached: false, files, addedLines: 2, removedLines: 2, truncated: false, error: null })

let root: Root | null = null
let host: HTMLDivElement
async function render(element: React.ReactElement) {
  await act(async () => { root!.render(element) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const button = (label: string) => [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label) as HTMLButtonElement
const type = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
const called = (method: string) => rpc.mock.calls.filter((call) => call[0] === method).map((call) => call[1])

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  rpc.mockReset()
  openProjectFolder.mockReset()
  pushUndoToast.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  try { localStorage.clear() } catch { /* not available */ }
})
afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  host.remove()
  document.body.innerHTML = ''
})

describe('DiffBody', () => {
  it('pairs a removal with its addition side by side and keeps numbers apart', async () => {
    await render(<div className="diff-content"><DiffBody content={DIFF} mode="split" path="a.ts" /></div>)
    const rows = [...host.querySelectorAll('.diff-split-row')]
    expect(rows).toHaveLength(3)
    expect(rows[1]!.querySelector('.removed code')?.textContent).toBe('old line')
    expect(rows[1]!.querySelector('.added code')?.textContent).toBe('new line')
  })

  it('offers comments only when it can take them', async () => {
    await render(<div className="diff-content"><DiffBody content={DIFF} mode="unified" path="a.ts" /></div>)
    expect(host.querySelector('.diff-comment-add')).toBeNull()
    await render(<div className="diff-content"><DiffBody content={DIFF} mode="unified" path="a.ts" onAddComment={vi.fn()} /></div>)
    expect(host.querySelectorAll('.diff-comment-add')).toHaveLength(4)
  })

  it('shows a comment once, even when an old and a new line share its number', async () => {
    // The removed line is old line 2, and the added line is new line 2.
    const comments: LineComment[] = [{ id: 'c', path: 'a.ts', line: 2, removed: true, quote: 'old line', text: 'Keep this' }]
    for (const mode of ['unified', 'split'] as const) {
      await render(<div className="diff-content"><DiffBody content={DIFF} mode={mode} path="a.ts" comments={comments} onAddComment={vi.fn()} /></div>)
      expect(host.querySelectorAll('.diff-comment')).toHaveLength(1)
    }
  })

  it('tells the bot where each comment belongs', () => {
    const text = commentsMessage([
      { id: '1', path: 'a.ts', line: 7, removed: false, quote: 'const a = 1', text: 'Rename this' },
      { id: '2', path: 'a.ts', line: 2, removed: true, quote: '', text: 'Why is this gone?' },
    ])
    expect(text).toContain('`a.ts:7` (`const a = 1`): Rename this')
    expect(text).toContain('`a.ts, removed line 2`: Why is this gone?')
  })
})

describe('ChangesView', () => {
  const answers = (extra: Record<string, unknown> = {}) => rpc.mockImplementation(async (method: string) => {
    if (method in extra) { const value = extra[method]; if (value instanceof Error) throw value; return value }
    if (method === 'session.repository') return repository()
    if (method === 'session.git.diff') return { diff: DIFF, truncated: false, binary: false }
    return {}
  })
  const view = (send = vi.fn(async () => undefined)) => <ChangesView sessionId="s1" botName="Sona" onClose={vi.fn()} onSendComments={send} />

  it('reads the whole diff of the first file by conversation and path', async () => {
    answers()
    await render(view())
    await flush()
    expect(called('session.git.diff')[0]).toEqual({ sessionId: 's1', repositoryPath: 'src/a.ts' })
    expect(document.querySelectorAll('.changes-file')).toHaveLength(2)
    expect(document.querySelector('.changes-diff .diff-line.added')?.textContent).toContain('new line')
  })

  it('opens on the file it was asked for', async () => {
    answers()
    await render(<ChangesView sessionId="s1" initialPath="src/b.ts" botName="Sona" onClose={vi.fn()} onSendComments={vi.fn()} />)
    await flush()
    expect(called('session.git.diff')[0]).toEqual({ sessionId: 's1', repositoryPath: 'src/b.ts' })
  })

  it('stages a file and shows the list the daemon sends back', async () => {
    answers({ 'session.git.stage': { files: [file('src/a.ts', 'all'), file('src/b.ts')] } })
    await render(view())
    await flush()
    await act(async () => { button('Stage').click() })
    await flush()
    expect(called('session.git.stage')[0]).toEqual({ sessionId: 's1', paths: ['src/a.ts'], staged: true })
    expect(button('Unstage')).toBeTruthy()
    expect(document.querySelector('.changes-stage-all')?.textContent).toContain('1 staged')
  })

  it('asks before discarding, then offers an undo', async () => {
    answers({ 'session.git.revert': { undoId: 'u1', name: 'a.ts', files: [] } })
    await render(view())
    await flush()
    await act(async () => { button('Discard').click() })
    expect(called('session.git.revert')).toHaveLength(0)
    expect(document.querySelector('.changes-confirm')?.textContent).toContain('Discard?')
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('.changes-confirm button')].find((item) => item.textContent === 'Discard')!.click() })
    await flush()
    expect(called('session.git.revert')[0]).toEqual({ sessionId: 's1', repositoryPath: 'src/a.ts', confirm: true })
    expect(pushUndoToast).toHaveBeenCalledOnce()
    const toast = pushUndoToast.mock.calls[0]![0] as { text: string; undo: () => Promise<void> }
    expect(toast.text).toBe('Discarded the changes to a.ts')
    await toast.undo()
    expect(called('session.git.revertUndo')[0]).toEqual({ sessionId: 's1', undoId: 'u1' })
  })

  it('keeps a refused discard on screen', async () => {
    answers({ 'session.git.revert': new Error('A bot is working in this folder. Stop it or wait, then try again.') })
    await render(view())
    await flush()
    await act(async () => { button('Discard').click() })
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('.changes-confirm button')].find((item) => item.textContent === 'Discard')!.click() })
    await flush()
    expect(document.querySelector('.changes-error')?.textContent).toContain('A bot is working')
    expect(pushUndoToast).not.toHaveBeenCalled()
  })

  it('sends comments as one message and clears them', async () => {
    answers()
    const send = vi.fn(async () => undefined)
    await render(view(send))
    await flush()
    await act(async () => { (document.querySelector('.diff-comment-add') as HTMLButtonElement).click() })
    await type(document.querySelector('.diff-comment-composer textarea') as HTMLTextAreaElement, 'Rename this')
    await act(async () => { button('Add comment').click() })
    expect(document.querySelector('.changes-comments-bar')?.textContent).toContain('1 comment for Sona')
    await act(async () => { button('Send to Sona').click() })
    await flush()
    expect(send).toHaveBeenCalledOnce()
    expect((send.mock.calls[0] as unknown as [string])[0]).toContain('Rename this')
  })

  it('explains a clean repository and one that is not a repository', async () => {
    rpc.mockImplementation(async () => repository([]))
    await render(view())
    await flush()
    expect(document.querySelector('.changes-view')?.textContent).toContain('No changes against the last commit.')
    await act(async () => { root!.unmount() })
    root = createRoot(host)
    rpc.mockImplementation(async () => ({ ...repository([]), gitRepo: false, error: 'This project is not a git repository.' }))
    await render(view())
    await flush()
    expect(document.querySelector('.changes-view')?.textContent).toContain('not a git repository')
  })
})

describe('PullRequestDialog', () => {
  const draft: PullRequestDraft = { ready: true, reason: null, gh: { available: true, login: 'me' }, branch: 'bitbots/x', base: 'main', commitsAhead: 1, uncommitted: 2, title: 'Fix it', body: 'Body', existingUrl: null }
  const state = repository() as unknown as RepositoryState
  const dialog = (onSend = vi.fn(async () => undefined)) => <PullRequestDialog sessionId="s1" repository={state} botName="Sona" busy={false} onSend={onSend} onClose={vi.fn()} />

  it('lists what it will do', () => {
    expect(pullRequestPlan(draft, true, false)).toEqual(['Commit 2 uncommitted files', 'Push bitbots/x to origin', 'Open a pull request into main as me'])
    expect(pullRequestPlan(draft, false, true)).toEqual(['Push bitbots/x to origin', 'Open a draft pull request into main as me'])
  })

  it('creates it from the drafted title, with a commit message', async () => {
    rpc.mockImplementation(async (method: string) => method === 'session.pr.draft' ? draft : { steps: [{ id: 'push', status: 'done', detail: null }], url: 'https://github.com/o/r/pull/1' })
    await render(dialog())
    await flush()
    expect((document.querySelector('.pr-form input') as HTMLInputElement).value).toBe('Fix it')
    await act(async () => { button('Create pull request').click() })
    await flush()
    expect(called('session.pr.create')[0]).toEqual({ sessionId: 's1', title: 'Fix it', body: 'Body', base: 'main', draft: false, commitMessage: 'Fix it', confirm: true })
    expect(document.querySelector('.pr-form h2')?.textContent).toBe('Pull request opened')
    expect(button('Open on GitHub')).toBeTruthy()
  })

  it('leaves uncommitted files out when asked', async () => {
    rpc.mockImplementation(async (method: string) => method === 'session.pr.draft' ? draft : { steps: [], url: null })
    await render(dialog())
    await flush()
    const commit = [...document.querySelectorAll<HTMLLabelElement>('.new-project-check')].find((item) => item.textContent?.includes('uncommitted'))!.querySelector('input')!
    await act(async () => { commit.click() })
    await act(async () => { button('Create pull request').click() })
    await flush()
    expect((called('session.pr.create')[0] as { commitMessage: unknown }).commitMessage).toBeNull()
  })

  it('shows a failed step and what worked', async () => {
    rpc.mockImplementation(async (method: string) => method === 'session.pr.draft' ? draft : { steps: [{ id: 'commit', status: 'done', detail: null }, { id: 'push', status: 'failed', detail: 'Permission denied.' }], url: null })
    await render(dialog())
    await flush()
    await act(async () => { button('Create pull request').click() })
    await flush()
    expect(document.querySelector('.pr-form h2')?.textContent).toBe('Not everything worked')
    expect(document.querySelector('.scaffold-steps')?.textContent).toContain('Permission denied.')
  })

  it('gives the reason and offers the bot when it can not do it itself', async () => {
    const onSend = vi.fn(async () => undefined)
    rpc.mockImplementation(async () => ({ ...draft, ready: false, reason: "The GitHub CLI isn't signed in." }))
    await render(dialog(onSend))
    await flush()
    expect(document.querySelector('.pr-dialog')?.textContent).toContain("The GitHub CLI isn't signed in.")
    await act(async () => { button('Ask Sona to create it').click() })
    await flush()
    expect(onSend).toHaveBeenCalledOnce()
    expect(called('session.pr.create')).toHaveLength(0)
  })

  it('offers the bot when the draft can not be read, and points at an open one', async () => {
    rpc.mockRejectedValue(new Error('nope'))
    await render(dialog())
    await flush()
    expect(button('Ask Sona to create it')).toBeTruthy()
    await act(async () => { root!.unmount() })
    root = createRoot(host)
    rpc.mockReset()
    rpc.mockResolvedValue({ ...draft, existingUrl: 'https://github.com/o/r/pull/9' })
    await render(dialog())
    await flush()
    expect(button('Open it on GitHub')).toBeTruthy()
    expect(document.querySelector('.pr-form')).toBeNull()
  })
})

describe('adding projects', () => {
  it('names the folder from the URL', () => {
    expect(nameFromCloneUrl('https://github.com/owner/repo.git')).toBe('repo')
    expect(nameFromCloneUrl('git@github.com:owner/repo.git')).toBe('repo')
    expect(nameFromCloneUrl('https://github.com/owner/repo/')).toBe('repo')
  })

  it('explains the URLs it refuses', () => {
    expect(cloneUrlProblem('https://github.com/o/r.git')).toBeNull()
    expect(cloneUrlProblem('git@github.com:o/r.git')).toBeNull()
    expect(cloneUrlProblem('ssh://git@host/o/r')).toBeNull()
    for (const bad of ['', 'http://x/y', 'file:///c/x', 'ext::sh -c x', '--upload-pack=x', 'C:\\repo']) expect(cloneUrlProblem(bad)).not.toBeNull()
    expect(cloneUrlProblem('https://me:secret@github.com/o/r')).toContain('no password')
  })

  it('clones with confirm, then reports the result', async () => {
    let state = 'running'
    openProjectFolder.mockResolvedValue('C:\\work')
    rpc.mockImplementation(async (method: string) => {
      const job = { id: 'j1', url: 'u', target: 'C:\\work\\repo', state, detail: null, project: state === 'done' ? { id: 'p1' } : null }
      if (method === 'project.clone') return { job }
      if (method === 'project.clone.list') return { jobs: [job] }
      return {}
    })
    const done = vi.fn()
    await render(<CloneProject onCancel={vi.fn()} onDone={done} onBusy={vi.fn()} />)
    await type(host.querySelector('input') as HTMLInputElement, 'https://github.com/o/repo.git')
    await act(async () => { (host.querySelector('.new-project-browse') as HTMLButtonElement).click() })
    await flush()
    await act(async () => { button('Clone').click() })
    await flush()
    expect(called('project.clone')[0]).toEqual({ url: 'https://github.com/o/repo.git', parent: 'C:\\work', name: null, confirm: true })
    expect(host.textContent).toContain('Cloning.')
    state = 'done'
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)) })
    expect(host.textContent).toContain('Cloned and added as a project')
    await act(async () => { button('Done').click() })
    expect(done).toHaveBeenCalledWith({ id: 'p1' })
  })

  it('finds repositories and adds only the chosen ones', async () => {
    openProjectFolder.mockResolvedValue('C:\\work')
    rpc.mockImplementation(async (method: string, params: { name?: string }) => {
      if (method === 'project.discover') return { repos: [{ path: 'C:\\work\\a', name: 'a', branch: 'main', alreadyAdded: true }, { path: 'C:\\work\\b', name: 'b', branch: null, alreadyAdded: false }, { path: 'C:\\work\\c', name: 'c', branch: null, alreadyAdded: false }], truncated: false }
      if (method === 'project.create') return { project: { id: params.name } }
      return {}
    })
    const done = vi.fn()
    await render(<DiscoverProjects onCancel={vi.fn()} onDone={done} />)
    await act(async () => { (host.querySelector('.new-project-browse') as HTMLButtonElement).click() })
    await flush()
    await flush()
    const boxes = [...host.querySelectorAll<HTMLInputElement>('.discover-list input')]
    expect(boxes.map((box) => box.disabled)).toEqual([true, false, false])
    await act(async () => { boxes[2]!.click() })
    await act(async () => { button('Add 1 project').click() })
    await flush()
    expect(called('project.create')).toEqual([{ name: 'c', path: 'C:\\work\\c' }])
    expect(done).toHaveBeenCalledWith({ id: 'c' })
  })

  it('checks the files to copy', () => {
    expect(parseCopyFiles('.env.local\n\n  config/dev.json \n.env.local')).toEqual({ paths: ['.env.local', 'config/dev.json'], problem: null })
    for (const bad of ['../secret', 'C:\\x', '/etc/x', 'a/../b', '*.env', 'a?b']) expect(parseCopyFiles(bad).problem).not.toBeNull()
  })
})

describe('leftover task copies', () => {
  const item = { id: 'w1', repo: 'C:/r', path: 'C:/r-bitbots/x', branch: 'bitbots/x', reason: 'conversation_deleted', dirtyFiles: 0, commitsAhead: 0, lastActivityAt: null }

  it('says what would be lost', () => {
    expect(wouldLose({ dirtyFiles: 0, commitsAhead: 3 }, false)).toBeNull()
    expect(wouldLose({ dirtyFiles: 0, commitsAhead: 3 }, true)).toBe('3 commits')
    expect(wouldLose({ dirtyFiles: 1, commitsAhead: 1 }, true)).toBe('1 uncommitted file and 1 commit')
  })

  it('removes a clean copy without force, and lists nothing silently', async () => {
    rpc.mockImplementation(async (method: string) => method === 'worktree.abandoned' ? { items: [item] } : { removed: true })
    await render(<AbandonedWorktrees />)
    await flush()
    expect(called('worktree.removeAbandoned')).toHaveLength(0)
    await act(async () => { button('Remove').click() })
    await flush()
    expect(called('worktree.removeAbandoned')[0]).toEqual({ id: 'w1', deleteBranch: true, force: false, confirm: true })
  })

  it('keeps the branch by default when it has commits, and asks before losing work', async () => {
    const risky = { ...item, dirtyFiles: 2, commitsAhead: 3 }
    rpc.mockImplementation(async (method: string) => method === 'worktree.abandoned' ? { items: [risky] } : { removed: true })
    await render(<AbandonedWorktrees />)
    await flush()
    await act(async () => { button('Remove').click() })
    expect(called('worktree.removeAbandoned')).toHaveLength(0)
    expect(host.querySelector('.worktree-confirm')?.textContent).toContain('2 uncommitted files will be lost.')
    await act(async () => { button('Remove anyway').click() })
    await flush()
    expect(called('worktree.removeAbandoned')[0]).toEqual({ id: 'w1', deleteBranch: false, force: true, confirm: true })
  })

  it('keeps the row and says why when the folder is still in use', async () => {
    rpc.mockImplementation(async (method: string) => method === 'worktree.abandoned' ? { items: [item] } : { removed: false, detail: 'Something is still using its folder.' })
    await render(<AbandonedWorktrees />)
    await flush()
    await act(async () => { button('Remove').click() })
    await flush()
    expect(host.querySelector('.worktree-copy .new-project-error')?.textContent).toBe('Something is still using its folder.')
    expect(called('worktree.abandoned')).toHaveLength(1)
    expect(button('Remove').disabled).toBe(false)
  })

  it('says so when there is nothing to clean up', async () => {
    rpc.mockResolvedValue({ items: [] })
    await render(<AbandonedWorktrees />)
    await flush()
    expect(host.textContent).toContain('No leftover task copies.')
  })
})

describe('project search', () => {
  it('groups results by file, in order', () => {
    expect(groupByFile([{ path: 'a', line: 1, preview: '' }, { path: 'b', line: 2, preview: '' }, { path: 'a', line: 3, preview: '' }]).map((group) => [group.path, group.rows.length])).toEqual([['a', 2], ['b', 1]])
  })

  it('picks out the matched characters', async () => {
    await render(<HighlightedPath path="src/app.ts" matches={[4, 5]} />)
    expect([...host.querySelectorAll('b')].map((item) => item.textContent)).toEqual(['ap'])
  })

  it('numbers file options after the bots, for the keyboard', async () => {
    const pick = vi.fn()
    const hover = vi.fn()
    await render(<FileMentionOptions files={[{ path: 'a.ts', name: 'a.ts', score: 1, matches: [] }]} firstIndex={2} activeIndex={2} onPick={pick} onHover={hover} />)
    expect(host.querySelector('.mention-option')?.getAttribute('aria-selected')).toBe('true')
    await act(async () => { host.querySelector('.mention-option')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(pick).toHaveBeenCalledOnce()
  })

  it('searches by conversation, mentions a result and shows a bad pattern', async () => {
    rpc.mockImplementation(async (_method: string, params: { regex?: boolean }) => params.regex ? { results: [], reason: "That isn't a valid search pattern." } : { results: [{ path: 'a.ts', line: 7, preview: 'const x' }], truncated: false, reason: null })
    const mention = vi.fn()
    await render(<ProjectSearchDialog target={{ sessionId: 's1' }} canPreview={false} onClose={vi.fn()} onMention={mention} />)
    await type(document.querySelector('.project-search input') as HTMLInputElement, 'const')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)) })
    expect(called('project.content.search')[0]).toEqual({ sessionId: 's1', query: 'const', caseSensitive: false, regex: false, limit: 200 })
    expect(document.querySelector('.project-search-foot')?.textContent).toContain('1 result in 1 file')
    await act(async () => { button('Regular expression').click() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)) })
    expect(document.querySelector('.project-search-body')?.textContent).toContain("That isn't a valid search pattern.")
    await act(async () => { button('Regular expression').click() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)) })
    await act(async () => { (document.querySelector('.project-search-group li button') as HTMLButtonElement).click() })
    expect(mention).toHaveBeenCalledWith('a.ts:7')
  })

  it('has nothing to search without a folder', async () => {
    await render(<ProjectSearchDialog target={null} canPreview={false} onClose={vi.fn()} onMention={vi.fn()} />)
    expect((document.querySelector('.project-search input') as HTMLInputElement).disabled).toBe(true)
    expect(rpc).not.toHaveBeenCalled()
  })
})
