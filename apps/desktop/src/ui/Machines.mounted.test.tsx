// @vitest-environment happy-dom
// Phase 4: linking machines, reading another machine's conversations, Take over, and a repository's own settings.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.fn()
const showMainWindow = vi.fn()
vi.mock('../tauri', () => ({
  inDesktop: true,
  rpc: (...args: unknown[]) => rpc(...args),
  showMainWindow: (...args: unknown[]) => showMainWindow(...args),
  listenForDaemonEvents: vi.fn(async () => () => undefined),
  previewBackupImport: vi.fn(),
  selectBackupImportPath: vi.fn(),
  selectBackupExportPath: vi.fn(),
  writeBackupExport: vi.fn(),
  openExternal: vi.fn(),
}))
vi.mock('./openSafeLink', () => ({ openSafeLink: vi.fn() }))
vi.mock('../blob/BlobCanvas', () => ({ BlobCanvas: ({ label }: { label?: string }) => <i data-blob={label} /> }))

import { MachineBadge, MachineGroups } from './MachineBots'
import { CompanionMachineBots, MachineConversation, MovedBar, TakeOverDialog, takeOverState } from './MachineConversation'
import { MachinesPage, PairMachine } from './MachinesPage'
import { canTakeOver, machineBusyBots, machineUrlProblem, normalizeMachines, type Machine, type TakeOverPreview } from './machines'
import { SharedSettingsSection } from './ProjectSettingsDialog'

const bot = (over = {}) => ({ id: 'rae', name: 'Rae', color: 'mint', role: null, provider: 'claude', model: null, busy: false, activeSessionId: null, conversations: 1, ...over })
const machine = (over: Partial<Machine> = {}): Machine => ({ id: 'laptop', name: 'Work laptop', url: 'https://laptop.example.ts.net', auth: 'code', fingerprint: null, tier: 'operator', pairedAt: null, lastSeenAt: null, state: 'online', detail: null, version: '1', bots: [bot()], ...over })
const preview = (over: Partial<TakeOverPreview> = {}): TakeOverPreview => ({ ready: true, reason: null, title: 'T', bot: { id: 'rae', name: 'Rae', provider: 'claude', model: null, agentId: 'rae', willCreate: false }, repo: { identity: 'github.com/a/b', url: 'https://github.com/a/b', branch: 'bitbots/t', isWorktree: true, hasRemote: true }, uncommitted: 0, commitsAhead: 1, project: { id: 'p', name: 'korus' }, needsProject: false, runtimeReady: true, ...over })

