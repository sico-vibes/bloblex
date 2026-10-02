import { useEffect, useRef, useState } from 'react'
import type { AutoResolvedAction, BypassNotice } from '../approvalContract'
import { visibleApprovalMode } from '../approvalContract'
import type { Agent, Runtime, Session } from '../types'
import type { AgentDraft, FieldErrors, StoredExecution } from './agentForm'
import type { ExecutionSendGate } from '../executionContract'
import { ApprovalBadge, AutoApprovedList } from './approvalUi'
import { BlobOverview } from './BlobOverview'
import { BlobSessions } from './BlobSessions'
import { BlobSettings } from './BlobSettings'
import { BlobUsage } from './BlobUsage'

const TABS = ['Overview', 'Sessions', 'Usage', 'Settings'] as const
type BlobTab = (typeof TABS)[number]

export function BlobPage({ mode, agent, draft, runtime, session, runtimes, sessions, legacyCount, connected, saving, dirty, ready, canStartSession, error, remoteNotice, errors, execution, autoApprovals = [], bypassNotices = [], onDraftChange, onExecutionGate, onBack, onSave, onCancel, onArchive, onNewSession, onOpenSession }: {
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
  onDraftChange: (draft: AgentDraft) => void
  onExecutionGate?: (gate: ExecutionSendGate) => void
  onBack: () => void
  onSave: () => void
  onCancel: () => void
  onArchive: () => void
  onNewSession: () => void
  onOpenSession: (session: Session) => void
}) {
  const [tab, setTab] = useState<BlobTab>('Overview')
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
      <button ref={backRef} type="button" className="secondary-button" onClick={requestBack}>Back</button>
      <strong className="blob-page-heading">{title}</strong>
      <ApprovalBadge mode={badgeMode} />
      <div className="blob-page-actions">
        {dirty && <button type="button" className="secondary-button" onClick={requestCancel}>Cancel</button>}
        <button type="button" className="primary-button" disabled={!ready || saving || (mode === 'edit' && !dirty)} onClick={onSave}>{saving ? 'Saving…' : mode === 'create' ? 'Create blob' : 'Save'}</button>
      </div>
    </header>
    <div className="blob-page-scroll">
      <div className="blob-page-column">
        {error && <p className="blob-page-notice" role="alert">{error}</p>}
        {remoteNotice && <p className="blob-page-notice" role="status">{remoteNotice}</p>}
        {fieldErrors.map((message) => <p className="blob-error" role="alert" key={message}>{message}</p>)}
        <div className="blob-tabs" role="tablist" aria-label="Blob">
          {TABS.map((name, index) => <button key={name} type="button" id={`blob-tab-${name}`} role="tab" aria-selected={tab === name} aria-controls={`blob-panel-${name}`} tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)} onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length
            const target = TABS[next] ?? 'Overview'
            setTab(target)
            document.getElementById(`blob-tab-${target}`)?.focus()
          }}>{name}</button>)}
        </div>
        <div id={`blob-panel-${tab}`} role="tabpanel" aria-labelledby={`blob-tab-${tab}`}>
          {tab === 'Overview' && <>
            {bypassLine && <p className="blob-page-notice" role="status">Bypass is active for this blob. New requests are approved without asking.</p>}
            <BlobOverview draft={draft} runtime={runtime} session={session} connected={connected} model={execution.model} mode={mode} onColorChange={(color) => onDraftChange({ ...draft, color })} />
            <AutoApprovedList actions={blobActions} />
          </>}
          {tab === 'Sessions' && (mode === 'create'
            ? <section className="blob-card"><h3>Sessions</h3><p className="blob-muted">Save this blob to start conversations.</p></section>
            : <BlobSessions agent={agent} sessions={sessions} legacyCount={legacyCount} canCreate={canStartSession} onOpenSession={onOpenSession} onNewSession={onNewSession} />)}
          {tab === 'Usage' && <BlobUsage agentId={mode === 'edit' ? agent?.id ?? null : null} sessions={sessions} agents={agent ? [agent] : []} connected={connected} />}
          {tab === 'Settings' && <BlobSettings draft={draft} runtimes={runtimes} errors={errors} execution={execution} agentId={agent?.id ?? null} sessionId={latestSessionId} onDraftChange={onDraftChange} onExecutionGate={onExecutionGate} onArchive={mode === 'edit' ? onArchive : undefined} />}
        </div>
      </div>
    </div>
    {discardOpen && <ConfirmDialog title="Discard unsaved changes?" confirmLabel="Discard" cancelLabel="Keep editing" onConfirm={leave} onCancel={() => setDiscardOpen(false)} />}
  </div>
}

export function ConfirmDialog({ title, body, confirmLabel, cancelLabel, onConfirm, onCancel }: {
  title: string
  body?: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const ref = useDialogAccessibility(onCancel)
  return <div className="sheet-backdrop blob-dialog-backdrop">
    <section ref={ref} className="blob-dialog" role="dialog" aria-modal="true" aria-labelledby="blob-dialog-title" tabIndex={-1}>
      <h2 id="blob-dialog-title">{title}</h2>
      {body && <p>{body}</p>}
      <div className="blob-dialog-actions">
        <button type="button" className="secondary-button" data-dialog-initial-focus onClick={onCancel}>{cancelLabel}</button>
        <button type="button" className="primary-button" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </section>
  </div>
}

function useDialogAccessibility(onClose: () => void) {
  const ref = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusables = () => Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'))
    const initial = root.querySelector<HTMLElement>('[data-dialog-initial-focus]') ?? focusables()[0]
    const frame = requestAnimationFrame(() => initial?.focus())
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) { event.preventDefault(); root.focus(); return }
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', keydown); previous?.focus() }
  }, [])
  return ref
}
