// Composer footer controls: permission mode, attachment tray and the shared
// popover behaviour used by the model, effort and context controls.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Check, ChevronDown, FilePenLine, FileText, Hand, ImageIcon, ImageOff, LoaderCircle, Paperclip, Plus, ShieldCheck, X, CircleAlert } from 'lucide-react'
import type { Agent, ApprovalMode, Session } from '../types'
import { parseApprovalMode } from '../approvalContract'
import { rpc } from '../tauri'
import { ConfirmDialog } from './BlobPage'
import { useEntityNoun } from './vocabulary'

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
  accept_edits: { label: 'Accept edits', title: 'Auto-accept edits', detail: 'Reading and editing files inside the project run; every command asks.' },
  auto: { label: 'Auto', title: 'Auto-approve', detail: 'Low-risk actions inside the project run; anything else asks.' },
  bypass: { label: 'Full access', title: 'Full access', detail: 'The agent acts without asking. Use only in projects you trust.' },
}

/** FIX39 item 13: the one sentence a locked bot's disabled composer controls show. */
export const LOCKED_CONTROL_TOOLTIP = 'This bot is locked. Unlock it to change its settings.'

/** Order: the conversation's own choice, then its project's, then the bot's (which already includes the default). */
export function sessionApprovalMode(session: Session, agent: Agent | null): { mode: ApprovalMode; pinned: boolean; fromProject?: boolean } {
  const pinned = parseApprovalMode(session.modelLock?.approvalMode)
  if (pinned) return { mode: pinned, pinned: true }
  const project = parseApprovalMode(session.projectApprovalMode)
  if (project) return { mode: project, pinned: false, fromProject: true }
  return { mode: parseApprovalMode(agent?.effectiveApprovalMode ?? agent?.approvalMode) ?? 'ask', pinned: false }
}

/**
 * The value written to the bot for a menu choice. Null means "follow the bot's
 * own default", so it is written only when the owner picks that default.
 * Full access always persists `bypass`: writing null there would clear the
 * bot's setting and drop the conversation back to the global default, which can
 * be Ask.
 */
export function permissionWrite(next: ApprovalMode, botMode: ApprovalMode): ApprovalMode | null {
  if (next === 'bypass') return 'bypass'
  return next === botMode ? null : next
}

function ModeIcon({ mode, size = 14 }: { mode: ApprovalMode; size?: number }) {
  if (mode === 'bypass') return <CircleAlert size={size} aria-hidden="true" />
  if (mode === 'accept_edits') return <FilePenLine size={size} aria-hidden="true" />
  if (mode === 'auto') return <ShieldCheck size={size} aria-hidden="true" />
  return <Hand size={size} aria-hidden="true" />
}

