// For people who used Bitbots before the Manager existed: a one-time card in
// the sidebar that sets it up. The old team leader stays an ordinary bot.
import { useState } from 'react'
import { X, BriefcaseBusiness } from 'lucide-react'
import type { Agent, Runtime } from '../types'
import { createDraft, type AgentDraft } from './agentForm'
import { providerBrand } from './providerBrand'
import { Select } from './Select'
import './managerSetup.css'

const LATER_KEY = 'bitbots.managerSetup.later'

export function managerSetupDismissed(): boolean {
  try { return sessionStorage.getItem(LATER_KEY) === '1' } catch { return false }
}

export function ManagerSetupCard({ runtimes, disabled, onCreate }: {
  runtimes: readonly Runtime[]
  disabled: boolean
  onCreate: (draft: AgentDraft) => Promise<Agent | null>
}) {
  const [hidden, setHidden] = useState(managerSetupDismissed)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('Manager')
  const [runtimeId, setRuntimeId] = useState(runtimes[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  if (hidden || runtimes.length === 0) return null
  const later = () => { try { sessionStorage.setItem(LATER_KEY, '1') } catch { /* preference only */ } setHidden(true) }
  const create = async () => {
    setBusy(true)
    try {
      const draft: AgentDraft = { ...createDraft(runtimes, runtimeId), name: name.trim() || 'Manager', runtimeId, color: 'violet', approvalMode: 'ask' }
      const created = await onCreate(draft)
      if (created) setHidden(true)
    } finally { setBusy(false) }
  }
  return <section className="manager-setup" aria-label="Set up your Manager">
    <header>
      <span className="manager-setup-icon" aria-hidden="true"><BriefcaseBusiness size={14} /></span>
      <strong>Meet your Manager</strong>
      <button type="button" className="queue-icon" aria-label="Later" title="Later" onClick={later}><X size={13} /></button>
    </header>
    <p>One bot that knows every project and bot, plans the work with you, and asks before it creates anything.</p>
    {!open
      ? <button type="button" className="primary-button small" disabled={disabled} onClick={() => setOpen(true)}>Set it up</button>
      : <div className="manager-setup-form">
        <label className="settings-field"><span>Name</span><input className="text-input" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} /></label>
        <div className="settings-field"><span>Coding agent</span><Select ariaLabel="Coding agent" variant="field" value={runtimeId} onChange={setRuntimeId} options={runtimes.map((runtime) => ({ value: runtime.id, label: providerBrand(runtime.provider).name, provider: runtime.provider }))} /></div>
        <div className="manager-setup-actions">
          <button type="button" className="ghost-button small" onClick={() => setOpen(false)}>Cancel</button>
          <button type="button" className="primary-button small" disabled={busy || disabled || !runtimeId} onClick={() => void create()}>{busy ? 'Setting up…' : 'Create Manager'}</button>
        </div>
      </div>}
  </section>
}
