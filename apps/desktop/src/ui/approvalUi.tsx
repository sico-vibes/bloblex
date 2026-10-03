import { useState, type RefObject } from 'react'
import { Shield } from 'lucide-react'
import type { ApprovalMode, AutoResolvedAction } from '../approvalContract'
import { newestFirst } from '../approvalContract'
import { useDialogAccessibility } from './dialogFocus'

export function ApprovalBadge({ mode }: { mode: ApprovalMode | null | undefined }) {
  if (mode !== 'auto' && mode !== 'bypass') return null
  const label = mode === 'auto' ? 'Auto-approve' : 'Bypass approvals'
  return <span className={`approval-badge approval-badge-${mode}`} role="img" aria-label={label} title={label}><Shield size={12} aria-hidden="true" /></span>
}

export function ApprovalPill({ mode, compact = false }: { mode: ApprovalMode | null | undefined; compact?: boolean }) {
  if (mode !== 'auto' && mode !== 'bypass') return null
  const label = mode === 'auto' ? 'Auto' : 'Bypass'
  return <span className={`approval-pill approval-pill-${mode}${compact ? ' compact' : ''}`} role="status">{label}</span>
}

export function AutoApprovedList({ actions }: { actions: readonly AutoResolvedAction[] }) {
  const rows = newestFirst(actions)
  return <section className="auto-approved" aria-label="Auto-approved actions">
    <span className="blob-field-label">Auto-approved actions</span>
    {rows.length === 0 ? <p className="blob-muted">No actions have been auto-approved.</p> : <ol className="auto-approved-list">
      {rows.map((action) => <li key={`${action.sequence}:${action.permissionId ?? action.summary}`}>
        <strong>{action.summary}</strong>
        <span>{action.category?.trim() ? action.category : 'Uncategorised'}</span>
        <span>{action.mode === 'auto' ? 'Auto' : 'Bypass'}</span>
      </li>)}
    </ol>}
  </section>
}

export function BypassConfirmDialog({ blobName, onConfirm, onCancel }: { blobName: string; onConfirm: () => void; onCancel: () => void }) {
  const ref = useDialogAccessibility(onCancel)
  const [typed, setTyped] = useState('')
  const matches = typed === blobName && blobName.length > 0
  return <div className="sheet-backdrop blob-dialog-backdrop">
    <section ref={ref as RefObject<HTMLElement>} className="blob-dialog" role="dialog" aria-modal="true" aria-labelledby="bypass-dialog-title" aria-describedby="bypass-dialog-body">
      <h2 id="bypass-dialog-title">Turn on bypass for {blobName || 'this blob'}?</h2>
      <div id="bypass-dialog-body">
        <p>Bypass approves every action without asking you. Where the provider allows it, Bloblex also starts that provider so it does not ask either.</p>
        <p>Budgets, cancel, and Pause all still stop the work. This choice applies only to this blob, and it takes effect for new requests immediately. Launch flags change when the next turn starts.</p>
        <p>Type the blob name to confirm.</p>
      </div>
      <label className="blob-field">Blob name
        <input aria-label="Type the blob name to confirm bypass" data-dialog-initial-focus value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
      </label>
      <div className="blob-dialog-actions">
        <button type="button" className="secondary-button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary-button" disabled={!matches} onClick={onConfirm}>Turn on bypass</button>
      </div>
    </section>
  </div>
}