export function PermissionModeControl({ session, agent, disabled, locked = false, note, onSessionUpdated, onAgentUpdated, onError }: {
  session: Session
  agent: Agent | null
  disabled: boolean
  /** FIX39 item 13: the bot is locked, so the pill explains why it cannot change. */
  locked?: boolean
  /** Replaces the menu's closing note (the side-conversation header says when the change lands). */
  note?: string
  onSessionUpdated: (session: Session) => void
  onAgentUpdated?: (agent: Agent) => void
  onError: (reason: unknown) => void
}) {
  const [open, setOpen] = useState(false)
  const noun = useEntityNoun()
  const Noun = useEntityNoun({ capital: true })
  const [saving, setSaving] = useState(false)
  const [confirmBypass, setConfirmBypass] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { mode, pinned } = sessionApprovalMode(session, agent)
  const blobMode = sessionApprovalMode({ ...session, projectApprovalMode: null, modelLock: { ...session.modelLock, approvalMode: undefined } }, agent).mode
  const close = (restoreFocus: boolean) => { setOpen(false); if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus()) }
  usePopoverDismiss(open, rootRef, close)
  useEffect(() => { if (open) requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()) }, [open])
  useEffect(() => { setOpen(false); setConfirmBypass(false) }, [session.id])

  // FIX39 item 16: the choice always writes the bot's own setting, whether or
  // not a conversation is open. An open conversation is then brought in line by
  // clearing its own pin, so it follows the bot from the next turn. The bot's
  // answer replaces the optimistic value, and a failure leaves the old one.
  const apply = async (write: ApprovalMode | null) => {
    const before = session
    setSaving(true)
    if (!agent) { setSaving(false); onError(new Error('Choose a bot first.')); return }
    // The project's own setting would override the bot's, so here the choice stays on this conversation.
    if (session.projectApprovalMode && !before.id.startsWith('draft:')) {
      try {
        const result = await rpc<{ session?: Session }>('session.permissions.set', { sessionId: before.id, approvalMode: write ?? blobMode })
        if (result.session?.id === before.id) onSessionUpdated(result.session)
      } catch (reason) { onError(reason) } finally { setSaving(false) }
      return
    }
    if (!before.id.startsWith('draft:')) onSessionUpdated({ ...before, modelLock: { ...(before.modelLock ?? {}), approvalMode: undefined } })
    try {
      const updated = await rpc<{ agent?: Agent }>('agent.update', { agentId: agent.id, approvalMode: write })
      if (updated.agent?.id) onAgentUpdated?.(updated.agent)
      if (!before.id.startsWith('draft:')) {
        const result = await rpc<{ session?: Session }>('session.permissions.set', { sessionId: before.id, approvalMode: null })
        if (result.session?.id === before.id) onSessionUpdated(result.session)
      }
    } catch (reason) { onSessionUpdated(before); onError(reason) } finally { setSaving(false) }
  }
  const choose = (next: ApprovalMode) => {
    close(true)
    if (next === mode && pinned) return
    if (next === 'bypass') { setConfirmBypass(true); return }
    void apply(permissionWrite(next, blobMode))
  }
  const copy = APPROVAL_MODE_COPY[mode]
  // FIX39 item 19: a mode the Manager proposed and the owner approved is marked
  // so the side-conversation pill says who set it.
  const managerSet = session.modelLock?.approvalModeSource === 'manager' && pinned
  return <div ref={rootRef} className="composer-popover-anchor">
    <button ref={triggerRef} type="button" className={`composer-pill permission-pill mode-${mode}`} aria-haspopup="menu" aria-expanded={open} aria-label={`Permissions: ${copy.title}${pinned ? ', set for this conversation' : `, ${noun} default`}${managerSet ? ', set by the Manager' : ''}`} title={locked ? LOCKED_CONTROL_TOOLTIP : copy.detail} disabled={disabled || saving} onClick={() => setOpen((value) => !value)}>
      {saving ? <LoaderCircle size={14} className="spinning" aria-hidden="true" /> : <ModeIcon mode={mode} />}
      <span>{copy.label}</span>
      {managerSet && <small className="permission-pill-source">set by the Manager</small>}
      <ChevronDown size={12} aria-hidden="true" className="composer-pill-chevron" />
    </button>
    {open && <div ref={menuRef} className="composer-menu permission-menu align-left" role="menu" aria-label="Permissions for this conversation" onKeyDown={(event) => { if (moveMenuFocus(menuRef.current, event.key)) event.preventDefault() }}>
      <div className="composer-menu-heading">Permissions</div>
      {(['ask', 'accept_edits', 'auto', 'bypass'] as const).map((item) => <button key={item} type="button" role="menuitemradio" aria-checked={item === mode} className={`composer-menu-item rich mode-${item}`} onClick={() => choose(item)}>
        <span className="composer-menu-icon"><ModeIcon mode={item} size={15} /></span>
        <span className="composer-menu-text"><strong>{APPROVAL_MODE_COPY[item].title}{item === blobMode && <small className="composer-menu-tag">{Noun} default</small>}</strong><small>{APPROVAL_MODE_COPY[item].detail}</small></span>
        {item === mode && <Check size={14} className="composer-menu-check" aria-hidden="true" />}
      </button>)}
      <p className="composer-menu-note">{note ?? (session.projectApprovalMode ? 'This project sets its own approvals, so this changes only this conversation.' : `Applies to this ${noun} from now on, starting with the next message. A turn already running keeps the mode it started with.`)}</p>
    </div>}
    {confirmBypass && <ConfirmDialog title="Give this conversation full access?" body={`The agent will run commands and change files without asking you. Cancel and Pause all still stop it. This is the ${noun}'s own setting, so every conversation is affected.`} confirmLabel="Allow full access" cancelLabel="Keep asking" onConfirm={() => { setConfirmBypass(false); void apply(permissionWrite('bypass', blobMode)) }} onCancel={() => setConfirmBypass(false)} />}
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

