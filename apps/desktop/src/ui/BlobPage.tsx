import { useEffect, useRef, useState } from 'react'
import type { AutoResolvedAction, BypassNotice } from '../approvalContract'
import { visibleApprovalMode } from '../approvalContract'
import type { Agent, Runtime, Session } from '../types'
import type { AgentDraft, FieldErrors, StoredExecution } from './agentForm'
import type { ExecutionSendGate } from '../executionContract'
import { ChevronLeft } from 'lucide-react'
import { BlobOverview } from './BlobOverview'
import { BlobSessions } from './BlobSessions'
import { BlobSettings } from './BlobSettings'
import { BlobUsage } from './BlobUsage'
import { useDialogAccessibility } from './dialogFocus'

export function BlobPage({ mode, agent, draft, runtime, session, runtimes, sessions, legacyCount, connected, saving, dirty, ready, canStartSession, error, remoteNotice, errors, execution, autoApprovals = [], bypassNotices = [], budgets = [], onSetPrices = () => undefined, onDraftChange, onExecutionGate, onBack, onSave, onCancel, onArchive, onNewSession, onOpenSession }: {
  mode: 'create' | 'edit'
  agent: Agent | null
  draft: AgentDraft
  runtime: Runtime | null
  session: Session | null
  runtimes: Runtime[]
  sessions: Session[]
  legacyCount: number
  connected: boolean
  saving: boolean
  dirty: boolean
  ready: boolean
  canStartSession: boolean
  error: string | null
  remoteNotice: string | null
  errors: FieldErrors
  execution: StoredExecution
  autoApprovals?: readonly AutoResolvedAction[]
  bypassNotices?: readonly BypassNotice[]
  budgets?: readonly Record<string, unknown>[]
  onSetPrices?: () => void
  onDraftChange: (draft: AgentDraft) => void
  onExecutionGate?: (gate: ExecutionSendGate) => void
  onBack: () => void
  onSave: () => void
  onCancel: () => void
  onArchive: () => void
  onNewSession: () => void
  onOpenSession: (session: Session) => void
}) {
  const [usageOpen, setUsageOpen] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const backRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { backRef.current?.focus() }, [])
  const title = mode === 'create' ? 'New blob' : agent?.name || draft.name || 'Blob'
  const badgeMode = visibleApprovalMode(draft.approvalMode, agent)
  const latestSessionId = [...sessions].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0]?.id ?? session?.id ?? null
  const blobActions = agent
    ? autoApprovals.filter((action) => action.agentId === agent.id || (!action.agentId && !!latestSessionId && action.sessionId === latestSessionId))
    : []
  const bypassLine = bypassNotices.some((notice) => agent && (notice.agentId === agent.id || (latestSessionId && notice.sessionId === latestSessionId)))
  const leave = () => { setDiscardOpen(false); onBack() }
  const requestBack = () => { if (dirty) setDiscardOpen(true); else onBack() }
  const requestCancel = () => {
    if (mode === 'create') { if (dirty) setDiscardOpen(true); else onBack(); return }
    if (dirty) onCancel()
  }
  const fieldErrors = Object.values(errors).filter((message): message is string => !!message)
  return <div className="blob-page">
    <header className="blob-page-header">
      <button ref={backRef} type="button" className="icon-button" aria-label="Back" title="Back" onClick={requestBack}><ChevronLeft size={18} aria-hidden="true" /></button>
      <strong className="blob-page-heading">{title}</strong>
      <div className="blob-page-actions">
        {dirty && <button type="button" className="ghost-button small" onClick={requestCancel}>Cancel</button>}
        <button type="button" className="primary-button small" disabled={!ready || saving || (mode === 'edit' && !dirty)} onClick={onSave}>{saving ? 'Saving…' : mode === 'create' ? 'Create blob' : 'Save'}</button>
      </div>
    </header>
    <div className="blob-page-scroll">
      <div className="blob-page-column">
        <BlobOverview draft={draft} runtime={runtime} session={session} connected={connected} model={execution.model} mode={mode} approvalMode={badgeMode} createdAt={agent?.createdAt ?? null} />
        {error && <p className="blob-page-notice error" role="alert">{error}</p>}
        {remoteNotice && <p className="blob-page-notice" role="status">{remoteNotice}</p>}
        {fieldErrors.map((message) => <p className="blob-page-notice error" role="alert" key={message}>{message}</p>)}
        {bypassLine && <p className="blob-page-notice warning" role="status">Bypass is active for this blob. New requests are approved without asking.</p>}
        <BlobSettings draft={draft} runtimes={runtimes} errors={errors} execution={execution} agentId={agent?.id ?? null} createdAt={agent?.createdAt ?? null} sessionId={latestSessionId} autoApprovals={mode === 'edit' ? blobActions : undefined} onDraftChange={onDraftChange} onExecutionGate={onExecutionGate} />
        {mode === 'edit' && <BlobSessions agent={agent} sessions={sessions} legacyCount={legacyCount} canCreate={canStartSession} onOpenSession={onOpenSession} onNewSession={onNewSession} />}
        <section className="settings-group blob-group" aria-label="Usage">
          <div className="settings-group-head">
            <h3>Usage</h3>
            {mode === 'edit' && agent && <button type="button" className="ghost-button small" aria-expanded={usageOpen} onClick={() => setUsageOpen((open) => !open)}>{usageOpen ? 'Hide usage' : 'Show usage'}</button>}
          </div>
          {mode === 'create' || !agent
            ? <div className="settings-card"><p className="settings-empty">Save this blob to see its usage.</p></div>
            : usageOpen ? <BlobUsage agentId={agent.id} sessions={sessions} agents={[agent]} runtimes={runtimes} budgets={budgets} connected={connected} onSetPrices={onSetPrices} /> : <div className="settings-card"><p className="settings-empty">Tokens, cost and run time for this blob.</p></div>}
        </section>
        {mode === 'edit' && <section className="settings-group blob-group" aria-label="Archive">
          <div className="settings-card">
            <div className="settings-row">
              <span className="settings-row-copy"><strong>Archive blob</strong><small>It leaves the sidebar. Its conversations stay saved.</small></span>
              <span className="settings-row-control"><button type="button" className="secondary-button small danger-button" onClick={onArchive}>Archive blob</button></span>
            </div>
          </div>
        </section>}
      </div>
    </div>
    {discardOpen && <ConfirmDialog title="Discard unsaved changes?" confirmLabel="Discard" cancelLabel="Keep editing" onConfirm={leave} onCancel={() => setDiscardOpen(false)} />}
  </div>
}

export function ConfirmDialog({ title, body, confirmLabel, cancelLabel, confirmDisabled = false, onConfirm, onCancel }: {
  title: string
  body?: string
  confirmLabel: string
  cancelLabel: string
  confirmDisabled?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { ref, close } = useDialogAccessibility(onCancel)
  return <div className="sheet-backdrop blob-dialog-backdrop">
    <section ref={ref} className="blob-dialog" role="dialog" aria-modal="true" aria-labelledby="blob-dialog-title" tabIndex={-1}>
      <h2 id="blob-dialog-title">{title}</h2>
      {body && <p>{body}</p>}
      <div className="blob-dialog-actions">
        <button type="button" className="secondary-button" data-dialog-initial-focus onClick={close}>{cancelLabel}</button>
        <button type="button" className="primary-button" disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </section>
  </div>
}