let root: Root | null = null
let host: HTMLDivElement
async function render(element: React.ReactElement) {
  await act(async () => { root!.render(element) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const button = (label: string) => [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label) as HTMLButtonElement
const click = async (element: Element | null | undefined) => { await act(async () => { (element as HTMLElement).click() }); await flush() }
const type = async (element: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
}
const called = (method: string) => rpc.mock.calls.filter((call) => call[0] === method).map((call) => call[1])
const replies = (table: Record<string, unknown>) => rpc.mockImplementation(async (method: string) => {
  if (!(method in table)) throw new Error(`no reply for ${method}`)
  const reply = table[method]
  if (reply instanceof Error) throw reply
  return reply
})

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  rpc.mockReset()
  showMainWindow.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  host.remove()
  document.body.innerHTML = ''
})

describe('what the daemon reports', () => {
  it('leaves out a row with no id and fills in the rest', () => {
    const rows = normalizeMachines({ machines: [{ name: 'No id' }, { id: 'a', state: 'nonsense', tier: 'nonsense', bots: [{ name: 'No id' }, { id: 'b', busy: true }] }] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'a', state: 'offline', tier: 'chat', name: 'Another machine' })
    expect(rows[0].bots).toEqual([expect.objectContaining({ id: 'b', busy: true })])
    expect(normalizeMachines(null)).toEqual([])
  })

  it('checks an address before asking the daemon', () => {
    expect(machineUrlProblem('')).toMatch(/Paste/)
    expect(machineUrlProblem('http://a.example')).toMatch(/https/)
    expect(machineUrlProblem('https://me:secret@a.example')).toMatch(/no name or password/)
    expect(machineUrlProblem('https://a.example?x=1')).toMatch(/on its own/)
    expect(machineUrlProblem('https://a.example:8443')).toBeNull()
  })

  it('only an online machine at the top tier can be taken from', () => {
    expect(canTakeOver(machine())).toBe(true)
    expect(canTakeOver(machine({ tier: 'chat' }))).toBe(false)
    expect(canTakeOver(machine({ state: 'offline' }))).toBe(false)
  })

  it('lists working bots with their machine, and none from a removed link', () => {
    const working = machine({ bots: [bot({ busy: true }), bot({ id: 'tom', name: 'Tom' })] })
    expect(machineBusyBots([working, machine({ id: 'gone', state: 'revoked', bots: [bot({ busy: true })] })]).map((item) => `${item.machine.id}/${item.bot.id}`)).toEqual(['laptop/rae'])
  })

  it('says why a conversation can or can\'t be taken over', () => {
    expect(takeOverState(machine(), null, 'me')).toMatchObject({ allowed: true })
    expect(takeOverState(machine({ tier: 'viewer' }), null, 'me')).toMatchObject({ allowed: false, note: expect.stringMatching(/Chat and approve/) })
    expect(takeOverState(machine({ state: 'offline' }), null, 'me').allowed).toBe(false)
    expect(takeOverState(machine({ state: 'revoked' }), null, 'me').note).toMatch(/Pair again/)
    expect(takeOverState(machine(), { link: { movedTo: { machineId: 'me', name: 'Home' } } }, 'me')).toEqual({ allowed: false, note: 'This conversation moved to this machine.' })
    expect(takeOverState(machine(), { link: { movedTo: { machineId: 'x', name: 'Third' } } }, 'me').note).toMatch(/moved to Third/)
  })
})

describe('Settings, Machines', () => {
  it('shows this machine and renames it through the daemon', async () => {
    replies({ 'machine.list': { machines: [] }, 'machine.self': { id: 'me', name: 'Home', version: '1' }, 'machine.self.rename': { id: 'me', name: 'Den', version: '1' } })
    await render(<MachinesPage />)
    await flush()
    expect(document.body.textContent).toContain('Home')
    expect(document.body.textContent).toContain('No other machines yet.')
    await click(button('Rename'))
    const input = document.querySelector<HTMLInputElement>('input[aria-label="This machine\'s name"]')!
    await type(input, 'Den')
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await flush()
    expect(called('machine.self.rename')).toEqual([{ name: 'Den' }])
    expect(document.body.textContent).toContain('Den')
  })

  it('removes a machine only after asking', async () => {
    replies({ 'machine.list': { machines: [machine()] }, 'machine.self': { id: 'me', name: 'Home', version: '1' }, 'machine.remove': { removed: true, signedOut: true } })
    await render(<MachinesPage />)
    await flush()
    await click(button('Remove Work laptop'))
    expect(called('machine.remove')).toEqual([])
    await click(button('Remove'))
    await flush()
    expect(called('machine.remove')).toEqual([{ id: 'laptop', confirm: true }])
  })

  it('pairs by code on a trusted address', async () => {
    replies({ 'machine.probe': { origin: 'o', reachable: true, isBitbots: true, auth: 'code', fingerprint: null, trusted: true }, 'machine.pair.begin': { job: { id: 'j', url: 'u', state: 'approved', detail: null, machine: { name: 'Work laptop' } } } })
    const onDone = vi.fn()
    await render(<PairMachine onDone={onDone} onCancel={vi.fn()} />)
    await type(document.querySelector<HTMLInputElement>('input')!, 'https://laptop.example.ts.net')
    await click(button('Continue'))
    expect(document.body.textContent).not.toContain('Certificate fingerprint')
    await type(document.querySelector<HTMLInputElement>('input')!, 'K7QM-4XPD')
    await click(button('Pair'))
    expect(called('machine.pair.begin')).toEqual([{ url: 'https://laptop.example.ts.net', code: 'K7QM-4XPD', confirm: true }])
    expect(document.body.textContent).toContain('Work laptop is linked.')
    await click(button('Done'))
    expect(onDone).toHaveBeenCalled()
  })

  it('needs the fingerprint compared before a password goes anywhere, and forgets the password', async () => {
    replies({ 'machine.probe': { origin: 'o', reachable: true, isBitbots: true, auth: 'password', fingerprint: 'AB:CD', trusted: false }, 'machine.pair.begin': { job: { id: 'j', url: 'u', state: 'pending', detail: null, machine: null } }, 'machine.pair.list': { jobs: [] } })
    await render(<PairMachine onDone={vi.fn()} onCancel={vi.fn()} />)
    await type(document.querySelector<HTMLInputElement>('input')!, 'https://192.168.1.20:48621')
    await click(button('Continue'))
    expect(document.body.textContent).toContain('AB:CD')
    const [, username, password] = [...document.querySelectorAll<HTMLInputElement>('input')]
    await type(username, 'me')
    await type(password, 'secret')
    expect(button('Pair').disabled).toBe(true)
    await click(document.querySelector('input[type="checkbox"]'))
    expect(button('Pair').disabled).toBe(false)
    await click(button('Pair'))
    expect(called('machine.pair.begin')).toEqual([{ url: 'https://192.168.1.20:48621', username: 'me', password: 'secret', fingerprint: 'AB:CD', confirm: true }])
    expect(document.body.textContent).toContain('Waiting for approval')
    expect(document.querySelector('input[type="password"]')).toBeNull()
  })

  it('stops when the address is not Bitbots or can\'t be reached', async () => {
    replies({ 'machine.probe': { origin: 'o', reachable: true, isBitbots: false, auth: 'code', fingerprint: null, trusted: true } })
    await render(<PairMachine onDone={vi.fn()} onCancel={vi.fn()} />)
    await type(document.querySelector<HTMLInputElement>('input')!, 'https://a.example')
    await click(button('Continue'))
    expect(document.body.textContent).toContain('isn\'t a Bitbots machine')
    expect(called('machine.pair.begin')).toEqual([])
  })
})

describe('another machine\'s bots', () => {
  it('lists them under its name and opens one', async () => {
    const onOpen = vi.fn()
    const laptop = machine({ bots: [bot({ busy: true })] })
    await render(<MachineGroups machines={[laptop]} selected={null} onOpen={onOpen} />)
    expect(document.querySelector('section')?.getAttribute('aria-label')).toBe('Work laptop, another machine')
    const row = button('Rae on Work laptop, working, read only')
    expect(row.textContent).toContain('Working')
    await click(row)
    expect(onOpen).toHaveBeenCalledWith(laptop, laptop.bots[0])
  })

  it('explains a machine that is away or has removed the link', async () => {
    await render(<MachineGroups machines={[machine({ id: 'a', state: 'offline', bots: [] }), machine({ id: 'b', name: 'Old', state: 'revoked' })]} selected={null} onOpen={vi.fn()} />)
    expect(document.body.textContent).toContain('can\'t be reached')
    expect(document.body.textContent).toContain('Old removed this link')
    expect(button('Rae on Old, read only')).toBeUndefined()
  })

  it('shows a conversation read only, with no composer', async () => {
    replies({
      'machine.conversations': { conversations: [{ id: 's1', title: 'Fix it' }] },
      'machine.conversation': { session: { id: 's1', state: 'idle', messages: [{ id: 'a', role: 'user', content: 'Why?' }, { id: 'b', role: 'assistant', content: 'Because.' }, { id: 'c', role: 'thinking', content: 'HIDDEN' }] } },
    })
    await render(<MachineConversation machine={machine()} bot={machine().bots[0]} selfId="me" onClose={vi.fn()} onMoved={vi.fn()} />)
    await flush()
    await flush()
    expect(document.body.textContent).toContain('Why?')
    expect(document.body.textContent).toContain('Because.')
    expect(document.body.textContent).not.toContain('HIDDEN')
    expect(document.querySelector('textarea')).toBeNull()
    expect(button('Take over').disabled).toBe(false)
  })

  it('takes nothing over at a lower tier', async () => {
    replies({ 'machine.conversations': { conversations: [{ id: 's1' }] }, 'machine.conversation': { session: { id: 's1', messages: [] } } })
    const reader = machine({ tier: 'chat' })
    await render(<MachineConversation machine={reader} bot={reader.bots[0]} selfId="me" onClose={vi.fn()} onMoved={vi.fn()} />)
    await flush()
    await flush()
    expect(button('Take over').disabled).toBe(true)
    expect(document.body.textContent).toContain('Chat and approve')
  })
})

describe('Take over', () => {
  it('asks before committing uncommitted files', async () => {
    replies({ 'machine.takeOver.preview': preview({ uncommitted: 2 }), 'machine.takeOver': { job: { id: 'j', state: 'done', steps: [{ id: 'prepare', status: 'done', detail: null }], sessionId: 's1', detail: null } } })
    const onMoved = vi.fn()
    await render(<TakeOverDialog machine={machine()} sessionId="s1" onClose={vi.fn()} onMoved={onMoved} />)
    await flush()
    expect(button('Take over').disabled).toBe(true)
    await click(document.querySelector('input[type="checkbox"]'))
    await click(button('Take over'))
    expect(called('machine.takeOver')).toEqual([{ machineId: 'laptop', sessionId: 's1', projectId: 'p', commitUncommitted: true, confirm: true }])
    await click(button('Open it'))
    expect(onMoved).toHaveBeenCalledWith('s1')
  })

  it('never commits without a copy of its own, and says the files stay', async () => {
    replies({ 'machine.takeOver.preview': preview({ uncommitted: 2, repo: { identity: 'i', url: 'u', branch: 'main', isWorktree: false, hasRemote: true } }), 'machine.takeOver': { job: { id: 'j', state: 'done', steps: [], sessionId: 's1', detail: null } } })
    await render(<TakeOverDialog machine={machine()} sessionId="s1" onClose={vi.fn()} onMoved={vi.fn()} />)
    await flush()
    expect(document.body.textContent).toContain('2 uncommitted files')
    expect(document.querySelector('input[type="checkbox"]')).toBeNull()
    await click(button('Take over'))
    expect(called('machine.takeOver')[0]).toMatchObject({ commitUncommitted: false })
  })

  it.each([
    ['the other machine says no', { ready: false, reason: 'Rae is working. Stop it or wait, then try again.' }, 'Rae is working'],
    ['no coding agent here', { runtimeReady: false, reason: 'This machine has no Claude Code.' }, 'no Claude Code'],
    ['the project isn\'t here', { needsProject: true, project: null }, 'New project, Clone'],
  ])('blocks when %s', async (_name, over, text) => {
    replies({ 'machine.takeOver.preview': preview(over as Partial<TakeOverPreview>) })
    await render(<TakeOverDialog machine={machine()} sessionId="s1" onClose={vi.fn()} onMoved={vi.fn()} />)
    await flush()
    expect(document.body.textContent).toContain(text)
    expect(button('Take over').disabled).toBe(true)
  })

  it('says a new bot comes without Full access', async () => {
    replies({ 'machine.takeOver.preview': preview({ bot: { id: 'rae', name: 'Rae', provider: 'claude', model: null, agentId: null, willCreate: true } }) })
    await render(<TakeOverDialog machine={machine()} sessionId="s1" onClose={vi.fn()} onMoved={vi.fn()} />)
    await flush()
    expect(document.body.textContent).toContain('without Full access')
  })

  it('says it stayed where it was when a step fails', async () => {
    replies({ 'machine.takeOver.preview': preview(), 'machine.takeOver': { job: { id: 'j', state: 'failed', steps: [{ id: 'prepare', status: 'failed', detail: 'The push was rejected.' }], sessionId: null, detail: 'The push was rejected.' } } })
    await render(<TakeOverDialog machine={machine()} sessionId="s1" onClose={vi.fn()} onMoved={vi.fn()} />)
    await flush()
    await click(button('Take over'))
    expect(document.body.textContent).toContain('It stayed where it was')
    expect(document.body.textContent).toContain('The conversation stays on Work laptop.')
    expect(button('Open it')).toBeUndefined()
  })

  it('a moved conversation offers Take over only with a link that allows it', async () => {
    const moved = { machineId: 'laptop', name: 'Work laptop' }
    await render(<MovedBar sessionId="s1" movedTo={moved} machines={[]} onMoved={vi.fn()} />)
    expect(document.body.textContent).toContain('Moved to Work laptop.')
    expect(document.body.textContent).toContain('Settings, Machines')
    expect(button('Take over').disabled).toBe(true)
    await render(<MovedBar sessionId="s1" movedTo={moved} machines={[machine()]} onMoved={vi.fn()} />)
    expect(button('Take over').disabled).toBe(false)
  })
})

describe('the companion', () => {
  it('shows a bot working elsewhere with its machine\'s name, and opens the full app', async () => {
    replies({ 'machine.list': { machines: [machine({ bots: [bot({ busy: true }), bot({ id: 'tom', name: 'Tom' })] })] }, 'machine.self': { id: 'me' } })
    const post = vi.fn()
    vi.stubGlobal('BroadcastChannel', class { postMessage = post; close() {} })
    await render(<CompanionMachineBots />)
    await flush()
    expect(document.querySelector('.companion-machine-bot')?.textContent).toContain('Rae')
    expect(document.querySelector('.machine-badge')?.textContent).toBe('Work laptop')
    expect(document.body.textContent).not.toContain('Tom')
    await click(document.querySelector('.companion-machine-bot'))
    expect(showMainWindow).toHaveBeenCalled()
    expect(post).toHaveBeenCalledWith({ machineId: 'laptop', botId: 'rae' })
    vi.unstubAllGlobals()
  })

  it('shows nothing when no other machine is working', async () => {
    replies({ 'machine.list': { machines: [machine()] }, 'machine.self': { id: 'me' } })
    await render(<CompanionMachineBots />)
    await flush()
    expect(document.querySelector('.companion-machine-bots')).toBeNull()
    await render(<MachineBadge name="X" />)
    expect(document.querySelector('.machine-badge')?.getAttribute('title')).toBe('Running on X')
  })
})

describe('a repository\'s own settings', () => {
  const shared = (over = {}) => ({ found: true, valid: true, problems: [], settings: { setupScript: 'npm install', defaultBot: 'Rae', approvalMode: 'ask' }, hash: 'h1', trusted: false, state: 'untrusted', ...over })

  it('shows what the file asks for, and trusts that exact file', async () => {
    replies({ 'project.sharedSettings.get': shared(), 'project.sharedSettings.trust': shared({ trusted: true, state: 'trusted' }) })
    await render(<SharedSettingsSection projectId="p" hasOwnSettings={false} />)
    await flush()
    expect(document.body.textContent).toContain('npm install')
    expect(document.body.textContent).toContain('Not in use')
    await click(button('Trust this file'))
    expect(called('project.sharedSettings.trust')).toEqual([{ projectId: 'p', hash: 'h1', confirm: true }])
    expect(document.body.textContent).toContain('In use.')
    expect(button('Stop using it')).toBeTruthy()
  })

  it('names what the daemon refused', async () => {
    replies({ 'project.sharedSettings.get': shared({ problems: ['A repository file can\'t turn on Full access.'], settings: { setupScript: 'npm install' } }) })
    await render(<SharedSettingsSection projectId="p" hasOwnSettings={false} />)
    await flush()
    expect(document.body.textContent).toContain('can\'t turn on Full access')
  })

  it('offers to write saved settings, and asks before replacing a file', async () => {
    rpc.mockImplementation(async (method: string, params: { replace?: boolean }) => {
      if (method === 'project.sharedSettings.get') return shared({ found: false, state: 'none', settings: {}, hash: null })
      if (method === 'project.sharedSettings.write' && !params.replace) throw new Error('A .bitbots.json already exists.')
      return shared({ trusted: true, state: 'trusted' })
    })
    await render(<SharedSettingsSection projectId="p" hasOwnSettings />)
    await flush()
    await click(button('Write my saved settings to the file'))
    await click(button('Replace the file'))
    expect(called('project.sharedSettings.write')).toEqual([{ projectId: 'p', confirm: true }, { projectId: 'p', replace: true, confirm: true }])
  })

  it('stays quiet about writing with nothing saved', async () => {
    replies({ 'project.sharedSettings.get': shared({ found: false, state: 'none', settings: {}, hash: null }) })
    await render(<SharedSettingsSection projectId="p" hasOwnSettings={false} />)
    await flush()
    expect(button('Write my saved settings to the file')).toBeUndefined()
    expect(document.body.textContent).toContain('no .bitbots.json')
  })
})
