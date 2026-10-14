import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download } from 'lucide-react'
import { formatModelSize, speechModelInfo, type SpeechModelInfo } from './dictation'

/**
 * Asked when dictation is set to this device but its speech model is not
 * installed: how big it is, then a download with progress, then dictation
 * starts by itself. Nothing downloads until the owner accepts.
 */
export function SpeechModelDialog({ modelId, downloading, progress, onAccept, onDismiss }: {
  modelId: string
  downloading: boolean
  /** 0 to 1 while downloading. */
  progress: number
  onAccept: () => void
  onDismiss: () => void
}) {
  const [info, setInfo] = useState<SpeechModelInfo>({ id: modelId, label: 'Speech model', sizeBytes: null })
  const [entered, setEntered] = useState(false)
  const accept = useRef<HTMLButtonElement>(null)
  useEffect(() => { let live = true; void speechModelInfo(modelId).then((next) => { if (live) setInfo(next) }); return () => { live = false } }, [modelId])
  useEffect(() => {
    const frame = requestAnimationFrame(() => { setEntered(true); accept.current?.focus() })
    return () => cancelAnimationFrame(frame)
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !downloading) { event.preventDefault(); onDismiss() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [downloading, onDismiss])
  const size = formatModelSize(info.sizeBytes)
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100)
  const dialog = <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`}>
    <section className="blob-dialog speech-model-dialog" role="dialog" aria-modal="true" aria-labelledby="speech-model-title" aria-busy={downloading}>
      <h2 id="speech-model-title">{downloading ? 'Downloading the speech model' : 'Download the speech model?'}</h2>
      <p>
        {downloading
          ? `${info.label}${size ? ` (${size})` : ''} is downloading. Dictation starts as soon as it is ready.`
          : `Dictation on this device needs the ${info.label} model${size ? `, ${size}` : ''}. It downloads once, then runs offline. Your audio stays on this computer.`}
      </p>
      {downloading && <div className="speech-model-dialog-progress" role="progressbar" aria-label="Downloading the speech model" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${percent}%` }} />
        <b>{percent}%</b>
      </div>}
      {!downloading && <div className="blob-dialog-actions">
        <button type="button" className="secondary-button" onClick={onDismiss}>Not now</button>
        <button ref={accept} type="button" className="primary-button" onClick={onAccept}><Download size={14} aria-hidden="true" />{size ? `Download ${size}` : 'Download'}</button>
      </div>}
    </section>
  </div>
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}
