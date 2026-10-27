import { useEffect, useRef } from 'react'
import { LoaderCircle, Mic } from 'lucide-react'
import { DEFAULT_SPEECH_MODEL_ID, useDictation } from './dictation'
import { SpeechModelDialog } from './SpeechModelDialog'

export { DEFAULT_SPEECH_MODEL_ID }

/**
 * Dictation control for a composer. Final transcripts are handed back through
 * `onFinal`; the caller appends them to its own draft. `autoStart` starts a
 * session on mount (the companion opens its chat for Ctrl+E, then dictates).
 */
export function DictationButton({
  owner = 'desktop',
  modelId = DEFAULT_SPEECH_MODEL_ID,
  onFinal,
  disabled = false,
  autoStart = false,
  onAutoStarted,
}: {
  owner?: string
  modelId?: string
  onFinal: (text: string) => void
  disabled?: boolean
  autoStart?: boolean
  onAutoStarted?: () => void
}) {
  const { phase, active, warming, error, progress, toggle, modelPrompt, acceptModelPrompt, dismissModelPrompt } = useDictation({ owner, modelId, onFinal })
  const started = useRef(false)
  useEffect(() => {
    if (!autoStart || started.current || disabled) return
    started.current = true
    onAutoStarted?.()
    if (phase === 'idle') void toggle()
  }, [autoStart, disabled, onAutoStarted, phase, toggle])
  useEffect(() => { if (!autoStart) started.current = false }, [autoStart])
  const downloading = phase === 'downloading'
  const label = downloading
    ? `Downloading speech model… ${Math.round(progress * 100)}%`
    : error
      ? `Dictation stopped: ${error}`
      : warming
        ? 'Listening; the speech model is still loading (Ctrl+E to stop)'
        : active
          ? 'Stop dictation (Ctrl+E)'
          : 'Start dictation (Ctrl+E)'
  return (
    <>
    <button
      type="button"
      className={`dictation-button ${active ? 'active' : ''} ${warming ? 'warming' : ''}`}
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={() => void toggle()}
      disabled={disabled || downloading}
    >
      {downloading
        ? <span className="dictation-progress" style={{ ['--progress' as string]: `${Math.round(progress * 360)}deg` }} aria-hidden="true" />
        : phase === 'starting' ? <LoaderCircle size={16} className="spinning" /> : <Mic size={16} />}
    </button>
    {modelPrompt && <SpeechModelDialog modelId={modelId} downloading={downloading} progress={progress} onAccept={() => void acceptModelPrompt()} onDismiss={dismissModelPrompt} />}
    </>
  )
}
