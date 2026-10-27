import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, FileText, FolderOpen, Type } from 'lucide-react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

/**
 * A PDF drawn page by page onto a canvas with pdf.js. No iframe, no embedded viewer, no scripting: the bytes come
 * from the daemon's authorised `media.preview`, the worker is our own bundled file, and annotations and links are
 * not drawn. "Text" shows the page's text as plain text (also what a screen reader and Copy can use).
 */
const MAX_TEXT = 40_000

type Pdfjs = typeof import('pdfjs-dist')
let loader: Promise<Pdfjs> | null = null
function loadPdfjs(): Promise<Pdfjs> {
  loader ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((module) => {
    const pdfjs = module as unknown as Pdfjs
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    return pdfjs
  })
  return loader
}

function bytesOf(dataUrl: string): Uint8Array | null {
  const match = /^data:application\/pdf;base64,(.*)$/s.exec(dataUrl)
  if (!match) return null
  try {
    const binary = atob(match[1]!)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch { return null }
}

const sizeLabel = (bytes: number | null | undefined) => (typeof bytes === 'number' ? (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`) : '')

export default function PdfViewer({ dataUrl, name, size, onReveal }: { dataUrl: string; name: string; size?: number | null; onReveal?: () => void }) {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const frame = useRef<HTMLDivElement | null>(null)
  const doc = useRef<PDFDocumentProxy | null>(null)
  const task = useRef<RenderTask | null>(null)
  const [pages, setPages] = useState(0)
  const [page, setPage] = useState(1)
  const [failure, setFailure] = useState<string | null>(null)
  const [width, setWidth] = useState(0)
  const [showText, setShowText] = useState(false)
  const [text, setText] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setFailure(null)
    setPages(0)
    setPage(1)
    const bytes = bytesOf(dataUrl)
    if (!bytes) { setFailure('This PDF could not be read.'); return }
    void loadPdfjs().then((pdfjs) => pdfjs.getDocument({ data: bytes, isEvalSupported: false, useWorkerFetch: false, disableAutoFetch: true, enableXfa: false, stopAtErrors: false }).promise).then((loaded) => {
      if (!live) { void loaded.destroy(); return }
      doc.current = loaded
      setPages(loaded.numPages)
    }).catch((reason: unknown) => {
      if (!live) return
      const code = (reason as { name?: string })?.name
      setFailure(code === 'PasswordException' ? 'This PDF is password protected, so Bitbots cannot show it.' : code === 'InvalidPDFException' ? 'This file is not a valid PDF.' : 'Bitbots could not draw this PDF.')
    })
    return () => { live = false; task.current?.cancel(); void doc.current?.destroy(); doc.current = null }
  }, [dataUrl])

  useEffect(() => {
    const node = frame.current
    if (!node) return
    const observer = new ResizeObserver(() => setWidth(Math.floor(node.clientWidth)))
    observer.observe(node)
    setWidth(Math.floor(node.clientWidth))
    return () => observer.disconnect()
  }, [])

  const draw = useCallback(async (number: number, available: number) => {
    const loaded = doc.current
    const target = canvas.current
    if (!loaded || !target || available < 40) return
    task.current?.cancel()
    try {
      const current = await loaded.getPage(number)
      const base = current.getViewport({ scale: 1 })
      const scale = Math.min(available / base.width, 2.5)
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const viewport = current.getViewport({ scale: scale * ratio })
      target.width = Math.floor(viewport.width)
      target.height = Math.floor(viewport.height)
      target.style.width = `${Math.floor(viewport.width / ratio)}px`
      target.style.height = `${Math.floor(viewport.height / ratio)}px`
      const context = target.getContext('2d')
      if (!context) return
      const running = current.render({ canvasContext: context, viewport })
      task.current = running
      await running.promise
    } catch (reason) {
      if ((reason as { name?: string })?.name === 'RenderingCancelledException') return
      setFailure('This page could not be drawn.')
    }
  }, [])

  useEffect(() => { if (pages > 0 && !showText) void draw(page, width) }, [pages, page, width, showText, draw])

  useEffect(() => {
    if (!showText || !doc.current || pages === 0) return
    let live = true
    setText(null)
    void doc.current.getPage(page).then((current) => current.getTextContent()).then((content) => {
      if (!live) return
      const joined = content.items.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '')).join('').replace(/[ \t]+\n/g, '\n').trim()
      setText(joined.length > MAX_TEXT ? `${joined.slice(0, MAX_TEXT)}…` : joined)
    }).catch(() => { if (live) setText('') })
    return () => { live = false }
  }, [showText, page, pages])

  if (failure) {
    return <div className="media-card error"><span className="media-card-icon" aria-hidden="true"><FileText size={16} /></span><span className="media-card-text"><strong title={name}>{name}</strong><small>{failure}</small></span>{onReveal && <button type="button" className="media-action" onClick={onReveal}><FolderOpen size={13} aria-hidden="true" />Show in folder</button>}</div>
  }
  return <figure className="media-pdf">
    <figcaption>
      <FileText size={13} aria-hidden="true" /><span title={name}>{name}</span><small>{pages ? `${pages} ${pages === 1 ? 'page' : 'pages'} · ` : ''}{sizeLabel(size)}</small>
      <span className="media-pdf-tools">
        <button type="button" className="media-pdf-button" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={14} aria-hidden="true" /></button>
        <span className="media-pdf-page" aria-live="polite">{pages ? `${page} / ${pages}` : '…'}</span>
        <button type="button" className="media-pdf-button" aria-label="Next page" disabled={page >= pages} onClick={() => setPage((value) => Math.min(pages, value + 1))}><ChevronRight size={14} aria-hidden="true" /></button>
        <button type="button" className="media-pdf-button" aria-pressed={showText} aria-label="Show this page as text" title="Show this page as text" onClick={() => setShowText((value) => !value)}><Type size={14} aria-hidden="true" /></button>
        {onReveal && <button type="button" className="media-pdf-button" aria-label="Show in folder" title="Show in folder" onClick={onReveal}><FolderOpen size={14} aria-hidden="true" /></button>}
      </span>
    </figcaption>
    <div className="media-pdf-frame" ref={frame}>
      {showText
        ? <pre tabIndex={0} aria-label={`Text of page ${page}`}>{text === null ? 'Reading the page…' : text || 'This page has no text Bitbots can read (it may be a scanned image).'}</pre>
        : <canvas ref={canvas} role="img" aria-label={`${name}, page ${page} of ${pages || '?'}`} />}
      {!pages && <p className="media-pdf-loading" role="status">Opening the PDF…</p>}
    </div>
  </figure>
}
