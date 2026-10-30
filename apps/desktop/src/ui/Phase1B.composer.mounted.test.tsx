// @vitest-environment happy-dom
// Phase 1B: the stash, notes on a reply, and sending when a usage limit resets.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../tauri', () => ({ rpc: h.rpc, listenForDaemonEvents: async () => () => undefined }))

import { normalizeStashItems, restoreStashItem, stashCaption, StashMenu } from './PromptStash'
import { AnnotationTray, messageAnnotations, MessageAnnotations, selectionInReply } from './ReplyAnnotations'
import { limitResetTime, limitWaitingUntil } from './usageLimitSend'

let root: Root | null = null
let host: HTMLDivElement | null = null
beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; h.rpc.mockReset() })
afterEach(() => { if (root) act(() => root!.unmount()); root = null; host?.remove(); host = null })
async function mount(node: React.ReactNode) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root!.render(node); await Promise.resolve(); await Promise.resolve() })
  return host
}
const settle = () => act(async () => { for (let index = 0; index < 8; index++) await Promise.resolve() })
const stashed = { id: 'k1', text: 'Fix the login page', attachments: [{ file: '0.png', name: 'shot.png' }], agentId: 'a1', agentName: 'Alpha', projectName: 'Korus', createdAt: '2026-10-30T10:00:00.000Z', updatedAt: '2026-10-30T10:00:00.000Z' }

describe('the prompt stash', () => {
  it('reads only well-formed items and says where a draft came from', () => {
    expect(normalizeStashItems('junk')).toEqual([])
    expect(normalizeStashItems([{ text: 'no id' }, stashed, { id: 'k2', attachments: [{ nope: true }] }]).map((item) => [item.id, item.attachments.length])).toEqual([['k1', 1], ['k2', 0]])
    expect(stashCaption({ agentName: 'Alpha', projectName: 'Korus', updatedAt: null })).toBe('Alpha · Korus')
  })

  it('reads the image preview before restoring, because restoring moves the file', async () => {
    const calls: string[] = []
    h.rpc.mockImplementation(async (method: string) => {
      calls.push(method)
      if (method === 'stash.image') return { dataUrl: 'data:image/png;base64,AA' }
      if (method === 'stash.restore') return { item: { text: 'Fix the login page', attachments: [{ path: 'C:/data/stash-restored/x/0.png', name: 'shot.png' }] } }
      throw new Error(method)
    })
    const draft = await restoreStashItem(normalizeStashItems([stashed])[0])
    expect(calls).toEqual(['stash.image', 'stash.restore'])
    expect(draft.text).toBe('Fix the login page')
    expect(draft.attachments).toEqual([{ id: 'stash-k1-0', name: 'shot.png', previewUrl: 'data:image/png;base64,AA', path: 'C:/data/stash-restored/x/0.png', status: 'ready' }])
  })

  it('stashes the box, restores a draft and removes one', async () => {
    let items: unknown[] = [stashed]
    h.rpc.mockImplementation(async (method: string, params: { id?: string }) => {
      if (method === 'stash.list') return { items }
      if (method === 'stash.image') return { dataUrl: '' }
      if (method === 'stash.restore') { items = []; return { item: { text: 'Fix the login page', attachments: [] } } }
      if (method === 'stash.delete') { items = items.filter((item) => (item as { id: string }).id !== params.id); return { deleted: true } }
      throw new Error(method)
    })
    const onStash = vi.fn().mockResolvedValue(true)
    const onRestored = vi.fn()
    const view = await mount(<StashMenu disabled={false} canStash onStash={onStash} onRestored={onRestored} onError={vi.fn()} />); await settle()
    const trigger = view.querySelector<HTMLButtonElement>('.stash-trigger')!
    expect(trigger.getAttribute('aria-label')).toBe('Stash, 1 saved')
    await act(async () => { trigger.click() })
    await act(async () => { view.querySelector<HTMLButtonElement>('.stash-save')!.click() }); await settle()
    expect(onStash).toHaveBeenCalled()
    await act(async () => { trigger.click() })
    expect(view.querySelector('.stash-text')?.textContent).toBe('Fix the login page')
    await act(async () => { view.querySelector<HTMLButtonElement>('.stash-restore')!.click() }); await settle()
    expect(onRestored).toHaveBeenCalledWith({ text: 'Fix the login page', attachments: [] })
    expect(view.querySelector('.stash-trigger')?.getAttribute('aria-label')).toBe('Stash')
  })

  it('in the companion, leaves a draft with images for the full app, and cannot stash an empty box', async () => {
    h.rpc.mockResolvedValue({ items: [stashed, { ...stashed, id: 'k2', attachments: [] }] })
    const view = await mount(<StashMenu textOnly disabled={false} canStash={false} onStash={vi.fn()} onRestored={vi.fn()} onError={vi.fn()} />); await settle()
    await act(async () => { view.querySelector<HTMLButtonElement>('.stash-trigger')!.click() })
    expect(view.querySelector<HTMLButtonElement>('.stash-save')!.disabled).toBe(true)
    expect([...view.querySelectorAll<HTMLButtonElement>('.stash-restore')].map((button) => button.disabled)).toEqual([true, false])
  })

  it('shows a refusal from the daemon', async () => {
    h.rpc.mockResolvedValue({ items: [] })
    const onError = vi.fn()
    const view = await mount(<StashMenu disabled={false} canStash onStash={() => Promise.reject(new Error('The stash is full. Remove something first.'))} onRestored={vi.fn()} onError={onError} />); await settle()
    await act(async () => { view.querySelector<HTMLButtonElement>('.stash-trigger')!.click() })
    await act(async () => { view.querySelector<HTMLButtonElement>('.stash-save')!.click() }); await settle()
    expect(onError).toHaveBeenCalledWith('The stash is full. Remove something first.')
  })
})

