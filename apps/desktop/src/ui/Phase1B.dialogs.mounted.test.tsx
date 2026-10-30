// @vitest-environment happy-dom
// Phase 1B: creating a project and reporting a problem. Both go outside the app,
// so each must show what will happen and wait for the owner.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rpc: vi.fn(), openProjectFolder: vi.fn(), openSafeLink: vi.fn() }))
vi.mock('../tauri', () => ({ rpc: h.rpc, openProjectFolder: h.openProjectFolder }))
vi.mock('./openSafeLink', () => ({ openSafeLink: h.openSafeLink }))

import { folderNameProblem, NewProjectDialog, scaffoldPlan } from './NewProjectDialog'
import { issueUrl, ReportProblemDialog } from './ReportProblemDialog'

let root: Root | null = null
let host: HTMLDivElement | null = null
beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; h.rpc.mockReset(); h.openProjectFolder.mockReset(); h.openSafeLink.mockReset() })
afterEach(() => { if (root) act(() => root!.unmount()); root = null; host?.remove(); host = null })
async function mount(node: React.ReactNode) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(node); await Promise.resolve(); await Promise.resolve() })
  return host
}
const settle = () => act(async () => { for (let index = 0; index < 8; index++) await Promise.resolve() })
const button = (view: HTMLElement, label: string) => [...view.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.includes(label))
async function type(field: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
const check = (view: HTMLElement, label: string) => [...view.querySelectorAll('label')].find((item) => item.textContent?.includes(label))!.querySelector<HTMLInputElement>('input')!

describe('new project', () => {
  it('refuses names Windows can\u2019t use, like the daemon', () => {
    expect(folderNameProblem('')).toBe('Give the project a name.')
    expect(folderNameProblem('good name-1')).toBeNull()
    expect(folderNameProblem('a/b')).toContain('folder name')
    expect(folderNameProblem('name.')).toContain('end with')
    expect(folderNameProblem('CON')).toContain('reserves')
    expect(folderNameProblem('com1.txt')).toContain('reserves')
    expect(folderNameProblem('x'.repeat(81))).toContain('80')
  })

  it('spells out what the owner is approving', () => {
    expect(scaffoldPlan('site', 'D:\\work\\', false, null, null)).toEqual(['Create the folder D:\\work\\site', 'Add it to Bitbots as a project'])
    expect(scaffoldPlan('site', 'D:\\work', true, 'private', 'me')[3]).toBe('Create a private GitHub repository under me and push to it')
  })

  it('creates a private GitHub repository only when asked, after showing the steps, then reports each step', async () => {
    const project = { id: 'p9', name: 'site', path: 'D:/work/site', sortOrder: 0 }
    h.rpc.mockImplementation(async (method: string) => {
      if (method === 'project.scaffold.status') return { git: true, gh: { available: true, login: 'me' } }
      return { project, githubUrl: 'https://github.com/me/site', steps: [{ id: 'folder', status: 'done', detail: null }, { id: 'project', status: 'done', detail: null }, { id: 'git_init', status: 'done', detail: null }, { id: 'first_commit', status: 'done', detail: null }, { id: 'github', status: 'done', detail: null }] }
    })
    h.openProjectFolder.mockResolvedValue('D:/work')
    const onDone = vi.fn()
    const view = await mount(<NewProjectDialog onCancel={vi.fn()} onDone={onDone} />); await settle()
    expect(button(view, 'Create project')?.disabled, 'needs a name and a place').toBe(true)
    await type(view.querySelector<HTMLInputElement>('.new-project-field input')!, 'site')
    await act(async () => { button(view, 'Choose a folder')!.click() }); await settle()
    expect(check(view, 'Also create it on GitHub').checked, 'off until asked').toBe(false)
    expect(view.querySelector('.scaffold-plan')?.textContent).not.toContain('GitHub')
    await act(async () => { check(view, 'Also create it on GitHub').click() })
    expect(view.textContent).toContain('Signed in as me')
    expect(check(view, 'Private').checked, 'private first').toBe(true)
    expect(view.querySelector('.scaffold-plan')?.textContent).toContain('Create a private GitHub repository under me and push to it')
    expect(h.rpc.mock.calls.some(([method]) => method === 'project.scaffold'), 'nothing yet').toBe(false)
    await act(async () => { button(view, 'Create project')!.click() }); await settle()
    expect(h.rpc).toHaveBeenCalledWith('project.scaffold', { name: 'site', parentPath: 'D:/work', git: true, github: { visibility: 'private' }, confirm: true })
    expect(view.querySelector('#new-project-title')?.textContent).toBe('Project created')
    expect(view.textContent).toContain('https://github.com/me/site')
    await act(async () => { button(view, 'Done')!.click() })
    expect(onDone).toHaveBeenCalledWith(project)
  })

  it('keeps GitHub off without the CLI, without a sign-in or without git', async () => {
    h.rpc.mockResolvedValue({ git: true, gh: { available: false, login: null } })
    const view = await mount(<NewProjectDialog onCancel={vi.fn()} onDone={vi.fn()} />); await settle()
    expect(check(view, 'Also create it on GitHub').disabled).toBe(true)
    expect(view.textContent).toContain('Install and sign in to the GitHub CLI')
    act(() => root!.unmount()); root = null; host?.remove()
    h.rpc.mockResolvedValue({ git: true, gh: { available: true, login: null } })
    const signedOut = await mount(<NewProjectDialog onCancel={vi.fn()} onDone={vi.fn()} />); await settle()
    expect(check(signedOut, 'Also create it on GitHub').disabled).toBe(true)
    expect(signedOut.textContent).toContain('gh auth login')
    act(() => root!.unmount()); root = null; host?.remove()
    h.rpc.mockResolvedValue({ git: false, gh: { available: true, login: 'me' } })
    const noGit = await mount(<NewProjectDialog onCancel={vi.fn()} onDone={vi.fn()} />); await settle()
    expect(check(noGit, 'Start a git repository').checked).toBe(false)
    expect(check(noGit, 'Also create it on GitHub').disabled).toBe(true)
    expect(noGit.textContent).toContain('Git isn\u2019t installed'.replace('\u2019', "'"))
  })

  it('reports a failed step and keeps the project that was made', async () => {
    const project = { id: 'p9', name: 'site', path: 'D:/work/site', sortOrder: 0 }
    h.rpc.mockImplementation(async (method: string) => method === 'project.scaffold.status'
      ? { git: true, gh: { available: true, login: 'me' } }
      : { project, githubUrl: null, steps: [{ id: 'folder', status: 'done', detail: null }, { id: 'project', status: 'done', detail: null }, { id: 'git_init', status: 'done', detail: null }, { id: 'first_commit', status: 'failed', detail: 'Git needs your name and email first.' }, { id: 'github', status: 'skipped', detail: null }] })
    h.openProjectFolder.mockResolvedValue('D:/work')
    const onDone = vi.fn()
    const view = await mount(<NewProjectDialog onCancel={vi.fn()} onDone={onDone} />); await settle()
    await type(view.querySelector<HTMLInputElement>('.new-project-field input')!, 'site')
    await act(async () => { button(view, 'Choose a folder')!.click() }); await settle()
    await act(async () => { button(view, 'Create project')!.click() }); await settle()
    expect(view.querySelector('#new-project-title')?.textContent).toBe('Not everything worked')
    expect(view.querySelector('[data-status="failed"]')?.textContent).toContain('Git needs your name and email first.')
    expect(view.querySelector('[data-status="skipped"]')?.textContent).toContain('Skipped')
    await act(async () => { button(view, 'Done')!.click() })
    expect(onDone).toHaveBeenCalledWith(project)
  })
})

describe('report a problem', () => {
  const draft = (gh: { available: boolean; login: string | null }) => ({ repo: 'sico-vibes/bloblex', title: '', body: '## What happened\n\n', url: 'x', gh })

  it('encodes the owner\u2019s edited text and keeps the address bounded', () => {
    const url = issueUrl('sico-vibes/bloblex', 'A & B', 'line one\nline two')
    expect(url).toBe('https://github.com/sico-vibes/bloblex/issues/new?title=A%20%26%20B&body=line%20one%0Aline%20two')
    expect(decodeURIComponent(issueUrl('r/r', 't', 'x'.repeat(9000)).split('body=')[1])).toContain('(cut to fit the address)')
    expect(issueUrl('r/r', 't', 'x'.repeat(9000)).length).toBeLessThan(6200)
  })

  it('posts only the owner\u2019s final text, only when they press Post, and says it is public', async () => {
    h.rpc.mockImplementation(async (method: string) => method === 'diagnostics.issueDraft' ? draft({ available: true, login: 'me' }) : { url: 'https://github.com/sico-vibes/bloblex/issues/7' })
    const view = await mount(<ReportProblemDialog onClose={vi.fn()} />); await settle()
    expect(view.textContent).toContain('public issue at sico-vibes/bloblex')
    expect(button(view, 'Post issue')?.disabled, 'needs a title').toBe(true)
    await type(view.querySelector<HTMLInputElement>('input')!, 'Bots stop answering')
    expect(h.rpc.mock.calls.some(([method]) => method === 'diagnostics.issuePost'), 'nothing posted yet').toBe(false)
    await act(async () => { button(view, 'Post issue')!.click() }); await settle()
    expect(h.rpc).toHaveBeenCalledWith('diagnostics.issuePost', { title: 'Bots stop answering', body: '## What happened\n\n', confirm: true })
    await act(async () => { button(view, 'Open it')!.click() })
    expect(h.openSafeLink).toHaveBeenCalledWith('https://github.com/sico-vibes/bloblex/issues/7')
  })

  it('without the CLI or a sign-in, offers the browser, with the edited text, and no Post button', async () => {
    h.rpc.mockResolvedValue(draft({ available: true, login: null }))
    const view = await mount(<ReportProblemDialog onClose={vi.fn()} />); await settle()
    expect(button(view, 'Post issue')).toBeUndefined()
    await type(view.querySelector<HTMLInputElement>('input')!, 'Broken')
    await act(async () => { button(view, 'Open in browser')!.click() })
    expect(h.openSafeLink).toHaveBeenCalledWith(issueUrl('sico-vibes/bloblex', 'Broken', '## What happened\n\n'))
    expect(h.rpc.mock.calls.some(([method]) => method === 'diagnostics.issuePost')).toBe(false)
  })

  it('shows a refused post and stays open', async () => {
    h.rpc.mockImplementation(async (method: string) => { if (method === 'diagnostics.issueDraft') return draft({ available: true, login: 'me' }); throw new Error('Install and sign in to the GitHub CLI, or open the issue in your browser.') })
    const view = await mount(<ReportProblemDialog onClose={vi.fn()} />); await settle()
    await type(view.querySelector<HTMLInputElement>('input')!, 'Broken')
    await act(async () => { button(view, 'Post issue')!.click() }); await settle()
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('Install and sign in')
    expect(view.querySelector('#report-title')?.textContent).toBe('Report a problem')
  })
})
