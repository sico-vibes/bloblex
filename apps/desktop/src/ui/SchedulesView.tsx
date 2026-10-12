// Schedules: automations that prompt a blob by itself. The daemon owns the
// timer and the runs; this view lists them and edits their definition.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CalendarClock, ChevronDown, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import type { Agent, Automation, AutomationRun } from '../types'
import { BlobCanvas } from '../blob/BlobCanvas'
import { agentLook } from '../blob/look'
import { agentColorHex } from './agentColor'
import { ConfirmDialog } from './BlobPage'
import { useDialogAccessibility, useDialogEntered } from './dialogFocus'
import { Select } from './Select'
import {
  RUN_STATUS_LABEL, WEEKDAYS, defaultDraft, describeNextRun, describeSchedule, draftToSchedule, localTimeZone, runReasonText, scheduleToDraft,
  type DaemonSchedule, type ScheduleDraft, type SchedulePreset,
} from './automationSchedule'
import './schedules.css'

export interface AutomationInput {
  agentId: string
  name: string
  prompt: string
  schedule: DaemonSchedule
  sessionMode: 'new' | 'reuse'
  approvalMode: 'plan' | 'auto'
  maxRuntimeSecs: number
  enabled?: boolean
}

export interface SchedulesViewProps {
  automations: readonly Automation[]
  agents: readonly Agent[]
  connected: boolean
  /** The global "pause all schedules" switch. */
  paused: boolean
  nowMs: number
  /** Restrict the list to one blob, from a blob's own page. */
  agentId?: string | null
  loadError?: string | null
  onBack: () => void
  onCreate: (input: AutomationInput) => Promise<void>
  onUpdate: (id: string, input: AutomationInput) => Promise<void>
  onSetEnabled: (id: string, enabled: boolean) => Promise<void>
  onRunNow: (id: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onLoadRuns: (id: string) => Promise<AutomationRun[]>
  onPreview: (schedule: DaemonSchedule) => Promise<string[]>
  onSetPaused: (paused: boolean) => Promise<void>
  onOpenSession?: (sessionId: string) => void
}

const RUNTIME_CHOICES = [
  { value: '900', label: '15 minutes' },
  { value: '1800', label: '30 minutes' },
  { value: '3600', label: '1 hour' },
  { value: '7200', label: '2 hours' },
  { value: '14400', label: '4 hours' },
]

const PRESET_CHOICES: Array<{ value: SchedulePreset; label: string }> = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Every week' },
  { value: 'hours', label: 'Every few hours' },
  { value: 'once', label: 'Once' },
  { value: 'custom', label: 'Custom (cron)' },
]

function pauseText(automation: Automation): string {
  switch (automation.pauseReason) {
    case 'needs_approval': return 'Waiting for your approval'
    case 'auto_failures': return 'Paused after three failed runs'
    default: return 'Paused'
  }
}

function statusDot(status: string) {
  return status === 'completed' ? 'ok' : status === 'running' ? 'live' : status === 'skipped' || status === 'cancelled' || status === 'interrupted' ? 'muted' : 'bad'
}

