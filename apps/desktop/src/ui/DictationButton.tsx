import { LoaderCircle, Mic } from 'lucide-react'
import { useDictation } from './dictation'

export const DEFAULT_SPEECH_MODEL_ID = 'parakeet-tdt-0.6b-v3-int8'

/**
 * Dictation control for a composer. Final transcripts are handed back through
 * `onFinal`; the caller appends them to its own draft.
 */
export function DictationButton({
  owner = 'desktop',
  modelId = DEFAULT_SPEECH_MODEL_ID,
  onFinal,
  onPartial,
  disabled = false,
}: {
  owner?: string
  modelId?: string
  onFinal: (text: string) => void
  onPartial?: (text: string) => void
  disabled?: boolean
}) {
  const { phase, active, error, progress, toggle } = useDictation({ owner, modelId, onFinal, onPartial })
  const downloading = phase === 'downloading'
  const label = downloading
    ? `Downloading speech model… ${Math.round(progress * 100)}%`
    : error === 'model'
      ? 'Download the speech model in Settings to dictate'
      : active
        ? 'Stop dictation (Ctrl+E)'
        : 'Start dictation (Ctrl+E)'
  return (
    <button
      type="button"
      className={`dictation-button ${active ? 'active' : ''}`}
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={() => void toggle()}
      disabled={disabled || downloading}
    >
      {phase === 'starting' || downloading ? <LoaderCircle size={16} className="spinning" /> : <Mic size={16} />}
    </button>
  )
}
