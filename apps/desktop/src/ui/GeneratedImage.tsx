import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Copy, Download, FolderOpen, ImageOff, LoaderCircle } from 'lucide-react'
import { inDesktop, rpc, saveGeneratedImage } from '../tauri'
import { Viewer, formatSize, useGeneratedMediaReply } from './MediaPreview'
import './generatedImage.css'

/** What the daemon stores on a generated image's message. It never holds a path: the daemon reads the file by mediaId. */
export type GeneratedImageMeta = {
  kind: 'generated_image'
  mediaId: string
  status: 'pending' | 'ready' | 'failed'
  name: string | null
  bytes: number | null
  detail: string | null
}

export function generatedImageMeta(meta: unknown): GeneratedImageMeta | null {
  if (!meta || typeof meta !== 'object') return null
  const row = meta as Record<string, unknown>
  if (row.kind !== 'generated_image' || typeof row.mediaId !== 'string' || !row.mediaId) return null
  const status = row.status === 'ready' || row.status === 'failed' ? row.status : 'pending'
  return {
    kind: 'generated_image',
    mediaId: row.mediaId,
    status,
    name: typeof row.name === 'string' && row.name ? row.name : null,
    bytes: typeof row.bytes === 'number' ? row.bytes : null,
    detail: typeof row.detail === 'string' && row.detail ? row.detail : null,
  }
}

/** The composer's text after "Generate an image": whatever the owner has typed becomes the description. */
export function imagePromptFrom(draft: string): string {
  return `Use your image tool to generate an image of ${draft.trim()}`
}

/** WebView2 only puts PNG on the clipboard, so every type is drawn to a PNG first (a GIF copies its first frame). */
async function pngFor(dataUrl: string): Promise<Blob> {
  const image = new Image()
  image.src = dataUrl
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  canvas.getContext('2d')?.drawImage(image, 0, 0)
  return new Promise((resolve, reject) => canvas.toBlob((blob) => { if (blob) resolve(blob); else reject(new Error('This image could not be copied.')) }, 'image/png'))
}

type ActionNote = { action: 'copy' | 'save'; text: string } | { action: 'error'; text: string } | null

function ImageActions({ sessionId, mediaId, dataUrl }: { sessionId: string; mediaId: string; dataUrl: string }) {
  const [note, setNote] = useState<ActionNote>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const say = (next: Exclude<ActionNote, null>) => {
    setNote(next)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setNote(null), next.action === 'error' ? 5000 : 1800)
  }
  const attempt = (work: () => Promise<void>) => { void work().catch((reason) => say({ action: 'error', text: reason instanceof Error && reason.message ? reason.message : 'That did not work.' })) }
  const copy = () => {
    // The item takes the promise, so the write still counts as part of this click while the PNG is drawn.
    void navigator.clipboard.write([new ClipboardItem({ 'image/png': pngFor(dataUrl) })])
      .then(() => say({ action: 'copy', text: 'Copied' }))
      .catch(() => say({ action: 'error', text: 'This image could not be copied.' }))
  }
  const save = () => attempt(async () => { if (await saveGeneratedImage(sessionId, mediaId)) say({ action: 'save', text: 'Saved' }) })
  const reveal = () => attempt(async () => { await rpc('media.reveal', { sessionId, mediaId }) })
  return <div className="generated-image-actions">
    <button type="button" className="generated-image-action" onClick={copy}>{note?.action === 'copy' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}Copy</button>
    <button type="button" className="generated-image-action" onClick={save}>{note?.action === 'save' ? <Check size={13} aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}Save as…</button>
    <button type="button" className="generated-image-action" onClick={reveal}><FolderOpen size={13} aria-hidden="true" />Show in folder</button>
    <span className={`generated-image-note${note?.action === 'error' ? ' error' : ''}`} role="status">{note?.text ?? ''}</span>
  </div>
}

function Thumbnail({ sessionId, meta, compact }: { sessionId: string | null | undefined; meta: GeneratedImageMeta; compact: boolean }) {
  const state = useGeneratedMediaReply(sessionId, inDesktop ? meta.mediaId : null)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const fallbackName = meta.name ?? 'Generated image'
  if (!inDesktop) return <div className="media-card"><span className="media-card-icon" aria-hidden="true"><ImageOff size={16} /></span><span className="media-card-text"><strong title={fallbackName}>{fallbackName}</strong><small>Open Bitbots on your computer to see this image.</small></span></div>
  if (state.phase === 'loading') return <div className="media-card loading" aria-busy="true" aria-label={`Loading ${fallbackName}`}><LoaderCircle size={15} className="spinning" aria-hidden="true" /><span>Loading {fallbackName}</span></div>
  if (state.phase === 'error' || state.reply.status !== 'ok' || !state.reply.dataUrl) {
    const line = state.phase === 'error' ? state.message : state.reply.reason ?? 'This image cannot be shown.'
    return <div className="media-card error"><span className="media-card-icon" aria-hidden="true"><ImageOff size={16} /></span><span className="media-card-text"><strong title={fallbackName}>{fallbackName}</strong><small>{line}</small></span></div>
  }
  const { dataUrl } = state.reply
  const name = state.reply.name ?? fallbackName
  return <figure className={`media-image generated-image${compact ? ' compact' : ''}`}>
    <button ref={trigger} type="button" aria-label={`Open ${name}`} onClick={() => setOpen(true)}><img src={dataUrl} alt={name} /></button>
    {!compact && <figcaption><span title={name}>{name}</span><small>{formatSize(state.reply.size ?? meta.bytes)}</small></figcaption>}
    {!compact && sessionId && <ImageActions sessionId={sessionId} mediaId={meta.mediaId} dataUrl={dataUrl} />}
    {open && <Viewer src={dataUrl} name={name} onClose={() => { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()) }} />}
  </figure>
}

/**
 * A generated image in a conversation: waiting, then the picture, or the reason it failed. It can change after the
 * turn has ended, because some tools save the file later. `compact` is the companion's thumbnail, with no actions.
 */
export function GeneratedImage({ id, sessionId, meta, compact = false }: { id?: string; sessionId: string | null | undefined; meta: GeneratedImageMeta; compact?: boolean }) {
  const className = `generated-image-row${compact ? ' compact' : ''}`
  if (meta.status === 'pending') {
    return <div id={id} className={className} role="status"><div className="generated-image-pending"><span className="generated-image-pending-art" aria-hidden="true"><LoaderCircle size={15} className="spinning" /></span><span className="media-card-text"><strong>Generating an image…</strong>{!compact && <small>It appears here once it's saved, even if the reply has already finished.</small>}</span></div></div>
  }
  if (meta.status === 'failed') {
    return <div id={id} className={className} role="status"><div className="media-card error"><span className="media-card-icon" aria-hidden="true"><AlertCircle size={16} /></span><span className="media-card-text"><strong>The image couldn't be generated</strong>{meta.detail && <small>{meta.detail}</small>}</span></div></div>
  }
  return <div id={id} className={className}><Thumbnail sessionId={sessionId} meta={meta} compact={compact} /></div>
}