function stamp(value: string | null | undefined) {
  if (!value) return ''
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function SchedulesView(props: SchedulesViewProps) {
  const { automations, agents, connected, paused, nowMs, agentId, loadError, onBack, onSetPaused } = props
  const [editing, setEditing] = useState<Automation | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Automation | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { backRef.current?.focus() }, [])
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const visible = useMemo(() => [...automations]
    .filter((item) => !agentId || item.agentId === agentId)
    .sort((a, b) => Number(!!b.running) - Number(!!a.running) || a.name.localeCompare(b.name)), [automations, agentId])
  const proposals = visible.filter((item) => item.createdBy === 'agent' && item.pauseReason === 'needs_approval')
  const rest = visible.filter((item) => !proposals.includes(item))

  const act = async (id: string, work: () => Promise<void>) => {
    setBusy(id)
    setProblem(null)
    try { await work() } catch (reason) { setProblem(reason instanceof Error ? reason.message : 'That did not work.') } finally { setBusy(null) }
  }

  const card = (automation: Automation) => <ScheduleCard key={automation.id} automation={automation} agent={agentById.get(automation.agentId)} nowMs={nowMs} busy={busy === automation.id}
    onToggle={(enabled) => void act(automation.id, () => props.onSetEnabled(automation.id, enabled))}
    onRunNow={() => void act(automation.id, () => props.onRunNow(automation.id))}
    onEdit={() => setEditing(automation)}
    onDelete={() => setDeleting(automation)}
    onLoadRuns={props.onLoadRuns}
    onOpenSession={props.onOpenSession} />

  return <div className="schedules-page" data-schedules-root>
    <header className="blob-page-header">
      <button ref={backRef} type="button" className="analytics-icon-button" aria-label="Back" title="Back" onClick={onBack}><ArrowLeft size={16} /></button>
      <strong className="blob-page-heading">Schedules</strong>
      <button type="button" className="primary-button small schedules-new" disabled={!connected || agents.filter((a) => !a.archived).length === 0} onClick={() => setEditing('new')}><Plus size={14} aria-hidden="true" />New schedule</button>
    </header>
    <div className="schedules-scroll"><div className="schedules-column">
      <section className="schedules-global" aria-label="Schedule controls">
        <div>
          <strong>Pause all schedules</strong>
          <p>Schedules run only while Bloblex is running and your computer is awake. If runs were missed, one run starts when you are back.</p>
        </div>
        <button type="button" className={`toggle ${paused ? 'on' : ''}`} role="switch" aria-label="Pause all schedules" aria-checked={paused} disabled={!connected} onClick={() => void act('global', () => onSetPaused(!paused))}><i /></button>
      </section>
      {(problem || loadError) && <p className="schedules-problem" role="alert">{problem ?? loadError}</p>}
      {!connected && <p className="blob-muted" role="status">Connect to the local runtime to manage schedules.</p>}
      {connected && visible.length === 0 && <div className="schedules-empty">
        <CalendarClock size={22} aria-hidden="true" />
        <strong>Nothing scheduled yet</strong>
        <p>Ask a blob to do something on its own, like a morning summary of your repository or a nightly test run.</p>
      </div>}
      {proposals.length > 0 && <section aria-label="Proposed by blobs" className="schedules-group">
        <h3>Proposed by your blobs</h3>
        <p className="schedules-note">These stay off until you approve them.</p>
        <ul className="schedules-list">{proposals.map(card)}</ul>
      </section>}
      {rest.length > 0 && <ul className="schedules-list" aria-label="Schedules">{rest.map(card)}</ul>}
    </div></div>
    {editing && <AutomationEditor
      key={editing === 'new' ? 'new' : editing.id}
      existing={editing === 'new' ? null : editing}
      agents={agents.filter((agent) => !agent.archived)}
      defaultAgentId={agentId ?? null}
      onClose={() => setEditing(null)}
      onPreview={props.onPreview}
      onSave={async (input) => {
        if (editing === 'new') await props.onCreate({ ...input, enabled: true })
        else await props.onUpdate(editing.id, input)
        setEditing(null)
      }} />}
    {deleting && <ConfirmDialog title={`Delete “${deleting.name}”?`} body="The schedule stops. Conversations it already started stay where they are." confirmLabel="Delete" cancelLabel="Keep" tone="danger" onCancel={() => setDeleting(null)} onConfirm={async () => {
      const target = deleting
      setDeleting(null)
      await act(target.id, () => props.onDelete(target.id))
    }} />}
  </div>
}

