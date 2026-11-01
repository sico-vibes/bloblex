import { useRef } from 'react'
import type { ApprovalMode } from '../approvalContract'
import type { Runtime, Session } from '../types'
import { labelize } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { draftLook } from '../blob/look'
import { agentColorHex, previewHex, resolvedAgentColor } from './agentColor'
import { ApprovalPill } from './approvalUi'
import { deriveCompanionStatus } from './companionStatus'
import type { AgentDraft } from './agentForm'
import { useEntityNoun } from './vocabulary'

/** Top of the blob editor: the character, its name and one line of facts. */
export function BlobOverview({ draft, runtime, session, connected, model, mode, approvalMode, agentId }: {
  draft: AgentDraft
  runtime: Runtime | null
  session: Session | null
  connected: boolean
  model: string | null
  mode: 'create' | 'edit'
  approvalMode?: ApprovalMode | null
  agentId?: string | null
}) {
  const derived = deriveCompanionStatus({ connected, runtime, session: mode === 'create' ? null : session, now: Date.now() })
  const noun = useEntityNoun()
  const Noun = useEntityNoun({ capital: true })
  const mood = mode === 'create' ? (connected ? 'idle' : 'offline') : derived.mood
  const lastValid = useRef(resolvedAgentColor(draft.color) ?? agentColorHex('mint'))
  const resolved = resolvedAgentColor(draft.color)
  if (resolved) lastValid.current = resolved
  // previewHex is the last-valid form of agentColorHex (spec section 4): an invalid draft keeps the previous paint.
  const paint = previewHex(draft.color, lastValid.current)
  const facts = [
    runtime ? labelize(runtime.provider) : 'No coding agent',
    model?.trim() ? model : 'Default model',
    mode === 'create' ? 'Not created yet' : derived.label,
  ]
  const name = draft.name.trim().toLowerCase()
  return <section className="blob-hero" aria-label={`${Noun} preview`}>
    <BlobCanvas color={paint} size={40} mood={mood} look={draftLook(draft, agentId)} label={draft.name.trim() || `New ${noun}`} />
    <div className="blob-hero-copy">
      <div className="blob-hero-name">
        {mode === 'create' && <h2>{draft.name.trim() || `New ${noun}`}</h2>}
        <ApprovalPill mode={approvalMode} />
      </div>
      <p className="blob-hero-facts">{facts.filter((fact) => fact.toLowerCase() !== name).join(' · ')}</p>
    </div>
  </section>
}
