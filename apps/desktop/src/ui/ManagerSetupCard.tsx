// Sidebar setup stays available until a Manager exists.
import { useState } from 'react'
import { BriefcaseBusiness } from 'lucide-react'
import type { Agent, Runtime } from '../types'
import { createDraft, type AgentDraft } from './agentForm'
import { providerBrand } from './providerBrand'
import { Select } from './Select'
import './managerSetup.css'

export function ManagerSetupCard({ runtimes, disabled, onCreate }: {
  runtimes: readonly Runtime[]
  disabled: boolean
  onCreate: (draft: AgentDraft) => Promise<Agent | null>
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('Manager')
  const [runtimeId, setRuntimeId] = useState(runtimes[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const selectedRuntimeId = runtimes.find((runtime) => runtime.id === runtimeId)?.id ?? runtimes[0]?.id ?? ''
  const create = async () => {
    if (busy || disabled || !selectedRuntimeId) return
    setBusy(true)
    try {
      const draft: AgentDraft = { ...createDraft(runtimes, selectedRuntimeId), name: name.trim() || 'Manager', runtimeId: selectedRuntimeId, color: 'violet' }
      await onCreate(draft)
    } finally { setBusy(false) }
  }
  return <section className="manager-setup" aria-label="Set up your Manager">
    <header>
      <span className="manager-setup-icon" aria-hidden="true"><BriefcaseBusiness size={14} /></span>
      <strong>Meet your Manager</strong>
    </header>
    <p>One bot that knows every project and bot, plans the work with you, and asks before it creates anything. Starts with Full access on this device; team changes still need your approval.</p>
    {!selectedRuntimeId && <p role="status">No coding agent is ready yet.</p>}
    {!open
      ? <button type="button" className="primary-button small" disabled={disabled || !selectedRuntimeId} onClick={() => setOpen(true)}>Set it up</button>
      : <div className="manager-setup-form">
        <label className="settings-field"><span>Name</span><input className="text-input" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} /></label>
        <div className="settings-field"><span>Coding agent</span><Select ariaLabel="Coding agent" variant="field" value={selectedRuntimeId} disabled={disabled || busy || !selectedRuntimeId} onChange={setRuntimeId} options={runtimes.map((runtime) => ({ value: runtime.id, label: providerBrand(runtime.provider).name, provider: runtime.provider }))} /></div>
        <div className="manager-setup-actions">
          <button type="button" className="ghost-button small" onClick={() => setOpen(false)}>Cancel</button>
          <button type="button" className="primary-button small" disabled={busy || disabled || !selectedRuntimeId} onClick={() => void create()}>{busy ? 'Setting up…' : 'Create Manager'}</button>
        </div>
      </div>}
  </section>
}
