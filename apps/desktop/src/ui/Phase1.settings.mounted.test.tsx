// @vitest-environment happy-dom
// Phase 1: shortcuts, the send shortcut, per-project settings and the new approval mode.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Project, Runtime, Session } from '../types'

const h = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../tauri', () => ({ rpc: h.rpc, listenForDaemonEvents: async () => () => undefined }))

import { PermissionModeControl, sessionApprovalMode } from './ComposerControls'
import { KeybindingEditor } from './KeybindingEditor'
import { normalizeOverrides, ProjectSettingsDialog } from './ProjectSettingsDialog'
import { composerEnterAction, keysFor, matchesShortcut, normalizeBindings, normalizeSendShortcut, oppositeKeys, sendRows, shortcutConflict, shortcutFromEvent, shortcutProblem } from './shortcuts'
import { resetCatalogCacheForTests } from './catalogCache'

let root: Root | null = null
let host: HTMLDivElement | null = null
beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; h.rpc.mockReset(); h.rpc.mockResolvedValue({}); resetCatalogCacheForTests() })
afterEach(() => { if (root) act(() => root!.unmount()); root = null; host?.remove(); host = null })
async function mount(node: React.ReactNode) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(node); await Promise.resolve(); await Promise.resolve() })
  return host
}
const settle = () => act(async () => { for (let index = 0; index < 8; index++) await Promise.resolve() })
const key = (over: Partial<KeyboardEvent>) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, code: '', key: '', ...over }) as KeyboardEvent

describe('the send shortcut', () => {
  const enter = (over: Partial<KeyboardEvent> = {}) => ({ key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, ...over })
  it('with Enter: Enter sends, Ctrl+Enter sends the other way, Shift+Enter is a new line', () => {
    expect(composerEnterAction(enter(), 'enter')).toBe('send')
    expect(composerEnterAction(enter({ ctrlKey: true }), 'enter')).toBe('opposite')
    expect(composerEnterAction(enter({ metaKey: true }), 'enter')).toBe('opposite')
    expect(composerEnterAction(enter({ shiftKey: true }), 'enter')).toBeNull()
  })
  it('with Ctrl+Enter: plain Enter and Shift+Enter are new lines', () => {
    expect(composerEnterAction(enter({ ctrlKey: true }), 'ctrl+enter')).toBe('send')
    expect(composerEnterAction(enter(), 'ctrl+enter')).toBeNull()
    expect(composerEnterAction(enter({ shiftKey: true }), 'ctrl+enter')).toBeNull()
    expect(composerEnterAction(enter({ ctrlKey: true, shiftKey: true }), 'ctrl+enter')).toBe('opposite')
  })
  it('with Shift+Enter: plain Enter and Ctrl+Enter are new lines', () => {
    expect(composerEnterAction(enter({ shiftKey: true }), 'shift+enter')).toBe('send')
    expect(composerEnterAction(enter(), 'shift+enter')).toBeNull()
    expect(composerEnterAction(enter({ ctrlKey: true }), 'shift+enter')).toBeNull()
    expect(composerEnterAction(enter({ ctrlKey: true, shiftKey: true }), 'shift+enter')).toBe('opposite')
  })
  it('never sends mid-composition or for another key, and reads only the three choices', () => {
    expect(composerEnterAction(enter({ isComposing: true } as Partial<KeyboardEvent>), 'enter')).toBeNull()
    expect(composerEnterAction({ ...enter(), key: 'a' }, 'enter')).toBeNull()
    expect(normalizeSendShortcut('ctrl+enter')).toBe('ctrl+enter')
    expect(normalizeSendShortcut('junk')).toBe('enter')
    expect(oppositeKeys('enter')).toBe('Ctrl+Enter')
    expect(oppositeKeys('shift+enter')).toBe('Ctrl+Shift+Enter')
    expect(sendRows('ctrl+enter')).toEqual([['Ctrl+Enter', 'Send a prompt'], ['Enter', 'New line']])
  })
})

