// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Session } from '../types'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../tauri', () => ({ rpc }))
vi.mock('./BlobPage', () => ({ ConfirmDialog: ({ title, confirmLabel, onConfirm, onCancel }: { title: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void }) => <div role="dialog"><h2>{title}</h2><button onClick={onCancel}>Cancel</button><button onClick={onConfirm}>{confirmLabel}</button></div> }))

import { AttachButton, AttachmentTray, MessageAttachments, PermissionModeControl, prepareImageBytes, sessionApprovalMode } from './ComposerControls'
import { SessionExecutionControls } from './SessionExecutionControls'

const agent: Agent = { id:'agent', name:'Codex', description:'', instructions:'', color:'sky', runtimeId:'runtime', model:'alpha', thinking:'low', serviceTier:null, customArgs:[], customEnv:{}, maxConcurrency:1, defaultProject:null, sortOrder:0, archived:false, createdAt:'now', updatedAt:'now', approvalMode:'ask', effectiveApprovalMode:'ask' }
const session: Session = { id:'session', runtimeId:'runtime', agentId:'agent', state:'idle', modelLock:{ model:'alpha', thinking:'low' } }
const mounted: Array<{ root: Root; host: HTMLDivElement }> = []
function mount(node: React.ReactNode) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(node))
  mounted.push({ root, host })
  return host
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); rpc.mockReset() })
afterEach(() => { for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() } vi.unstubAllGlobals() })

describe('conversation permission mode', () => {
  it('follows the blob until pinned and treats the blob mode as a reset', () => {
    expect(sessionApprovalMode(session, agent)).toEqual({ mode:'ask', pinned:false })
    expect(sessionApprovalMode({ ...session, modelLock:{ ...session.modelLock, approvalMode:'auto' } }, agent)).toEqual({ mode:'auto', pinned:true })
    expect(sessionApprovalMode(session, { ...agent, effectiveApprovalMode:'bypass' }).mode).toBe('bypass')
  })

  it('pins a conversation mode, confirms full access, and clears the pin when the blob mode is chosen', async () => {
    const updated = vi.fn()
    rpc.mockImplementation(async (_method: string, params: Record<string, unknown>) => ({ session:{ ...session, modelLock:{ ...session.modelLock, approvalMode:params.approvalMode } } }))
    const host = mount(<PermissionModeControl session={session} agent={agent} disabled={false} onSessionUpdated={updated} onError={() => undefined} />)
    const trigger = host.querySelector<HTMLButtonElement>('.permission-pill')!
    expect(trigger.textContent).toContain('Ask first')
    expect(trigger.getAttribute('aria-label')).toContain('blob default')

    await act(async () => { trigger.click() })
    const items = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    expect(items[0].textContent).toContain('Blob default')
    await act(async () => { items[1].click() })
    await flush()
    expect(rpc).toHaveBeenLastCalledWith('session.model.update', { sessionId:'session', approvalMode:'auto' })
    expect(updated).toHaveBeenCalledWith(expect.objectContaining({ modelLock:expect.objectContaining({ approvalMode:'auto' }) }))

    await act(async () => { trigger.click() })
    await act(async () => { host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[2].click() })
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('full access')
    expect(rpc).toHaveBeenCalledTimes(1)
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === 'Allow full access')!.click() })
    await flush()
    expect(rpc).toHaveBeenLastCalledWith('session.model.update', { sessionId:'session', approvalMode:'bypass' })

    await act(async () => { trigger.click() })
    await act(async () => { host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[0].click() })
    await flush()
    expect(rpc).toHaveBeenLastCalledWith('session.model.update', { sessionId:'session', approvalMode:null })
  })

  it('closes on Escape and stays disabled while a turn is running', async () => {
    const host = mount(<PermissionModeControl session={session} agent={agent} disabled onSessionUpdated={() => undefined} onError={() => undefined} />)
    expect(host.querySelector<HTMLButtonElement>('.permission-pill')?.disabled).toBe(true)
    const open = mount(<PermissionModeControl session={session} agent={agent} disabled={false} onSessionUpdated={() => undefined} onError={() => undefined} />)
    await act(async () => { open.querySelector<HTMLButtonElement>('.permission-pill')!.click() })
    expect(open.querySelector('[role="menu"]')).not.toBeNull()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true })) })
    expect(open.querySelector('[role="menu"]')).toBeNull()
  })
})