function ScheduleCard({ automation, agent, nowMs, busy, onToggle, onRunNow, onEdit, onDelete, onLoadRuns, onOpenSession }: {
  automation: Automation
  agent: Agent | undefined
  nowMs: number
  busy: boolean
  onToggle: (enabled: boolean) => void
  onRunNow: () => void
  onEdit: () => void
  onDelete: () => void
  onLoadRuns: (id: string) => Promise<AutomationRun[]>
  onOpenSession?: (sessionId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [runs, setRuns] = useState<AutomationRun[] | null>(null)
  const [runsError, setRunsError] = useState<string | null>(null)
  const proposal = automation.createdBy === 'agent' && automation.pauseReason === 'needs_approval'
  const last = automation.lastRun ?? null
  useEffect(() => {
    if (!open) return
    let active = true
    setRunsError(null)
    onLoadRuns(automation.id).then((rows) => { if (active) setRuns(rows) }).catch(() => { if (active) setRunsError('Could not load the run history.') })
    return () => { active = false }
    // Reload when a new run is recorded.
  }, [open, automation.id, automation.lastRun?.id, automation.lastRun?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  const state = automation.running ? 'Running now'
    : !automation.enabled ? pauseText(automation)
    : automation.nextRunAt ? `Next run ${describeNextRun(automation.nextRunAt, nowMs)}`
    : 'No upcoming run'
  const headingId = `schedule-${automation.id}`

  return <li className={`schedule-card${automation.enabled ? '' : ' off'}${automation.running ? ' running' : ''}`}>
    <div className="schedule-row">
      <span className="schedule-face" aria-hidden="true">{agent && <BlobCanvas decorative color={agentColorHex(agent.color)} size={26} mood={automation.running ? 'working' : 'idle'} look={agentLook(agent)} label={agent.name} />}</span>
      <div className="schedule-main">
        <strong id={headingId} className="schedule-name">{automation.name}</strong>
        <span className="schedule-sub">{agent?.name ?? 'Unknown blob'} · {describeSchedule(automation.schedule)}</span>
        <span className="schedule-sub schedule-state" role="status">{state}{automation.approvalMode === 'plan' ? ' · read-only' : ''}</span>
      </div>
      <div className="schedule-actions">
        {proposal
          ? <button type="button" className="primary-button small" disabled={busy} onClick={() => onToggle(true)}>Approve</button>
          : <button type="button" className={`toggle ${automation.enabled ? 'on' : ''}`} role="switch" aria-labelledby={headingId} aria-checked={automation.enabled} disabled={busy} onClick={() => onToggle(!automation.enabled)}><i /></button>}
        <button type="button" className="queue-icon" aria-label={`Run ${automation.name} now`} title="Run now" disabled={busy || automation.running} onClick={onRunNow}><Play size={13} /></button>
        <button type="button" className="queue-icon" aria-label={`Edit ${automation.name}`} title="Edit" disabled={busy} onClick={onEdit}><Pencil size={13} /></button>
        <button type="button" className="queue-icon" aria-label={`Delete ${automation.name}`} title="Delete" disabled={busy} onClick={onDelete}><Trash2 size={13} /></button>
        <button type="button" className={`queue-icon schedule-expand${open ? ' open' : ''}`} aria-expanded={open} aria-label={`Run history for ${automation.name}`} title="Run history" onClick={() => setOpen((value) => !value)}><ChevronDown size={14} /></button>
      </div>
    </div>
    {proposal && <p className="schedule-proposal">{agent?.name ?? 'A blob'} proposed this. It runs in read-only mode until you approve it.</p>}
    {last && !open && <p className="schedule-last"><i className={`run-dot ${statusDot(last.status)}`} aria-hidden="true" />Last run {stamp(last.startedAt)} · {RUN_STATUS_LABEL[last.status] ?? last.status}</p>}
    {open && <div className="schedule-history">
      <p className="schedule-prompt" title={automation.prompt}>{automation.prompt}</p>
      {runsError && <p className="schedules-problem" role="alert">{runsError}</p>}
      {!runsError && runs === null && <p className="blob-muted">Loading…</p>}
      {runs && runs.length === 0 && <p className="blob-muted">No runs yet.</p>}
      {runs && runs.length > 0 && <ol className="schedule-runs">{runs.map((run) => <li key={run.id}>
        <i className={`run-dot ${statusDot(run.status)}`} aria-hidden="true" />
        <span className="run-when">{stamp(run.startedAt)}</span>
        <span className="run-status">{RUN_STATUS_LABEL[run.status] ?? run.status}{runReasonText(run.reason) ? ` · ${runReasonText(run.reason)}` : ''}</span>
        {run.sessionId && onOpenSession && <button type="button" className="queue-link" onClick={() => onOpenSession(String(run.sessionId))}>Open conversation</button>}
      </li>)}</ol>}
    </div>}
  </li>
}

function AutomationEditor({ existing, agents, defaultAgentId, onClose, onSave, onPreview }: {
  existing: Automation | null
  agents: readonly Agent[]
  defaultAgentId: string | null
  onClose: () => void
  onSave: (input: AutomationInput) => Promise<void>
  onPreview: (schedule: DaemonSchedule) => Promise<string[]>
}) {
  const entered = useDialogEntered()
  const { ref, close } = useDialogAccessibility(onClose)
  const [name, setName] = useState(existing?.name ?? '')
  const [agentId, setAgentId] = useState(existing?.agentId ?? defaultAgentId ?? agents[0]?.id ?? '')
  const [prompt, setPrompt] = useState(existing?.prompt ?? '')
  const [draft, setDraft] = useState<ScheduleDraft>(() => existing ? scheduleToDraft(existing.schedule) : defaultDraft(localTimeZone()))
  const [approvalMode, setApprovalMode] = useState<'plan' | 'auto'>(existing?.approvalMode ?? 'auto')
  const [sessionMode, setSessionMode] = useState<'new' | 'reuse'>(existing?.sessionMode ?? 'new')
  const [maxRuntime, setMaxRuntime] = useState(String(existing?.maxRuntimeSecs ?? 1800))
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [preview, setPreview] = useState<string[] | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const schedule = useMemo(() => draftToSchedule(draft), [draft])
  const scheduleKey = JSON.stringify(schedule)
  useEffect(() => {
    setPreview(null)
    setPreviewError(null)
    if (!schedule) return
    let active = true
    const timer = window.setTimeout(() => {
      onPreview(schedule).then((rows) => { if (active) setPreview(rows) }).catch((reason) => { if (active) setPreviewError(reason instanceof Error ? reason.message : 'That schedule is not valid.') })
    }, 300)
    return () => { active = false; window.clearTimeout(timer) }
  }, [scheduleKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const valid = name.trim().length > 0 && name.trim().length <= 80 && prompt.trim().length > 0 && prompt.length <= 8000 && !!agentId && !!schedule
  const set = (patch: Partial<ScheduleDraft>) => setDraft((current) => ({ ...current, ...patch }))
  const submit = async () => {
    if (!valid || !schedule || saving) return
    setSaving(true)
    setFailure(null)
    try {
      await onSave({ agentId, name: name.trim(), prompt: prompt.trim(), schedule, sessionMode, approvalMode, maxRuntimeSecs: Number(maxRuntime) })
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : 'The schedule could not be saved.')
      setSaving(false)
    }
  }

  return <div className={`sheet-backdrop blob-dialog-backdrop ${entered ? 'is-entered' : ''}`}>
    <section ref={ref} className="blob-dialog schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="schedule-dialog-title" tabIndex={-1}>
      <h2 id="schedule-dialog-title">{existing ? 'Edit schedule' : 'New schedule'}</h2>
      <label className="blob-field"><span>Name</span><input data-dialog-initial-focus value={name} maxLength={80} placeholder="Morning summary" onChange={(event) => setName(event.target.value)} /></label>
      <div className="blob-field"><span>Blob</span>
        <Select ariaLabel="Blob" variant="field" value={agentId} onChange={setAgentId} options={agents.map((agent) => ({ value: agent.id, label: agent.name }))} />
      </div>
      <label className="blob-field"><span>What should it do?<small className={prompt.length > 8000 ? 'over' : ''}>{prompt.length}/8000</small></span>
        <textarea rows={4} value={prompt} placeholder="Summarise what changed in the repository since yesterday and list anything that needs my attention." onChange={(event) => setPrompt(event.target.value)} />
      </label>
      <div className="blob-field"><span>When</span>
        <div className="schedule-when">
          <Select ariaLabel="Repeat" variant="field" value={draft.preset} onChange={(value) => set({ preset: value as SchedulePreset })} options={PRESET_CHOICES} />
          {(draft.preset === 'daily' || draft.preset === 'weekdays' || draft.preset === 'weekly') && <input type="time" aria-label="Time" value={draft.time} onChange={(event) => set({ time: event.target.value })} />}
          {draft.preset === 'weekly' && <Select ariaLabel="Day" variant="field" value={String(draft.weekday)} onChange={(value) => set({ weekday: Number(value) })} options={WEEKDAYS.map((label, index) => ({ value: String(index), label }))} />}
          {draft.preset === 'hours' && <Select ariaLabel="Hours between runs" variant="field" value={String(draft.everyHours)} onChange={(value) => set({ everyHours: Number(value) })} options={[1, 2, 3, 4, 6, 8, 12].map((n) => ({ value: String(n), label: n === 1 ? 'Every hour' : `Every ${n} hours` }))} />}
          {draft.preset === 'once' && <input type="datetime-local" aria-label="Date and time" value={draft.onceAt} onChange={(event) => set({ onceAt: event.target.value })} />}
          {draft.preset === 'custom' && <input aria-label="Cron expression" value={draft.cron} placeholder="m h dom mon dow" onChange={(event) => set({ cron: event.target.value })} />}
        </div>
        {draft.preset !== 'once' && <small className="schedule-zone">Time zone: {draft.timezone}</small>}
        <small className={`schedule-preview${previewError ? ' bad' : ''}`} role="status">
          {previewError ?? (schedule ? (preview ? (preview.length ? `Next: ${preview.join(' · ')}` : 'No upcoming runs.') : 'Checking…') : 'Choose a valid time.')}
        </small>
      </div>
      <fieldset className="schedule-modes">
        <legend>While it runs</legend>
        <label className="schedule-mode"><input type="radio" name="approval" checked={approvalMode === 'auto'} onChange={() => setApprovalMode('auto')} /><span><strong>Safe actions only</strong><small>Reads and edits inside the project run. Anything riskier is declined, because nobody is there to approve it.</small></span></label>
        <label className="schedule-mode"><input type="radio" name="approval" checked={approvalMode === 'plan'} onChange={() => setApprovalMode('plan')} /><span><strong>Read-only</strong><small>The blob looks and reports. It does not change anything.</small></span></label>
      </fieldset>
      <fieldset className="schedule-modes">
        <legend>Conversation</legend>
        <label className="schedule-mode"><input type="radio" name="session" checked={sessionMode === 'new'} onChange={() => setSessionMode('new')} /><span><strong>A new one each run</strong></span></label>
        <label className="schedule-mode"><input type="radio" name="session" checked={sessionMode === 'reuse'} onChange={() => setSessionMode('reuse')} /><span><strong>Keep going in the same one</strong><small>Each run sees what earlier runs did.</small></span></label>
      </fieldset>
      <div className="blob-field"><span>Stop a run after</span>
        <Select ariaLabel="Stop a run after" variant="field" value={maxRuntime} onChange={setMaxRuntime} options={RUNTIME_CHOICES} />
      </div>
      {failure && <p className="schedules-problem" role="alert">{failure}</p>}
      <div className="blob-dialog-actions">
        <button type="button" className="secondary-button" onClick={close}>Cancel</button>
        <button type="button" className="primary-button" disabled={!valid || saving} onClick={() => void submit()}>{saving ? 'Saving…' : existing ? 'Save' : 'Create schedule'}</button>
      </div>
    </section>
  </div>
}
