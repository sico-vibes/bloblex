// Phase 1B: the prompt stash. A draft, with its images, kept by the daemon until
// the owner picks it up in any conversation of any bot. The composer's own draft
// (draftStore.ts) expires after two hours and belongs to one conversation.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Archive, ArchiveRestore, Image as ImageIcon, Trash2 } from 'lucide-react'
import { listenForDaemonEvents, rpc } from '../tauri'
import { moveMenuFocus, usePopoverDismiss, type ComposerAttachment } from './ComposerControls'
import './stash.css'

export type StashAttachment = { file: string; name: string; bytes?: number; mediaType?: string }
export type StashItem = { id: string; text: string; attachments: StashAttachment[]; agentName: string | null; projectName: string | null; updatedAt: string | null }

const text = (value: unknown) => typeof value === 'string' && value ? value : null

/** Accepts only well-formed rows from the daemon. */
export function normalizeStashItems(raw: unknown): StashItem[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((row): StashItem[] => {
    if (!row || typeof row !== 'object') return []
    const item = row as Record<string, unknown>
    if (typeof item.id !== 'string') return []
    const attachments = Array.isArray(item.attachments) ? item.attachments.filter((part): part is StashAttachment => !!part && typeof part === 'object' && typeof (part as StashAttachment).file === 'string' && typeof (part as StashAttachment).name === 'string') : []
    return [{ id: item.id, text: typeof item.text === 'string' ? item.text : '', attachments, agentName: text(item.agentName), projectName: text(item.projectName), updatedAt: text(item.updatedAt) ?? text(item.createdAt) }]
  })
}

/** Where a stashed draft came from and how old it is: "Claude · Board · Oct 30". */
export function stashCaption(item: Pick<StashItem, 'agentName' | 'projectName' | 'updatedAt'>): string {
  const date = item.updatedAt ? new Date(item.updatedAt) : null
  const when = date && !Number.isNaN(date.valueOf()) ? date.toLocaleDateString([], { month: 'short', day: 'numeric' }) : null
  return [item.agentName, item.projectName, when].filter(Boolean).join(' · ')
}

const excerpt = (item: StashItem) => item.text.trim().replace(/\s+/g, ' ').slice(0, 90) || `${item.attachments.length} image${item.attachments.length === 1 ? '' : 's'}`

export type RestoredDraft = { text: string; attachments: ComposerAttachment[] }

/** Takes an item out of the stash: previews first, because `stash.restore` moves the files. */
export async function restoreStashItem(item: StashItem): Promise<RestoredDraft> {
  const previews = await Promise.all(item.attachments.map((part) => rpc<{ dataUrl?: string }>('stash.image', { id: item.id, file: part.file }).then((image) => image?.dataUrl ?? '').catch(() => '')))
  const restored = await rpc<{ item?: { text?: unknown; attachments?: unknown } }>('stash.restore', { id: item.id })
  const parts = Array.isArray(restored?.item?.attachments) ? restored.item.attachments as Array<{ path?: unknown; name?: unknown }> : []
  return {
    text: typeof restored?.item?.text === 'string' ? restored.item.text : '',
    attachments: parts.flatMap((part, index): ComposerAttachment[] => typeof part.path === 'string' ? [{ id: `stash-${item.id}-${index}`, name: typeof part.name === 'string' ? part.name : 'image', previewUrl: previews[index] ?? '', path: part.path, status: 'ready' }] : []),
  }
}

export function StashMenu({ disabled, canStash, textOnly = false, onStash, onRestored, onError }: {
  disabled: boolean
  /** The companion takes no images, so a draft with images stays for the full app. */
  textOnly?: boolean
  /** There is a draft in the box to keep. */
  canStash: boolean
  /** Saves the box to the stash; resolves true once it is safe to clear it. */
  onStash: () => Promise<boolean>
  onRestored: (draft: RestoredDraft) => void
  onError: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<StashItem[]>([])
  const [working, setWorking] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const close = (restoreFocus: boolean) => { setOpen(false); if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus()) }
  usePopoverDismiss(open, rootRef, close)
  const load = useCallback(() => rpc<{ items?: unknown }>('stash.list', {}).then((result) => setItems(normalizeStashItems(result?.items))).catch(() => setItems([])), [])
  useEffect(() => {
    void load()
    let live = true
    let stop: (() => void) | undefined
    void listenForDaemonEvents((event) => { if (event.type === 'stash.changed') void load() }).then((unlisten) => { if (live) stop = unlisten; else unlisten() })
    return () => { live = false; stop?.() }
  }, [load])
  useEffect(() => { if (open) requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()) }, [open])

  const attempt = async (work: () => Promise<void>, failure: string) => {
    setWorking(true)
    try { await work() } catch (reason) { onError(reason instanceof Error && reason.message ? reason.message : failure) } finally { setWorking(false) }
  }
  const stash = () => attempt(async () => { if (await onStash()) { await load(); close(true) } }, 'That draft could not be stashed.')
  const restore = (item: StashItem) => attempt(async () => { onRestored(await restoreStashItem(item)); await load(); close(true) }, 'That draft could not be restored.')
  const remove = (item: StashItem) => attempt(async () => { await rpc('stash.delete', { id: item.id }); setItems((current) => current.filter((row) => row.id !== item.id)) }, 'That draft could not be removed.')

  return <div ref={rootRef} className="composer-popover-anchor stash-anchor">
    <button ref={triggerRef} type="button" className={`composer-icon-button stash-trigger${items.length ? ' has-items' : ''}`} aria-haspopup="menu" aria-expanded={open} aria-label={items.length ? `Stash, ${items.length} saved` : 'Stash'} title="Save this draft for later, or pick up a saved one" disabled={disabled} onClick={() => setOpen((value) => !value)}>
      <Archive size={15} aria-hidden="true" />{items.length > 0 && <span className="stash-count" aria-hidden="true">{items.length}</span>}
    </button>
    {open && <div ref={menuRef} className="composer-menu stash-menu" role="menu" aria-label="Stash" onKeyDown={(event) => { if (moveMenuFocus(menuRef.current, event.key)) event.preventDefault() }}>
      <button type="button" role="menuitem" className="composer-menu-item stash-save" disabled={!canStash || working} onClick={() => void stash()}><Archive size={14} aria-hidden="true" /><span>Stash this draft</span></button>
      {items.length > 0 && <div className="composer-menu-heading">Saved drafts</div>}
      {items.length === 0 && <p className="stash-empty">Nothing saved yet. A stashed draft keeps its images, and you can use it with any bot.</p>}
      <div className="stash-list">{items.map((item) => <div key={item.id} className="stash-row">
        <button type="button" role="menuitem" className="stash-restore" disabled={working || (textOnly && item.attachments.length > 0)} title={textOnly && item.attachments.length > 0 ? 'This draft has images. Open it in the full app.' : 'Put this draft in the message box'} aria-label={`Use draft: ${excerpt(item)}`} onClick={() => void restore(item)}>
          <ArchiveRestore size={14} aria-hidden="true" />
          <span className="stash-copy"><span className="stash-text">{excerpt(item)}</span><small>{item.attachments.length > 0 && <span className="stash-images"><ImageIcon size={11} aria-hidden="true" />{item.attachments.length}</span>}{stashCaption(item)}</small></span>
        </button>
        <button type="button" role="menuitem" className="composer-icon-button stash-remove" disabled={working} aria-label={`Remove draft: ${excerpt(item)}`} title="Remove" onClick={() => void remove(item)}><Trash2 size={13} aria-hidden="true" /></button>
      </div>)}</div>
    </div>}
  </div>
}
