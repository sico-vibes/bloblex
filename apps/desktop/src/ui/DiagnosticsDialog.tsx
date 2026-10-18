import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, FileArchive, LoaderCircle } from 'lucide-react'
import { rpc, selectDiagnosticsExportPath, writeDiagnosticsExport, type DiagnosticsPreview } from '../tauri'

/**
 * FIX39 P12: "Export diagnostics". Lists what the zip will contain, then writes
 * it through the native save dialog. Message text, command text, credentials and
 * tokens are already removed by the time the listing is built; nothing is
 * uploaded anywhere.
 */
export function DiagnosticsDialog({ onClose }: { onClose: () => void }) {
  const [preview, setPreview] = useState<DiagnosticsPreview | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedTo, setSavedTo] = useState<string | null>(null)
  const [entered, setEntered] = useState(false)
  const first = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const frame = requestAnimationFrame(() => { setEntered(true); first.current?.focus() })
    return () => cancelAnimationFrame(frame)
  }, [])
  useEffect(() => {
    let live = true
    void rpc<DiagnosticsPreview>('diagnostics.preview')
      .then((next) => { if (live) setPreview(next) })
      .catch((reason) => { if (live) setProblem(messageOf(reason, 'The diagnostics list could not be read.')) })
    return () => { live = false }
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || saving) return
      // The dialog opens from the Settings sheet, which listens on `document`
      // too. A capture listener with `stopPropagation` closes the dialog alone.
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [saving, onClose])

  const saveNow = async () => {
    setProblem(null)
    setSavedTo(null)
    const token = await selectDiagnosticsExportPath().catch((reason) => { setProblem(messageOf(reason, 'The save dialog could not open.')); return null })
    if (!token) return
    setSaving(true)
    try {
      const result = await writeDiagnosticsExport(token)
      setSavedTo(result.path)
    } catch (reason) {
      setProblem(messageOf(reason, 'The diagnostics file could not be saved.'))
    } finally {
      setSaving(false)
    }
  }

  const files = preview?.files ?? []
  const total = files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0)

  const dialog = <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`} onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose() }}>
    <section className="blob-dialog diagnostics-dialog" role="dialog" aria-modal="true" aria-labelledby="diagnostics-title" aria-busy={saving}>
      <header>
        <FileArchive size={18} aria-hidden="true" />
        <h2 id="diagnostics-title">Export diagnostics</h2>
      </header>
      <p>One zip with the recent logs, the app and operating system versions, the coding agents found, your settings with secrets removed, and recent activity with message text removed. It is saved on this computer; nothing is uploaded anywhere.</p>
      {!preview && !problem && <p className="diagnostics-loading" role="status"><LoaderCircle size={14} className="spinning" aria-hidden="true" />Reading the diagnostics list…</p>}
      {problem && <p className="settings-banner error" role="alert">{problem}</p>}
      {preview && <>
        <ul className="diagnostics-contents" aria-label="What the diagnostics file will contain">
          {files.map((file) => <li key={file.name}>
            <span>{labelFor(file.name)}</span>
            <small>{file.name} · {formatBytes(file.sizeBytes)}</small>
          </li>)}
        </ul>
        <p className="diagnostics-total">{files.length} {files.length === 1 ? 'item' : 'items'} · about {formatBytes(total)} · {preview.fileName}</p>
      </>}
      {savedTo && <p className="settings-banner" role="status">Saved to {savedTo}.</p>}
      <div className="blob-dialog-actions">
        <button ref={first} type="button" className="secondary-button" onClick={onClose} disabled={saving}>{savedTo ? 'Close' : 'Not now'}</button>
        <button type="button" className="primary-button" onClick={() => void saveNow()} disabled={saving || !preview}><Download size={14} aria-hidden="true" />{saving ? 'Saving…' : 'Save as…'}</button>
      </div>
    </section>
  </div>
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}

export function labelFor(name: string): string {
  if (name.startsWith('logs/')) return 'Log file — recent lines'
  switch (name) {
    case 'README.txt': return 'README — what is inside'
    case 'environment.json': return 'Environment — app, OS and coding agent versions'
    case 'settings.json': return 'Settings — with secrets removed'
    case 'events.json': return 'Recent activity — message and command text removed'
    default: return name
  }
}

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function messageOf(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : fallback
}
