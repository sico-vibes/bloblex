import { Suspense, lazy, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, FileText, ImageOff, LoaderCircle, Music2, Video, X } from 'lucide-react'
import { revealInExplorer, rpc } from '../tauri'
import './mediaPreview.css'

// pdf.js is large, so it loads only when a PDF is actually shown.
const PdfViewer = lazy(() => import('./PdfViewer'))

/** Which conversation (and folder) the visible messages belong to; the daemon only previews files inside that folder. */
export type MediaScope = { sessionId: string; projectPath: string | null }
let currentScope: MediaScope | null = null
const scopeListeners = new Set<() => void>()
/** The window shows one conversation at a time; the shell sets it here so message renderers need no extra props. */
export function setMediaScope(scope: MediaScope | null) {
  if (currentScope?.sessionId === scope?.sessionId && currentScope?.projectPath === scope?.projectPath) return
  currentScope = scope
  scopeListeners.forEach((listener) => listener())
}
export function useMediaScope(): MediaScope | null {
  return useSyncExternalStore((listener) => { scopeListeners.add(listener); return () => { scopeListeners.delete(listener) } }, () => currentScope)
}

export type MediaReply = {
  status: 'ok' | 'unavailable' | 'unsupported' | 'blocked' | 'tooLarge'
  reason?: string | null
  name?: string
  relativePath?: string | null
  kind?: 'image' | 'audio' | 'video' | 'pdf' | 'text' | 'unsupported'
  mediaType?: string | null
  size?: number | null
  dataUrl?: string | null
  text?: string | null
  truncated?: boolean
  language?: string | null
}

const previewable = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif|mp3|wav|og[ag]|m4a|aac|flac|opus|mp4|webm|mov|m4v|ogv|pdf|txt|md|markdown|json|jsonc|csv|tsv|log|ya?ml|toml|ini|xml|html?|css|scss|jsx?|tsx?|mjs|cjs|rs|py|go|java|c|h|cpp|hpp|cs|rb|php|sh|ps1|bat|sql|diff|patch)$/i
export function isPreviewablePath(path: string): boolean { return previewable.test(path) }

/** True when the string names a file inside the project rather than a web address. */
export function isLocalPath(src: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(src) && !/^(data|javascript|file|blob|vbscript):/i.test(src) && src.length <= 1024 && !src.includes('\0')
}

const cache = new Map<string, MediaReply>()
const CACHE_LIMIT = 16
const CACHE_ENTRY_BYTES = 1_500_000

export function formatSize(bytes: number | null | undefined) {
  if (typeof bytes !== 'number') return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** data: URL to a Blob without fetch (the CSP's connect-src has no data:), so large audio and video do not sit in the DOM as text. */
function blobUrlFor(dataUrl: string): string | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) return null
  try {
    const binary = atob(match[2]!)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return URL.createObjectURL(new Blob([bytes], { type: match[1]! }))
  } catch { return null }
}

type MediaReplyState = { phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'done'; reply: MediaReply }

/** `source` is a file in the conversation's folder, or a generated image the daemon recorded for it. */
function usePreviewReply(sessionId: string | null, source: { path: string } | { mediaId: string } | null): MediaReplyState {
  const [state, setState] = useState<MediaReplyState>({ phase: 'loading' })
  const name = source ? ('path' in source ? `path\n${source.path}` : `media\n${source.mediaId}`) : null
  useEffect(() => {
    if (!source) return
    if (!sessionId) { setState({ phase: 'error', message: 'Previews need an open conversation.' }); return }
    const key = `${sessionId}\n${name}`
    const hit = cache.get(key)
    if (hit) { setState({ phase: 'done', reply: hit }); return }
    let live = true
    setState({ phase: 'loading' })
    rpc<MediaReply>('media.preview', { sessionId, ...source })
      .then((reply) => {
        if (!live) return
        // A generated image's file can come back, so only a real image is remembered.
        const keep = 'path' in source || reply.status === 'ok'
        if (keep && (reply.dataUrl?.length ?? 0) + (reply.text?.length ?? 0) <= CACHE_ENTRY_BYTES) {
          if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
          cache.set(key, reply)
        }
        setState({ phase: 'done', reply })
      })
      .catch((reason) => { if (live) setState({ phase: 'error', message: reason instanceof Error ? reason.message : String(reason) }) })
    return () => { live = false }
  }, [sessionId, name])
  return state
}

function useMediaReply(scope: MediaScope | null, path: string) {
  return usePreviewReply(scope?.sessionId ?? null, { path })
}

/** A generated image's preview. Pass null until the image is ready, so nothing is asked for early. */
export function useGeneratedMediaReply(sessionId: string | null | undefined, mediaId: string | null): MediaReplyState {
  return usePreviewReply(sessionId ?? null, mediaId ? { mediaId } : null)
}

function Card({ icon, name, line, children, tone }: { icon: ReactNode; name: string; line: string; children?: ReactNode; tone?: 'error' }) {
  return <div className={`media-card${tone ? ` ${tone}` : ''}`}><span className="media-card-icon" aria-hidden="true">{icon}</span><span className="media-card-text"><strong title={name}>{name}</strong><small>{line}</small></span>{children}</div>
}