/**
 * The one attachment control. A single paperclip opens a small menu with the two
 * kinds of attachment, which travel differently: an image is read, checked and
 * sent as bytes (only to coding agents that accept images, up to the per-message
 * limit); a document, audio or video file is sent as a path only, which Bitbots
 * does not read and the coding agent opens if its permissions allow. Each choice
 * is disabled on its own, with the reason shown, so the control itself stays
 * available whenever either kind is. Drag and paste still add images directly.
 */
export function AttachMenu({ imagesSupported, imagesDisabled, imageCount, fileDisabled, onImages, onPickFile }: { imagesSupported: boolean; imagesDisabled: boolean; imageCount: number; fileDisabled: boolean; onImages: (files: File[]) => void; onPickFile: () => void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const close = (restoreFocus: boolean) => { setOpen(false); if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus()) }
  usePopoverDismiss(open, rootRef, close)
  useEffect(() => { if (open) requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()) }, [open])
  const full = imageCount >= MAX_COMPOSER_ATTACHMENTS
  const imageOff = imagesDisabled || !imagesSupported || full
  const imageNote = !imagesSupported ? 'This coding agent does not accept images.' : full ? `Up to ${MAX_COMPOSER_ATTACHMENTS} images per message.` : 'PNG, JPEG, GIF or WebP, sent with your message.'
  return <div ref={rootRef} className="composer-popover-anchor">
    <button ref={triggerRef} type="button" className="composer-icon-button" aria-haspopup="menu" aria-expanded={open} aria-label="Attach" title="Attach an image or a file" disabled={imageOff && fileDisabled} onClick={() => setOpen((value) => !value)}><Paperclip size={16} aria-hidden="true" /></button>
    {open && <div ref={menuRef} className="composer-menu attach-menu align-left" role="menu" aria-label="Attach to this message" onKeyDown={(event) => { if (moveMenuFocus(menuRef.current, event.key)) event.preventDefault() }}>
      <div className="composer-menu-heading">Attach</div>
      <button type="button" role="menuitem" className="composer-menu-item rich" disabled={imageOff} onClick={() => { close(false); inputRef.current?.click() }}>
        <span className="composer-menu-icon"><ImageIcon size={15} aria-hidden="true" /></span>
        <span className="composer-menu-text"><strong>Image</strong><small>{imageNote}</small></span>
      </button>
      <button type="button" role="menuitem" className="composer-menu-item rich" disabled={fileDisabled} onClick={() => { close(false); onPickFile() }}>
        <span className="composer-menu-icon"><FileText size={15} aria-hidden="true" /></span>
        <span className="composer-menu-text"><strong>File by path</strong><small>Document, audio or video. Bitbots does not read it; the coding agent opens it if its permissions allow.</small></span>
      </button>
    </div>}
    <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden tabIndex={-1} aria-hidden="true" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (files.length) onImages(files) }} />
  </div>
}

export function AttachmentTray({ attachments, onRemove }: { attachments: ComposerAttachment[]; onRemove: (id: string) => void }) {
  if (!attachments.length) return null
  return <ul className="composer-attachments" aria-label="Attached images">
    {attachments.map((item) => <li key={item.id} className={`composer-attachment ${item.status}`} title={item.error ?? item.name}>
      {item.previewUrl ? <img src={item.previewUrl} alt={item.name} /> : <span className="composer-attachment-blank" aria-hidden="true" />}
      {item.status === 'staging' && <span className="composer-attachment-state" aria-label="Preparing image"><LoaderCircle size={14} className="spinning" aria-hidden="true" /></span>}
      {item.status === 'error' && <span className="composer-attachment-state error" role="img" aria-label={item.error ?? 'Image could not be attached'}><X size={14} aria-hidden="true" /></span>}
      <button type="button" className="composer-attachment-remove" aria-label={`Remove ${item.name}`} onClick={() => onRemove(item.id)}><X size={11} aria-hidden="true" /></button>
    </li>)}
  </ul>
}

