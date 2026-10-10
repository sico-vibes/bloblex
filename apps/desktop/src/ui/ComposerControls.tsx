// Composer footer controls: permission mode, attachment tray and the shared
// popover behaviour used by the model, effort and context controls.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Check, ChevronDown, Hand, ImageIcon, LoaderCircle, Plus, ShieldCheck, X, CircleAlert } from 'lucide-react'
import type { Agent, ApprovalMode, Session } from '../types'
import { rpc } from '../tauri'
import { ConfirmDialog } from './BlobPage'

/** Closes a popover on outside pointer, Escape or window blur and returns focus to its trigger. */
export function usePopoverDismiss(open: boolean, rootRef: RefObject<HTMLElement | null>, close: (restoreFocus: boolean) => void) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) closeRef.current(false) }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(true) } }
    const onBlur = () => closeRef.current(false)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onBlur)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true); document.removeEventListener('keydown', onKeyDown, true); window.removeEventListener('blur', onBlur) }
  }, [open, rootRef])
}

/** Arrow-key roving focus across the enabled items of a menu. */
export function moveMenuFocus(menu: HTMLElement | null, key: string) {
  const items = Array.from(menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [])
  if (!items.length) return false
  const index = items.indexOf(document.activeElement as HTMLElement)
  const next = key === 'Home' ? 0 : key === 'End' ? items.length - 1 : key === 'ArrowDown' ? (index + 1) % items.length : key === 'ArrowUp' ? (index - 1 + items.length) % items.length : -1
  if (next < 0) return false
  items[next].focus()
  return true
}

export const APPROVAL_MODE_COPY: Record<ApprovalMode, { label: string; title: string; detail: string }> = {
  ask: { label: 'Ask first', title: 'Ask first', detail: 'You approve each command and file change.' },
  auto: { label: 'Auto', title: 'Auto-approve', detail: 'Low-risk actions inside the project run; anything else asks.' },
  bypass: { label: 'Full access', title: 'Full access', detail: 'The agent acts without asking. Use only in projects you trust.' },
}

export function sessionApprovalMode(session: Session, agent: Agent | null): { mode: ApprovalMode; pinned: boolean } {
  const pinned = session.modelLock?.approvalMode
  if (pinned === 'ask' || pinned === 'auto' || pinned === 'bypass') return { mode: pinned, pinned: true }
  const inherited = agent?.effectiveApprovalMode ?? agent?.approvalMode
  return { mode: inherited === 'auto' || inherited === 'bypass' ? inherited : 'ask', pinned: false }
}

function ModeIcon({ mode, size = 14 }: { mode: ApprovalMode; size?: number }) {
  if (mode === 'bypass') return <CircleAlert size={size} aria-hidden="true" />
  if (mode === 'auto') return <ShieldCheck size={size} aria-hidden="true" />
  return <Hand size={size} aria-hidden="true" />
}

export function PermissionModeControl({ session, agent, disabled, onSessionUpdated, onError }: {
  session: Session
  agent: Agent | null
  disabled: boolean
  onSessionUpdated: (session: Session) => void
  onError: (reason: unknown) => void
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmBypass, setConfirmBypass] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { mode, pinned } = sessionApprovalMode(session, agent)
  const blobMode = sessionApprovalMode({ ...session, modelLock: { ...session.modelLock, approvalMode: undefined } }, agent).mode
  const close = (restoreFocus: boolean) => { setOpen(false); if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus()) }
  usePopoverDismiss(open, rootRef, close)
  useEffect(() => { if (open) requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()) }, [open])
  useEffect(() => { setOpen(false); setConfirmBypass(false) }, [session.id])

  const apply = async (next: ApprovalMode | null) => {
    setSaving(true)
    try {
      const result = await rpc<{ session?: Session }>('session.model.update', { sessionId: session.id, approvalMode: next })
      if (result.session?.id === session.id) onSessionUpdated(result.session)
    } catch (reason) { onError(reason) } finally { setSaving(false) }
  }
  const choose = (next: ApprovalMode) => {
    close(true)
    if (next === mode && pinned) return
    if (next === 'bypass') { setConfirmBypass(true); return }
    void apply(next === blobMode ? null : next)
  }
  const copy = APPROVAL_MODE_COPY[mode]
  return <div ref={rootRef} className="composer-popover-anchor">
    <button ref={triggerRef} type="button" className={`composer-pill permission-pill mode-${mode}`} aria-haspopup="menu" aria-expanded={open} aria-label={`Permissions: ${copy.title}${pinned ? ', set for this conversation' : ', blob default'}`} title={copy.detail} disabled={disabled || saving} onClick={() => setOpen((value) => !value)}>
      {saving ? <LoaderCircle size={14} className="spinning" aria-hidden="true" /> : <ModeIcon mode={mode} />}
      <span>{copy.label}</span>
      <ChevronDown size={12} aria-hidden="true" className="composer-pill-chevron" />
    </button>
    {open && <div ref={menuRef} className="composer-menu permission-menu align-left" role="menu" aria-label="Permissions for this conversation" onKeyDown={(event) => { if (moveMenuFocus(menuRef.current, event.key)) event.preventDefault() }}>
      <div className="composer-menu-heading">Permissions</div>
      {(['ask', 'auto', 'bypass'] as const).map((item) => <button key={item} type="button" role="menuitemradio" aria-checked={item === mode} className={`composer-menu-item rich mode-${item}`} onClick={() => choose(item)}>
        <span className="composer-menu-icon"><ModeIcon mode={item} size={15} /></span>
        <span className="composer-menu-text"><strong>{APPROVAL_MODE_COPY[item].title}{item === blobMode && <small className="composer-menu-tag">Blob default</small>}</strong><small>{APPROVAL_MODE_COPY[item].detail}</small></span>
        {item === mode && <Check size={14} className="composer-menu-check" aria-hidden="true" />}
      </button>)}
      <p className="composer-menu-note">Applies to this conversation only.</p>
    </div>}
    {confirmBypass && <ConfirmDialog title="Give this conversation full access?" body="The agent will run commands and change files without asking you. Cancel and Pause all still stop it. The blob's own setting is unchanged." confirmLabel="Allow full access" cancelLabel="Keep asking" onConfirm={() => { setConfirmBypass(false); void apply(blobMode === 'bypass' ? null : 'bypass') }} onCancel={() => setConfirmBypass(false)} />}
  </div>
}

