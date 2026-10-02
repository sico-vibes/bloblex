import { useRef } from 'react'
import type { Runtime, Session } from '../types'
import { labelize } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentColorHex, previewHex, resolvedAgentColor } from './agentColor'
import { deriveCompanionStatus } from './companionStatus'
import type { AgentDraft } from './agentForm'
import { runtimeDotClass } from './rosterSelectors'
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
  const derived = deriveCompanionStatus({ connected, runtime, session: mode === 'create' ? null : session })
  const mood = mode === 'create' ? (connected ? 'idle' : 'offline') : derived.mood
  const lastValid = useRef(resolvedAgentColor(draft.color) ?? agentColorHex('mint'))
  const resolved = resolvedAgentColor(draft.color)
  if (resolved) lastValid.current = resolved
  // previewHex is the last-valid form of agentColorHex (spec section 4): an invalid draft keeps the previous paint.
  const paint = previewHex(draft.color, lastValid.current)
  const modelValue = model?.trim() ? model : 'CLI default'
  return <div className="blob-card">
    <div className="blob-profile">
      <BlobCanvas color={paint} size={96} mood={mood} label={draft.name.trim() || 'New blob'} />
      <div>
        <h2>{draft.name.trim() || 'New blob'}</h2>
        <p className="blob-muted">{draft.description.trim() ? draft.description : 'No description'}</p>
      </div>
    </div>
    <div className="blob-facts">
      <div className="blob-fact"><span>Runtime</span><strong><i className={`status-dot ${connected ? runtimeDotClass(runtime?.status) : 'muted'}`} /> {labelize(runtime?.provider, 'No runtime')} · {derived.label}</strong></div>
      <div className="blob-fact"><span>Model</span><strong>{modelValue}</strong></div>
      <p className="blob-help">Bloblex does not send a model until a later update.</p>
      <div className="blob-fact"><span>Status</span><strong>{derived.label}</strong></div>
      <div className="blob-fact"><span>Usage</span><strong>Open the Usage tab.</strong></div>
    </div>
    <SwatchGrid value={draft.color} onChange={onColorChange} />
  </div>
}
