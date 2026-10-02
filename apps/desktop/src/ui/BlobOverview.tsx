import { useRef } from 'react'
import type { Runtime, Session } from '../types'
import { labelize } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentColorHex, previewHex, resolvedAgentColor } from './agentColor'
import { deriveCompanionStatus } from './companionStatus'
import type { AgentDraft } from './agentForm'
import { SwatchGrid } from './SwatchGrid'

export function BlobOverview({ draft, runtime, session, connected, model, mode, onColorChange }: {
  draft: AgentDraft
  runtime: Runtime | null
  session: Session | null
  connected: boolean
  model: string | null
  mode: 'create' | 'edit'
  onColorChange: (color: string) => void
}) {
  const derived = deriveCompanionStatus({ connected, runtime, session: mode === 'create' ? null : session, now: Date.now() })
  const mood = mode === 'create' ? (connected ? 'idle' : 'offline') : derived.mood
  const lastValid = useRef(resolvedAgentColor(draft.color) ?? agentColorHex('mint'))
  const resolved = resolvedAgentColor(draft.color)
  if (resolved) lastValid.current = resolved
  // previewHex is the last-valid form of agentColorHex (spec section 4): an invalid draft keeps the previous paint.
  const paint = previewHex(draft.color, lastValid.current)
  const modelValue = model?.trim() ? model : 'Default model'
  return <div className="blob-card">
    <div className="blob-profile">
      <BlobCanvas color={paint} size={96} mood={mood} label={draft.name.trim() || 'New blob'} />
      <div>
        <h2>{draft.name.trim() || 'New blob'}</h2>
        <p className="blob-muted">{draft.description.trim() ? draft.description : 'No description'}</p>
      </div>
    </div>
    <div className="blob-facts">
      <div className="blob-fact"><span>Runtime</span><strong>{runtime ? [labelize(runtime.provider), runtime.version].filter(Boolean).join(' · ') : 'No runtime'}</strong></div>
      <div className="blob-fact"><span>Model</span><strong>{modelValue}</strong></div>
      <div className="blob-fact"><span>Status</span><strong>{mode === 'create' ? 'Not created yet' : derived.label}</strong></div>
    </div>
    <SwatchGrid value={draft.color} onChange={onColorChange} />
  </div>
}