export type ComposerAttachment = {
  id: string
  name: string
  previewUrl: string
  path: string | null
  status: 'staging' | 'ready' | 'error'
  error?: string
}

export function AttachButton({ supported, disabled, count, onFiles }: { supported: boolean; disabled: boolean; count: number; onFiles: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const full = count >= MAX_COMPOSER_ATTACHMENTS
  const label = !supported ? 'This coding agent does not accept images' : full ? `Up to ${MAX_COMPOSER_ATTACHMENTS} images per message` : 'Attach images'
  return <>
    <button type="button" className="composer-icon-button" aria-label={label} title={label} disabled={disabled || !supported || full} onClick={() => inputRef.current?.click()}><Plus size={17} aria-hidden="true" /></button>
    <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden tabIndex={-1} aria-hidden="true" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (files.length) onFiles(files) }} />
  </>
}

export function AttachmentTray({ attachments, onRemove }: { attachments: ComposerAttachment[]; onRemove: (id: string) => void }) {
  if (!attachments.length) return null
  return <ul className="composer-attachments" aria-label="Attached images">
    {attachments.map((item) => <li key={item.id} className={`composer-attachment ${item.status}`} title={item.error ?? item.name}>
      <img src={item.previewUrl} alt={item.name} />
      {item.status === 'staging' && <span className="composer-attachment-state" aria-label="Preparing image"><LoaderCircle size={14} className="spinning" aria-hidden="true" /></span>}
      {item.status === 'error' && <span className="composer-attachment-state error" role="img" aria-label={item.error ?? 'Image could not be attached'}><X size={14} aria-hidden="true" /></span>}
      <button type="button" className="composer-attachment-remove" aria-label={`Remove ${item.name}`} onClick={() => onRemove(item.id)}><X size={11} aria-hidden="true" /></button>
    </li>)}
  </ul>
}

export function MessageAttachments({ attachments }: { attachments: unknown }) {
  const list = Array.isArray(attachments) ? attachments.filter((item): item is { name: string } => !!item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') : []
  if (!list.length) return null
  return <ul className="message-attachments" aria-label="Attached images">{list.map((item, index) => <li key={`${item.name}-${index}`}><ImageIcon size={13} aria-hidden="true" /><span>{item.name}</span></li>)}</ul>
}

export const MAX_COMPOSER_ATTACHMENTS = 8
const MAX_IMAGE_EDGE = 2048
const MAX_UNSCALED_BYTES = 3_500_000

/**
 * Large screenshots are scaled to a 2048px long edge so every provider accepts
 * them; small images keep their original bytes and format.
 */
export async function prepareImageBytes(file: File): Promise<Uint8Array> {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('Only PNG, JPEG, GIF and WebP images can be attached.')
  const original = new Uint8Array(await file.arrayBuffer())
  const unchanged = () => {
    if (original.byteLength > 10 * 1024 * 1024) throw new Error('Images must be 10 MB or smaller.')
    return original
  }
  if (file.type === 'image/gif' || typeof createImageBitmap !== 'function') return unchanged()
  // A decoder failure is not fatal: the daemon re-checks the file signature.
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) return unchanged()
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height)
    if (longEdge <= MAX_IMAGE_EDGE && original.byteLength <= MAX_UNSCALED_BYTES) return original
    const scale = Math.min(1, MAX_IMAGE_EDGE / longEdge)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9))
    if (!blob) throw new Error('The image could not be prepared.')
    const scaled = new Uint8Array(await blob.arrayBuffer())
    if (scaled.byteLength > 10 * 1024 * 1024) throw new Error('Images must be 10 MB or smaller.')
    return scaled
  } finally { bitmap.close() }
}

export function ComposerMenuSection({ title, children }: { title: string; children: ReactNode }) {
  return <div className="composer-menu-section"><div className="composer-menu-heading">{title}</div>{children}</div>
}