describe('notes on a reply', () => {
  function reply(id: string, text: string) {
    const element = document.createElement('article')
    element.dataset.annotateId = id
    element.textContent = text
    return element
  }
  const selection = (anchor: Node | null, focus: Node | null, text: string, collapsed = false) => ({ isCollapsed: collapsed, anchorNode: anchor, focusNode: focus, toString: () => text })

  it('takes a selection only when it lies inside one reply in this conversation', () => {
    const list = document.createElement('section')
    const first = reply('m1', 'First reply'); const second = reply('m2', 'Second reply')
    const mine = document.createElement('article'); mine.textContent = 'My message'
    list.append(first, second, mine)
    const outside = reply('m9', 'Elsewhere')
    expect(selectionInReply(selection(first.firstChild, first.firstChild, ' First '), list)).toMatchObject({ messageId: 'm1', quote: 'First' })
    expect(selectionInReply(selection(first.firstChild, second.firstChild, 'across'), list), 'two replies').toBeNull()
    expect(selectionInReply(selection(mine.firstChild, mine.firstChild, 'My'), list), 'not a reply').toBeNull()
    expect(selectionInReply(selection(outside.firstChild, outside.firstChild, 'Else'), list), 'another list').toBeNull()
    expect(selectionInReply(selection(first.firstChild, first.firstChild, '', true), list), 'nothing selected').toBeNull()
    expect(selectionInReply(selection(first.firstChild, first.firstChild, 'x'.repeat(3000)), list)?.quote).toHaveLength(2000)
  })

  it('shows notes waiting in the composer, and removes one', async () => {
    const onRemove = vi.fn()
    const view = await mount(<AnnotationTray annotations={[{ messageId: 'm1', quote: 'Use a queue here', note: 'Why not a stack?' }]} onRemove={onRemove} />)
    expect(view.textContent).toContain('Use a queue here')
    expect(view.textContent).toContain('Why not a stack?')
    await act(async () => { view.querySelector<HTMLButtonElement>('button')!.click() })
    expect(onRemove).toHaveBeenCalledWith(0)
  })

  it('draws the stored notes on a sent message and ignores anything malformed', async () => {
    expect(messageAnnotations({ annotations: 'nope' })).toEqual([])
    expect(messageAnnotations({ annotations: [{ quote: 'q' }, { quote: 'q', note: 'n', messageId: 'm1' }] })).toHaveLength(1)
    const view = await mount(<MessageAnnotations meta={{ annotations: [{ messageId: 'm1', quote: 'Use a queue here', note: 'Why not a stack?' }] }} />)
    expect(view.querySelector('blockquote')?.textContent).toBe('Use a queue here')
    expect(view.querySelector('p')?.textContent).toBe('Why not a stack?')
  })
})

describe('sending when a usage limit resets', () => {
  const now = Date.parse('2026-10-30T10:00:00.000Z')
  it('waits only for a reset still in the future', () => {
    expect(limitWaitingUntil({ limitedUntil: '2026-10-30T12:00:00.000Z' }, now)).toBe('2026-10-30T12:00:00.000Z')
    expect(limitWaitingUntil({ limitedUntil: '2026-10-30T09:00:00.000Z' }, now)).toBeNull()
    expect(limitWaitingUntil({ limitedUntil: null }, now)).toBeNull()
    expect(limitWaitingUntil({ limitedUntil: 'soon' }, now)).toBeNull()
    expect(limitWaitingUntil(null, now)).toBeNull()
  })
  it('adds the date only when the reset is on another day', () => {
    const today = new Date(now); today.setHours(23, 0, 0, 0)
    expect(limitResetTime(today.toISOString(), now)).not.toContain(',')
    const later = new Date(now + 3 * 86_400_000)
    expect(limitResetTime(later.toISOString(), now)).toContain(',')
  })
})