export function MessageAttachments({ attachments, sessionId, messageId }: { attachments: unknown; sessionId?: string; messageId?: string }) {
  const list = Array.isArray(attachments) ? attachments.filter((item): item is { name: string } => !!item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') : []
  if (!list.length) return null
  // Without the message's own identity the thumbnail has no ownership-checked
  // source, so the older filename chip stands in.
  if (!sessionId || !messageId) return <ul className="message-attachments" aria-label="Attached images">{list.map((item, index) => <li key={`${item.name}-${index}`}><ImageIcon size={13} aria-hidden="true" /><span>{item.name}</span></li>)}</ul>
  return <ul className="message-images" aria-label="Attached images">{list.map((item, index) => <MessageImage key={`${item.name}-${index}`} sessionId={sessionId} messageId={messageId} index={index} name={item.name} />)}</ul>
}

/**
 * One sent image. The bytes come from `message.image`, which serves only an
 * image that message recorded in this conversation; a missing or damaged file
 * shows a placeholder instead of a broken picture, and a click opens a viewer
 * that closes on Escape or the backdrop and returns focus to the thumbnail.
 */
export function MessageImage({ sessionId, messageId, index, name }: { sessionId: string; messageId: string; index: number; name: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    let live = true
    // A reload mounts the transcript before the local daemon answers, so a
    // "not ready yet" refusal is retried a few times; a file that is really
    // gone shows the placeholder at once.
    const load = async (attempt: number): Promise<void> => {
      try {
        const result = await rpc<{ dataUrl?: unknown }>('message.image', { sessionId, messageId, index })
        if (!live) return
        if (typeof result?.dataUrl === 'string' && result.dataUrl.startsWith('data:image/')) { setSrc(result.dataUrl); setFailure(null); return }
        setFailure('This image could not be read.')
      } catch (reason) {
        if (!live) return
        const text = String(reason)
        // A refusal that means "not ready yet" is retried a few times; once
        // they are used up the row settles on a placeholder rather than spinning.
        if (!transientImageFailure(text)) { setFailure(text); return }
        if (attempt >= 6) { setFailure('The local daemon did not answer. Reopen this conversation to try again.'); return }
        await new Promise((resolve) => setTimeout(resolve, 500))
        if (live) await load(attempt + 1)
      }
    }
    void load(0)
    return () => { live = false }
  }, [sessionId, messageId, index])
  const state = src ? 'ready' : failure && !transientImageFailure(failure) ? 'missing' : 'loading'
  const close = (restoreFocus: boolean) => { setOpen(false); if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus()) }
  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => closeRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) } }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open])
  if (state === 'missing') return <li className="message-image placeholder" role="img" aria-label={`${name} is no longer available`} title={failure ?? undefined}><span className="message-image-placeholder"><ImageOff size={18} aria-hidden="true" /><span>{name}</span><small>Not available</small></span></li>
  if (state === 'loading' || !src) return <li className="message-image loading" aria-busy="true" aria-label={`Loading ${name}`}><LoaderCircle size={16} className="spinning" aria-hidden="true" /></li>
  return <li className="message-image-wrap">
    <button ref={triggerRef} type="button" className="message-image" aria-label={`Open ${name}`} title={name} onClick={() => setOpen(true)}><img src={src} alt={name} /></button>
    {open && <div className="message-image-viewer" role="dialog" aria-modal="true" aria-label={`${name}, enlarged`} onClick={() => close(true)}>
      <button ref={closeRef} type="button" className="message-image-viewer-close" aria-label="Close image" onClick={() => close(true)}><X size={16} aria-hidden="true" /></button>
      <figure onClick={(event) => event.stopPropagation()}><img src={src} alt={name} /><figcaption>{name}</figcaption></figure>
    </div>}
  </li>
}

/** A refusal that means "not yet" (the local daemon is still starting or restarting). */
export function transientImageFailure(reason: unknown): boolean {
  const text = String(reason)
  return /daemon is not running|Daemon request failed|not connected|not ready|timed out/i.test(text)
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