describe('shortcuts', () => {
  it('names a key by position, and treats Cmd as Ctrl', () => {
    expect(shortcutFromEvent(key({ ctrlKey: true, code: 'KeyK', key: 'k' }))).toBe('Ctrl+K')
    expect(shortcutFromEvent(key({ metaKey: true, code: 'KeyK', key: 'k' }))).toBe('Ctrl+K')
    expect(shortcutFromEvent(key({ ctrlKey: true, shiftKey: true, code: 'KeyK', key: 'K' }))).toBe('Ctrl+Shift+K')
    expect(shortcutFromEvent(key({ ctrlKey: true, code: 'Backquote', key: '`' }))).toBe('Ctrl+`')
    expect(shortcutFromEvent(key({ code: 'F5', key: 'F5' }))).toBe('F5')
    expect(shortcutFromEvent(key({ ctrlKey: true, code: 'ControlLeft', key: 'Control' })), 'a modifier alone').toBeNull()
    expect(matchesShortcut(key({ ctrlKey: true, code: 'KeyK', key: 'k' }), 'Ctrl+K')).toBe(true)
    expect(matchesShortcut(key({ ctrlKey: true, code: 'KeyK', key: 'k' }), null)).toBe(false)
  })

  it('refuses keys needed for typing or owned by Bitbots, and plain keys', () => {
    for (const taken of ['Ctrl+C', 'Ctrl+V', 'Ctrl+Z', 'Ctrl+Enter', 'Ctrl+E', 'Ctrl+Alt+B']) expect(shortcutProblem(taken), taken).toContain('already used')
    expect(shortcutProblem('K')).toContain('Include Ctrl or Alt')
    expect(shortcutProblem('Shift+K')).toContain('Include Ctrl or Alt')
    expect(shortcutProblem('Ctrl+Shift+N')).toBeNull()
    expect(shortcutProblem('Alt+N')).toBeNull()
    expect(shortcutProblem('F5')).toBeNull()
  })

  it('uses the default until changed, and null means none', () => {
    expect(keysFor('app.quickSwitcher', {})).toBe('Ctrl+K')
    expect(keysFor('app.quickSwitcher', { 'app.quickSwitcher': null })).toBeNull()
    expect(keysFor('conversation.new', {})).toBeNull()
    expect(shortcutConflict('conversation.new', 'Ctrl+K', {})?.id).toBe('app.quickSwitcher')
    expect(shortcutConflict('app.quickSwitcher', 'Ctrl+K', {})).toBeNull()
    expect(normalizeBindings({ 'app.quickSwitcher': 'Ctrl+J', unknown: 'Ctrl+U', 'app.terminal': 5 })).toEqual({ 'app.quickSwitcher': 'Ctrl+J' })
    expect(normalizeBindings('junk')).toEqual({})
  })

  it('records a shortcut, refuses a clash with a reason, removes one and resets it', async () => {
    const onSave = vi.fn().mockResolvedValue(null)
    const view = await mount(<KeybindingEditor bindings={{ 'app.terminal': 'Alt+T' }} disabled={false} onSave={onSave} />)
    const button = (label: string) => view.querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`)!
    const press = async (target: HTMLElement, init: KeyboardEventInit) => { await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) }) }
    await act(async () => { button('Change the shortcut for New conversation').click() })
    expect(view.querySelector('.keybinding-keys.recording')?.textContent).toBe('Press keys…')
    const recording = view.querySelector<HTMLButtonElement>('.keybinding-keys.recording')!
    await press(recording, { ctrlKey: true, code: 'KeyK', key: 'k' })
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('already used for “Open the quick switcher”')
    expect(onSave).not.toHaveBeenCalled()
    await press(recording, { ctrlKey: true, code: 'KeyC', key: 'c' })
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('used for typing')
    await press(recording, { ctrlKey: true, shiftKey: true, code: 'KeyN', key: 'N' })
    expect(onSave).toHaveBeenLastCalledWith({ 'app.terminal': 'Alt+T', 'conversation.new': 'Ctrl+Shift+N' })
    await act(async () => { button('Remove the shortcut for Open the quick switcher').click() })
    expect(onSave).toHaveBeenLastCalledWith({ 'app.terminal': 'Alt+T', 'app.quickSwitcher': null })
    await act(async () => { button('Reset the shortcut for Show or hide the terminal').click() })
    expect(onSave).toHaveBeenLastCalledWith({})
  })

  it('Esc cancels recording without saving', async () => {
    const onSave = vi.fn()
    const view = await mount(<KeybindingEditor bindings={{}} disabled={false} onSave={onSave} />)
    await act(async () => { view.querySelector<HTMLButtonElement>('.keybinding-keys')!.click() })
    await act(async () => { view.querySelector('.keybinding-keys.recording')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape', code: 'Escape' })) })
    expect(view.querySelector('.keybinding-keys.recording')).toBeNull()
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe('approval order', () => {
  const session: Session = { id: 's', runtimeId: 'r', messages: [] }
  const agent = { id: 'a', effectiveApprovalMode: 'auto' } as Agent
  it('is the conversation, then the project, then the bot', () => {
    expect(sessionApprovalMode(session, agent)).toEqual({ mode: 'auto', pinned: false })
    expect(sessionApprovalMode({ ...session, projectApprovalMode: 'accept_edits' }, agent)).toEqual({ mode: 'accept_edits', pinned: false, fromProject: true })
    expect(sessionApprovalMode({ ...session, projectApprovalMode: 'bypass', modelLock: { approvalMode: 'ask' } } as Session, agent)).toEqual({ mode: 'ask', pinned: true })
    expect(sessionApprovalMode(session, null).mode).toBe('ask')
  })

  it('offers Auto-accept edits, and keeps a choice on the conversation when the project sets its own', async () => {
    h.rpc.mockResolvedValue({ session: { ...session, modelLock: { approvalMode: 'accept_edits' } } })
    const view = await mount(<PermissionModeControl session={{ ...session, projectApprovalMode: 'ask' }} agent={agent} disabled={false} onSessionUpdated={vi.fn()} onError={vi.fn()} />)
    await act(async () => { view.querySelector<HTMLButtonElement>('.permission-pill')!.click() })
    expect(view.querySelector('.composer-menu-note')?.textContent).toContain('this changes only this conversation')
    const item = [...view.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((button) => button.textContent?.includes('Auto-accept edits'))!
    await act(async () => { item.click() }); await settle()
    expect(h.rpc).toHaveBeenCalledWith('session.permissions.set', { sessionId: 's', approvalMode: 'accept_edits' })
    expect(h.rpc).not.toHaveBeenCalledWith('agent.update', expect.anything())
  })
})

describe('project settings', () => {
  const project: Project = { id: 'p1', name: 'Korus', path: 'D:/korus', sortOrder: 0 }
  const runtimes = [{ id: 'r1', provider: 'claude', status: 'online' }, { id: 'r2', provider: 'claude', status: 'online' }] as Runtime[]

  it('reads only a well-formed object', () => {
    expect(normalizeOverrides(null)).toEqual({ models: {}, approvalMode: null, setupScript: null })
    expect(normalizeOverrides({ models: { claude: 'x', codex: 5 }, approvalMode: 'nope', setupScript: '   ' })).toEqual({ models: { claude: 'x' }, approvalMode: null, setupScript: null })
  })

  it('saves the whole object, and needs an explicit yes before Full access', async () => {
    const onSaved = vi.fn()
    h.rpc.mockImplementation(async (method: string) => method === 'project.update' ? { project: { ...project } } : { provider: 'claude', models: [] })
    const view = await mount(<ProjectSettingsDialog project={project} runtimes={runtimes} onClose={vi.fn()} onSaved={onSaved} />); await settle()
    // One row per kind of coding agent, not one per launcher.
    expect(view.querySelectorAll('.project-settings-models .new-project-field')).toHaveLength(1)
    const script = view.querySelector<HTMLTextAreaElement>('.project-setup-script')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(script, 'npm install'); script.dispatchEvent(new Event('input', { bubbles: true })) })
    const save = () => [...view.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save')!
    await act(async () => { save().click() }); await settle()
    expect(h.rpc).toHaveBeenCalledWith('project.update', { projectId: 'p1', overrides: { models: {}, approvalMode: null, setupScript: 'npm install' } })
    expect(onSaved).toHaveBeenCalled()
  })

  it('asks for Full access to be accepted, and sends confirm only then', async () => {
    h.rpc.mockImplementation(async (method: string) => method === 'project.update' ? { project: { ...project } } : { provider: 'claude', models: [] })
    const view = await mount(<ProjectSettingsDialog project={{ ...project, overrides: { approvalMode: 'bypass' } }} runtimes={runtimes} onClose={vi.fn()} onSaved={vi.fn()} />); await settle()
    // Already Full access: reopening doesn't ask again.
    expect(view.querySelector('.project-full-access')).toBeNull()
    await act(async () => { [...view.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save')!.click() }); await settle()
    expect(h.rpc).toHaveBeenCalledWith('project.update', { projectId: 'p1', overrides: { models: {}, approvalMode: 'bypass', setupScript: null }, confirm: true })
  })

  it('shows a refusal and stays open', async () => {
    h.rpc.mockImplementation(async (method: string) => { if (method === 'project.update') throw new Error('Confirm Full access for this project first.'); return { provider: 'claude', models: [] } })
    const view = await mount(<ProjectSettingsDialog project={project} runtimes={[]} onClose={vi.fn()} onSaved={vi.fn()} />); await settle()
    expect(view.textContent).toContain('No coding agents found yet.')
    await act(async () => { [...view.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save')!.click() }); await settle()
    expect(view.querySelector('[role="alert"]')?.textContent).toBe('Confirm Full access for this project first.')
  })
})