export function Viewer({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    requestAnimationFrame(() => closeRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])
  return <div className="message-image-viewer" role="dialog" aria-modal="true" aria-label={`${name}, enlarged`} onClick={onClose}>
    <button ref={closeRef} type="button" className="message-image-viewer-close" aria-label="Close image" onClick={onClose}><X size={16} aria-hidden="true" /></button>
    <figure onClick={(event) => event.stopPropagation()}><img src={src} alt={name} /><figcaption>{name}</figcaption></figure>
  </div>
}

function PlayableMedia({ reply, kind }: { reply: MediaReply; kind: 'audio' | 'video' }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const made = reply.dataUrl ? blobUrlFor(reply.dataUrl) : null
    setUrl(made)
    return () => { if (made) URL.revokeObjectURL(made) }
  }, [reply.dataUrl])
  const name = reply.name ?? (kind === 'audio' ? 'Audio' : 'Video')
  if (!url) return <Card tone="error" icon={<AlertCircle size={16} />} name={name} line="This file could not be prepared for playback." />
  return kind === 'audio'
    ? <figure className="media-player audio"><figcaption><Music2 size={13} aria-hidden="true" /><span title={name}>{name}</span><small>{formatSize(reply.size)}</small></figcaption><audio controls preload="metadata" src={url} aria-label={name} /></figure>
    : <figure className="media-player video"><video controls preload="metadata" src={url} aria-label={name} /><figcaption><Video size={13} aria-hidden="true" /><span title={name}>{name}</span><small>{formatSize(reply.size)}</small></figcaption></figure>
}

function TextPreview({ reply }: { reply: MediaReply }) {
  const [all, setAll] = useState(false)
  const lines = (reply.text ?? '').split('\n')
  const long = lines.length > 18
  const shown = all || !long ? reply.text ?? '' : lines.slice(0, 18).join('\n')
  const name = reply.name ?? 'File'
  return <figure className="media-text">
    <figcaption><FileText size={13} aria-hidden="true" /><span title={reply.relativePath ?? name}>{reply.relativePath ?? name}</span><small>{reply.language ? `${reply.language} · ` : ''}{formatSize(reply.size)}{reply.truncated ? ' · first 256 KB' : ''}</small></figcaption>
    <pre tabIndex={0} aria-label={`${name}, text preview`}><code>{shown}</code></pre>
    {long && <button type="button" className="media-more" onClick={() => setAll((value) => !value)}>{all ? 'Show fewer lines' : `Show all ${lines.length} lines`}</button>}
  </figure>
}

/**
 * One local file shown in chat. The daemon decides whether the path is allowed (inside the conversation's folder,
 * not a secret, a type it recognises, a size it can send); every other outcome is a labelled card, never a blank gap.
 */
export function MediaPreview({ path, alt }: { path: string; alt?: string }) {
  const scope = useMediaScope()
  const state = useMediaReply(scope, path)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const label = alt?.trim() || path.split(/[\\/]/).pop() || path
  if (state.phase === 'loading') return <div className="media-card loading" aria-busy="true" aria-label={`Loading ${label}`}><LoaderCircle size={15} className="spinning" aria-hidden="true" /><span>Loading {label}</span></div>
  if (state.phase === 'error') return <Card tone="error" icon={<AlertCircle size={16} />} name={label} line={state.message || 'This file could not be previewed.'} />
  const { reply } = state
  const name = reply.name ?? label
  if (reply.status !== 'ok') return <Card tone={reply.status === 'unsupported' ? undefined : 'error'} icon={reply.kind === 'image' ? <ImageOff size={16} /> : <FileText size={16} />} name={name} line={reply.reason ?? 'This file cannot be previewed.'} />
  if (reply.kind === 'image' && reply.dataUrl) {
    return <figure className="media-image">
      <button ref={trigger} type="button" aria-label={`Open ${name}`} onClick={() => setOpen(true)}><img src={reply.dataUrl} alt={alt?.trim() || name} /></button>
      <figcaption><span title={reply.relativePath ?? name}>{reply.relativePath ?? name}</span><small>{formatSize(reply.size)}</small></figcaption>
      {open && <Viewer src={reply.dataUrl} name={name} onClose={() => { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()) }} />}
    </figure>
  }
  if (reply.kind === 'audio' || reply.kind === 'video') return <PlayableMedia reply={reply} kind={reply.kind} />
  if (reply.kind === 'text') return <TextPreview reply={reply} />
  if (reply.kind === 'pdf' && reply.dataUrl) {
    const reveal = () => void revealInExplorer(reply.relativePath ?? name, scope?.projectPath ?? null).catch(() => undefined)
    return <Suspense fallback={<div className="media-card loading" aria-busy="true"><LoaderCircle size={15} className="spinning" aria-hidden="true" /><span>Opening {name}…</span></div>}>
      <PdfViewer dataUrl={reply.dataUrl} name={name} size={reply.size} onReveal={reveal} />
    </Suspense>
  }
  return <Card icon={<FileText size={16} />} name={name} line="This file cannot be previewed." />
}

/** One preview in a dialog over the window (Escape or the backdrop closes it, focus returns to where it was). */
export function MediaDialog({ path, title, onClose }: { path: string; title: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    requestAnimationFrame(() => closeRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true); before?.focus?.() }
  }, [onClose])
  return createPortal(<div className="media-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="media-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header><strong title={path}>{title}</strong><button ref={closeRef} type="button" className="icon-button" aria-label="Close preview" onClick={onClose}><X size={16} aria-hidden="true" /></button></header>
      <div className="media-dialog-body"><MediaPreview path={path} /></div>
    </section>
  </div>, document.body)
}
