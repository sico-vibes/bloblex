import { useRef, useState } from 'react'
import type { BlobMood } from '../blob/characterState'
import { BlobCanvas } from '../blob/BlobCanvas'
import { draftLook } from '../blob/look'
import type { AgentDraft } from './agentForm'
import { agentColorHex, previewHex, resolvedAgentColor } from './agentColor'
import { StatusDot, type BotStatus } from './StatusDot'
import { useEntityNoun } from './vocabulary'
import './botPreviewPane.css'

const MOODS: ReadonlyArray<{ id: 'idle' | 'working' | 'waiting'; label: string; mood: BlobMood; status: BotStatus; line: string }> = [
  { id: 'idle', label: 'Idle', mood: 'idle', status: 'idle', line: 'Ready' },
  { id: 'working', label: 'Working', mood: 'working', status: 'working', line: 'Working…' },
  { id: 'waiting', label: 'Waiting', mood: 'permission', status: 'waiting', line: 'Waiting for you' },
]

/**
 * Where the person will meet this bot: a sidebar row and a conversation header
 * drawn from the draft, updating as they type. The states let them check the
 * look in each mood without leaving the form. It shows no invented replies:
 * only the name, role, description and look the draft already holds.
 */
export function BotPreviewPane({ draft, agentId, connected = true }: { draft: AgentDraft; agentId: string | null; connected?: boolean }) {
  const noun = useEntityNoun()
  const [moodId, setMoodId] = useState<'idle' | 'working' | 'waiting'>('idle')
  const lastValid = useRef(resolvedAgentColor(draft.color) ?? agentColorHex('mint'))
  const resolved = resolvedAgentColor(draft.color)
  if (resolved) lastValid.current = resolved
  const paint = previewHex(draft.color, lastValid.current)
  const look = draftLook(draft, agentId)
  const state = MOODS.find((item) => item.id === moodId)!
  const name = draft.name.trim() || `New ${noun}`
  const role = draft.role.trim()
  const mood = connected ? state.mood : 'offline'
  return <section className="bot-preview" aria-label="How it will look">
    <header>
      <h2>Preview</h2>
      <div className="bot-preview-moods" role="radiogroup" aria-label="Preview state">
        {MOODS.map((item) => <button key={item.id} type="button" role="radio" aria-checked={moodId === item.id} className={moodId === item.id ? 'on' : ''} onClick={() => setMoodId(item.id)}>{item.label}</button>)}
      </div>
    </header>

    <div className="bot-preview-card" aria-hidden="true">
      <small>In the sidebar</small>
      <div className="bot-preview-row">
        <span className="bot-preview-face"><BlobCanvas decorative color={paint} size={40} mood={mood} look={look} label={name} /></span>
        <span className="bot-preview-copy">
          <span className="bot-preview-name"><strong>{name}</strong>{role && <span className="bot-preview-role">{role}</span>}</span>
          <span className={`bot-preview-line ${state.id === 'waiting' ? 'warn' : ''}`}>{state.line}</span>
        </span>
        {state.status !== 'idle' && <StatusDot status={state.status} />}
      </div>
    </div>

    <div className="bot-preview-card" aria-hidden="true">
      <small>In a conversation</small>
      <div className="bot-preview-head">
        <BlobCanvas decorative color={paint} size={28} mini mood={mood} look={look} label={name} />
        <strong>{name}</strong>
        {role && <span className="bot-preview-role">{role}</span>}
      </div>
      <p className="bot-preview-desc">{draft.description.trim() || `A short description helps teammates know when to ask this ${noun}.`}</p>
    </div>
  </section>
}