describe('fast mode', () => {
  const catalog = { runtimeId:'runtime', provider:'codex', validated:true, fallback:false, models:[
    { id:'alpha', displayName:'Alpha', supportedThinking:['low'], defaultThinking:'low', serviceTiers:[{ id:'priority', name:'Fast' }], defaultServiceTier:null, variants:[], hostDependent:false, isDefault:true, group:null, availability:'offered' },
    { id:'beta', displayName:'Beta', supportedThinking:['low'], defaultThinking:'low', serviceTiers:[], defaultServiceTier:null, variants:[], hostDependent:false, isDefault:false, group:null, availability:'offered' },
  ] }

  it('toggles the catalog fast tier for the conversation and marks the pill', async () => {
    rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => method === 'runtime.models' ? catalog : { session:{ ...session, modelLock:{ ...session.modelLock, serviceTier:params.serviceTier } } })
    const updated = vi.fn()
    const host = mount(<SessionExecutionControls session={session} agent={agent} onSessionUpdated={updated} onError={() => undefined} />)
    await flush()
    await act(async () => { host.querySelector<HTMLButtonElement>('.model-pill')!.click() })
    const toggle = host.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await act(async () => { toggle.click() })
    await flush()
    expect(rpc).toHaveBeenLastCalledWith('session.model.update', { sessionId:'session', serviceTier:'priority' })
    expect(updated).toHaveBeenCalledWith(expect.objectContaining({ modelLock:expect.objectContaining({ serviceTier:'priority' }) }))
    // The menu stays open while the setting saves, like the provider apps.
    expect(host.querySelector('[role="menu"]')).not.toBeNull()
  })

  it('shows fast mode as on from the session lock and hides it for models without a fast tier', async () => {
    rpc.mockImplementation(async (method: string) => method === 'runtime.models' ? catalog : {})
    const fast = mount(<SessionExecutionControls session={{ ...session, modelLock:{ model:'alpha', thinking:'low', serviceTier:'priority' } }} agent={agent} onSessionUpdated={() => undefined} onError={() => undefined} />)
    await flush()
    expect(fast.querySelector('.model-pill')?.getAttribute('aria-label')).toContain('fast mode on')
    expect(fast.querySelector('.model-pill-fast')).not.toBeNull()
    const plain = mount(<SessionExecutionControls session={{ ...session, modelLock:{ model:'beta', thinking:'low' } }} agent={agent} onSessionUpdated={() => undefined} onError={() => undefined} />)
    await flush()
    await act(async () => { plain.querySelector<HTMLButtonElement>('.model-pill')!.click() })
    expect(plain.querySelector('[role="menuitemcheckbox"]')).toBeNull()
  })

  it('resolves provider default to the catalog default model for effort and display', async () => {
    rpc.mockImplementation(async (method: string) => method === 'runtime.models' ? catalog : {})
    const host = mount(<SessionExecutionControls session={{ ...session, modelLock:{ model:null, thinking:null } }} agent={agent} onSessionUpdated={() => undefined} onError={() => undefined} />)
    await flush()
    expect(host.querySelector('.model-pill')?.textContent).toContain('Alpha')
    expect(host.querySelector('.model-pill')?.getAttribute('aria-label')).toContain('Provider default (Alpha)')
    expect(host.querySelector('.session-effort-trigger')?.textContent).toBe('Low')
  })
})

describe('composer attachments', () => {
  it('disables the attach button for runtimes without image support and at the image limit', () => {
    const onFiles = vi.fn()
    const unsupported = mount(<AttachButton supported={false} disabled={false} count={0} onFiles={onFiles} />)
    expect(unsupported.querySelector('button')?.disabled).toBe(true)
    expect(unsupported.querySelector('button')?.getAttribute('aria-label')).toBe('This coding agent does not accept images')
    const full = mount(<AttachButton supported disabled={false} count={8} onFiles={onFiles} />)
    expect(full.querySelector('button')?.disabled).toBe(true)
    const ready = mount(<AttachButton supported disabled={false} count={1} onFiles={onFiles} />)
    expect(ready.querySelector('button')?.disabled).toBe(false)
    expect(ready.querySelector('input[type="file"]')?.getAttribute('accept')).toBe('image/png,image/jpeg,image/gif,image/webp')
  })

  it('renders staged, failed and removable thumbnails', async () => {
    const onRemove = vi.fn()
    const host = mount(<AttachmentTray attachments={[
      { id:'a', name:'shot.png', previewUrl:'blob:a', path:null, status:'staging' },
      { id:'b', name:'bad.png', previewUrl:'blob:b', path:null, status:'error', error:'Images must be 10 MB or smaller.' },
    ]} onRemove={onRemove} />)
    expect(host.querySelector('[aria-label="Preparing image"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Images must be 10 MB or smaller."]')).not.toBeNull()
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Remove bad.png"]')!.click() })
    expect(onRemove).toHaveBeenCalledWith('b')
    expect(mount(<AttachmentTray attachments={[]} onRemove={onRemove} />).childElementCount).toBe(0)
  })

  it('lists persisted attachment names on sent messages and ignores malformed values', () => {
    const host = mount(<MessageAttachments attachments={[{ name:'diagram.png', mediaType:'image/png' }, { nope:true }, null]} />)
    expect([...host.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['diagram.png'])
    expect(mount(<MessageAttachments attachments={null} />).childElementCount).toBe(0)
  })

  it('rejects non-image files before staging and keeps small images unchanged', async () => {
    await expect(prepareImageBytes(new File(['text'], 'notes.txt', { type:'text/plain' }))).rejects.toThrow('Only PNG, JPEG, GIF and WebP')
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const result = await prepareImageBytes(new File([bytes], 'tiny.png', { type:'image/png' }))
    expect([...result]).toEqual([...bytes])
  })
})
