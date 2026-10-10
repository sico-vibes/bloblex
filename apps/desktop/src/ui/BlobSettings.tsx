import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Project, Runtime } from '../types'
import { labelize } from '../types'
import { rpc } from '../tauri'
import type { AgentDraft, FieldErrors, StoredExecution } from './agentForm'
import { runtimeOptionLabel, scalarLength } from './rosterSelectors'
import { approvalDescription } from '../approvalContract'
import type { ApprovalMode, AutoResolvedAction } from '../approvalContract'
import {
  allowsCustomModelId, capabilityState, catalogModel, evidencePlain, instructionNote, isProviderUnavailable,
  outcomeText, parseCapabilities, parseExecSnapshot, parseModelCatalog, rpcFailure, selectionAfterModelChange,
  sendGateFor, settingReason, showThinkingControl, showTierControl,
  type CapabilitySetting, type ExecutionSendGate, type ExecSnapshotView, type ModelCatalog, type RuntimeCapabilities,
} from '../executionContract'
import { Select } from './Select'
import { ProviderLogo, providerBrand } from './providerBrand'
import { AutoApprovedList, BypassConfirmDialog } from './approvalUi'
import { RefreshCw } from 'lucide-react'
import { LookEditor } from './LookEditor'
import { draftLook } from '../blob/look'
import { agentColorHex, previewHex } from './agentColor'

export function BlobSettings({ draft, runtimes, projects = [], errors, execution, agentId, sessionId, autoApprovals, onDraftChange, onArchive, onExecutionGate }: {
  draft: AgentDraft
  runtimes: Runtime[]
  projects?: Project[]
  errors: FieldErrors
  execution: StoredExecution
  agentId?: string | null
  sessionId?: string | null
  /** Shown under the approval mode for saved blobs. */
  autoApprovals?: readonly AutoResolvedAction[]
  onDraftChange: (draft: AgentDraft) => void
  onArchive?: () => void
  onExecutionGate?: (gate: ExecutionSendGate) => void
}) {
  const descriptionCount = scalarLength(draft.description)
  const runtime = runtimes.find((item) => item.id === draft.runtimeId) ?? null
  const provider = runtime?.provider ?? ''
  const described = (id: string, errorId?: string) => errorId ? `${id} ${errorId}` : id
  const [capabilities, setCapabilities] = useState<RuntimeCapabilities | null>(null)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [catalogUnavailable, setCatalogUnavailable] = useState(false)
  const [loading, setLoading] = useState(false)
  const [snapshot, setSnapshot] = useState<ExecSnapshotView | null>(null)
  const [snapshotNote, setSnapshotNote] = useState('No conversation yet, so there is no applied snapshot.')
  const [custom, setCustom] = useState(false)
  const [bypassOpen, setBypassOpen] = useState(false)

  useEffect(() => {
    if (!draft.runtimeId) {
      setCapabilities(null)
      setCatalog(null)
      setCatalogError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setCatalogError(null)
    setCatalogUnavailable(false)
    const params = agentId ? { runtimeId: draft.runtimeId, agentId } : { runtimeId: draft.runtimeId }
    Promise.all([
      rpc('runtime.capabilities', params),
      rpc('runtime.models', { runtimeId: draft.runtimeId }),
    ]).then(([capsRaw, modelsRaw]) => {
      if (cancelled) return
      const nextCaps = parseCapabilities(capsRaw)
      const nextCatalog = parseModelCatalog(modelsRaw)
      setCapabilities(nextCaps)
      setCatalog(nextCatalog)
      if (!nextCatalog) {
        setCatalogError('The model catalog was not reported.')
        setCatalogUnavailable(false)
      }
      setLoading(false)
    }).catch((reason) => {
      if (cancelled) return
      const failure = rpcFailure(reason)
      setCapabilities(null)
      setCatalog(null)
      setCatalogUnavailable(isProviderUnavailable(failure))
      setCatalogError(isProviderUnavailable(failure) ? 'The provider could not be reached.' : failure.message)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [draft.runtimeId, agentId])

  useEffect(() => {
    if (!sessionId) {
      setSnapshot(null)
      setSnapshotNote('No conversation yet, so there is no applied snapshot.')
      return
    }
    let cancelled = false
    rpc('exec.snapshot.latest', { sessionId }).then((result) => {
      if (cancelled) return
      const parsed = parseExecSnapshot(result)
      setSnapshot(parsed)
      setSnapshotNote(parsed ? '' : 'No applied snapshot for this conversation yet.')
    }).catch((reason) => {
      if (cancelled) return
      const failure = rpcFailure(reason)
      setSnapshot(null)
      setSnapshotNote(failure.code === 'not_found' ? 'No applied snapshot for this conversation yet.' : failure.message)
    })
    return () => { cancelled = true }
  }, [sessionId])

  const selected = catalogModel(catalog, custom ? null : draft.model)
  const gate = useMemo(() => sendGateFor(capabilities, custom), [capabilities, custom])
  useEffect(() => { onExecutionGate?.(gate) }, [gate, onExecutionGate])

  const refreshCatalog = async () => {
    if (!draft.runtimeId) return
    setLoading(true)
    setCatalogError(null)
    setCatalogUnavailable(false)
    try {
      const modelsRaw = await rpc('runtime.models', { runtimeId: draft.runtimeId, refresh: true })
      const nextCatalog = parseModelCatalog(modelsRaw)
      setCatalog(nextCatalog)
      if (!nextCatalog) setCatalogError('The model catalog was not reported.')
    } catch (reason) {
      const failure = rpcFailure(reason)
      setCatalogUnavailable(isProviderUnavailable(failure))
      setCatalogError(isProviderUnavailable(failure) ? 'The provider could not be reached.' : failure.message)
    } finally { setLoading(false) }
  }

  const applyModel = (modelId: string | null, useCustom: boolean) => {
    const next = selectionAfterModelChange(modelId, catalog, useCustom)
    setCustom(useCustom)
    onDraftChange({ ...draft, model: next.model, thinking: next.thinking, serviceTier: next.serviceTier })
  }

  const modelState = capabilityState(capabilities?.settings.model ?? null)
  const modelInteractive = modelState === 'supported' && !loading
  const thinkingVisible = showThinkingControl(capabilities, selected, custom)
  const tierVisible = showTierControl(capabilities, selected, custom)
  const tierState = capabilityState(capabilities?.settings.serviceTier ?? null)
  const tierInteractive = tierState === 'supported'
  const instructionHelp = instructionNote(provider, capabilities?.settings.instructions ?? null)

  const onApproval = (value: string) => {
    if (value === 'bypass') { setBypassOpen(true); return }
    const mode = value === 'ask' || value === 'auto' ? value : null
    onDraftChange({ ...draft, approvalMode: mode })
  }

  return <>
    <EditGroup title="Look" label="Appearance">
      <LookEditor
        look={draftLook(draft, agentId)}
        color={draft.color}
        colorHex={previewHex(draft.color, agentColorHex('mint'))}
        name={draft.name.trim() || 'New blob'}
        onLookChange={(look) => onDraftChange({ ...draft, look })}
        onColorChange={(color) => onDraftChange({ ...draft, color })}
      />
    </EditGroup>

    <EditGroup title="Profile">
      <div className="blob-form">
        <label className="blob-field"><span>Name</span>
          <input aria-label="Blob name" aria-invalid={!!errors.name} aria-describedby={errors.name ? 'blob-name-error' : undefined} value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} />
        </label>
        {errors.name && <p className="blob-error" id="blob-name-error">{errors.name}</p>}
        <label className="blob-field"><span>Description <small id="blob-description-count" className={descriptionCount > 255 ? 'over' : undefined}>{descriptionCount} / 255</small></span>
          <textarea aria-label="Description" rows={2} aria-invalid={!!errors.description} aria-describedby={described('blob-description-count', errors.description ? 'blob-description-error' : undefined)} value={draft.description} onChange={(event) => onDraftChange({ ...draft, description: event.target.value })} />
        </label>
        {errors.description && <p className="blob-error" id="blob-description-error">{errors.description}</p>}
        <p className="blob-help">Teammates read this when deciding who to ask, and the blob reads it as part of its instructions.</p>
      </div>
    </EditGroup>

    <EditGroup title="Team">
      <div className="settings-row">
        <span className="settings-row-copy"><strong>Role</strong><small>A short label shown next to the name, like CTO or Researcher.</small></span>
        <span className="settings-row-control"><input className="text-input role-input" aria-label="Role" maxLength={40} placeholder="No role" value={draft.role} onChange={(event) => onDraftChange({ ...draft, role: event.target.value })} /></span>
      </div>
      <div className="settings-row">
        <span className="settings-row-copy"><strong>Project</strong><small>The blob works in the project's folder. Without one it is a casual blob for general requests.</small></span>
        <span className="settings-row-control"><Select ariaLabel="Project" variant="muted" value={draft.projectId ?? ''} onChange={(value) => onDraftChange({ ...draft, projectId: value || null })} options={[{ value: '', label: 'No project (casual)' }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} /></span>
      </div>
      <div className="settings-row">
        <span className="settings-row-copy"><strong>Team leader</strong><small>The leader coordinates the other blobs and reports back. Only one blob leads.</small></span>
        <span className="settings-row-control"><button type="button" role="switch" aria-checked={draft.leader} aria-label="Team leader" className={`toggle ${draft.leader ? 'on' : ''}`} onClick={() => onDraftChange({ ...draft, leader: !draft.leader })}><i /></button></span>
      </div>
    </EditGroup>

    <EditGroup title="Model" label="Execution" action={<span className="catalog-refresh-action">{catalog?.fetchedAt && <small>Updated {formatCatalogTime(catalog.fetchedAt)}</small>}<button type="button" className="ghost-button small" onClick={() => void refreshCatalog()} disabled={!draft.runtimeId || loading}><RefreshCw size={13} className={loading ? 'spinning' : ''} />Refresh models</button></span>}>
      <div className="settings-row">
        <span className="settings-row-copy"><strong>Coding agent</strong><small>New conversations use it. Existing ones keep theirs.</small></span>
        <span className="settings-row-control">
          <Select ariaLabel="Runtime" variant="muted" value={draft.runtimeId} onChange={(value) => { setCustom(false); onDraftChange({ ...draft, runtimeId: value, model: null, thinking: null, serviceTier: null }) }} options={runtimes.map((item) => ({ value: item.id, label: runtimeOptionLabel(item, runtimes), provider: item.provider }))} />
        </span>
      </div>
      {errors.runtimeId && <p className="blob-error blob-inset">{errors.runtimeId}</p>}
      {(loading || catalogError || (!loading && catalog && catalog.models.length === 0)) && <div className="blob-notes">
        {loading && <p className="blob-help" role="status">Loading models…</p>}
        {catalogError && <div className="blob-error" role="alert">
          <p>{catalogError}</p>
          {catalogUnavailable && <button type="button" className="secondary-button small" onClick={() => void refreshCatalog()}>Retry</button>}
        </div>}
        {!loading && catalog && catalog.models.length === 0 && <p className="blob-help">No models were reported for this agent.</p>}
      </div>}
      <CapabilityField label="Model" provider={provider} state={modelState} setting={capabilities?.settings.model ?? null}>
        <Select ariaLabel="Model" variant="muted" value={custom ? '__custom__' : (draft.model ?? '')} disabled={!modelInteractive} onChange={(value) => {
          if (value === '__custom__') applyModel(draft.model, true)
          else applyModel(value || null, false)
        }} options={[
          { value: '', label: 'Default model' },
          ...(catalog?.models ?? []).map((model, index, models) => ({ value: model.id, label: `${model.displayName}${model.isDefault ? ' · Default' : ''}`, group: model.group && model.group !== models[index - 1]?.group ? model.group : undefined, ...(index === 0 ? { groupBefore: [{ label: `${providerBrand(provider).name} models`, provider }] } : {}) })),
          ...(draft.model && !custom && !(catalog?.models ?? []).some((model) => model.id === draft.model)
            ? [{
                value: draft.model,
                label: catalog?.validated && !catalog.fallback
                  ? `${draft.model} · Not offered by ${providerLabel(provider)} right now`
                  : draft.model,
              }]
            : []),
          ...(allowsCustomModelId(provider) ? [{ value: '__custom__', label: 'Custom model id' }] : []),
        ]} />
      </CapabilityField>
      {catalog && (!catalog.validated || catalog.fallback) && <p className="blob-help model-catalog-note">Suggested models, not checked with {providerLabel(provider)}.</p>}
      {custom && allowsCustomModelId(provider) && <div className="blob-form blob-form-tight">
        <label className="blob-field"><span>Custom model id <small id="custom-model-note">Not validated</small></span>
          <input aria-label="Custom model id" aria-describedby="custom-model-note" value={draft.model ?? ''} disabled={!modelInteractive} onChange={(event) => onDraftChange({ ...draft, model: event.target.value || null, thinking: null, serviceTier: null })} />
        </label>
      </div>}
      {thinkingVisible && <div className="settings-row">
        <span className="settings-row-copy"><strong>Thinking</strong></span>
        <span className="settings-row-control">
          <Select ariaLabel="Thinking" variant="muted" value={draft.thinking ?? ''} onChange={(value) => onDraftChange({ ...draft, thinking: value || null })} options={[{ value: '', label: 'Default' }, ...(selected?.supportedThinking ?? []).map((level) => ({ value: level, label: labelize(level) }))]} />
        </span>
      </div>}
      {tierVisible && <CapabilityField label="Speed" state={tierState} setting={capabilities?.settings.serviceTier ?? null}>
        <Select ariaLabel="Speed" variant="muted" value={draft.serviceTier ?? ''} disabled={!tierInteractive} onChange={(value) => onDraftChange({ ...draft, serviceTier: value || null })} options={[{ value: '', label: 'Default' }, ...(selected?.serviceTiers ?? []).map((tier) => ({ value: tier.id, label: tier.name }))]} />
      </CapabilityField>}
      <div className="blob-form">
        <label className="blob-field"><span>Instructions</span>
          <textarea aria-label="Instructions" rows={4} placeholder="How should this blob work? For example: keep answers short and run the tests before finishing." aria-invalid={!!errors.instructions} aria-describedby={described('blob-instructions-help', errors.instructions ? 'blob-instructions-error' : undefined)} value={draft.instructions} onChange={(event) => onDraftChange({ ...draft, instructions: event.target.value })} />
        </label>
        <p id="blob-instructions-help" className="blob-help">{instructionHelp}</p>
        {errors.instructions && <p className="blob-error" id="blob-instructions-error">{errors.instructions}</p>}
        <label className="blob-field"><span>Default project</span>
          <input aria-label="Default project" aria-describedby="blob-project-help" placeholder="C:\path\to\project" value={draft.defaultProject ?? ''} onChange={(event) => onDraftChange({ ...draft, defaultProject: event.target.value })} />
        </label>
        <p id="blob-project-help" className="blob-help">Offered first when you start a conversation. Leave empty to pick from recent folders.</p>
      </div>
    </EditGroup>

    <EditGroup title="Permissions">
      <div className="settings-row">
        <span className="settings-row-copy"><strong>Approval mode</strong><small>{approvalDescription(draft.approvalMode)}</small></span>
        <span className="settings-row-control">
          <Select ariaLabel="Approval mode" variant="muted" value={draft.approvalMode ?? ''} onChange={onApproval} options={[{ value: '', label: 'Use default' }, { value: 'ask', label: 'Ask' }, { value: 'auto', label: 'Auto-approve' }, { value: 'bypass', label: 'Bypass' }]} />
        </span>
      </div>
      {autoApprovals && <div className="blob-form"><AutoApprovedList actions={autoApprovals} /></div>}
    </EditGroup>

    <EditGroup title="Details">
      <div className="settings-row"><span className="settings-row-copy"><strong>Concurrency</strong></span><span className="settings-value">{concurrencyText(capabilities, execution.maxConcurrency)}</span></div>
      <div className="blob-form" aria-label="Last applied snapshot">
        <span className="blob-field-label">Last applied settings</span>
        {snapshot ? <ul className="snapshot-outcomes">{snapshot.outcomes.map((outcome) => <li key={outcome.setting} data-outcome={outcome.label}><span>{outcome.setting === 'approvalMode' ? 'Approval mode' : outcome.setting === 'serviceTier' ? 'Speed' : labelize(outcome.setting)}</span><strong>{outcomeText(outcome)}</strong></li>)}</ul> : <p className="blob-help">{snapshotNote}</p>}
        {capabilities?.settings.customEnv && <p className="blob-help">{envNote(capabilities.settings.customEnv)}</p>}
        <p className="blob-help">Custom arguments are not accepted.</p>
      </div>
    </EditGroup>

    {onArchive && <section className="settings-group">
      <div className="settings-card">
        <div className="settings-row">
          <span className="settings-row-copy"><strong>Archive blob</strong><small>It leaves the sidebar. Its conversations stay saved.</small></span>
          <span className="settings-row-control"><button type="button" className="secondary-button small danger-button" onClick={onArchive}>Archive blob</button></span>
        </div>
      </div>
    </section>}
    {bypassOpen && <BypassConfirmDialog blobName={draft.name} onCancel={() => setBypassOpen(false)} onConfirm={() => { setBypassOpen(false); onDraftChange({ ...draft, approvalMode: 'bypass' satisfies ApprovalMode }) }} />}
  </>
}

function providerLabel(provider: string) { return providerBrand(provider).name || 'this agent' }

function formatCatalogTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function EditGroup({ title, label, action, children }: { title: string; label?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="settings-group blob-group" aria-label={label ?? title}>
    <div className="settings-group-head"><h3>{title}</h3>{action}</div>
    <div className="settings-card">{children}</div>
  </section>
}

function CapabilityField({ label, provider, state, setting, children }: { label: string; provider?: string; state: ReturnType<typeof capabilityState>; setting: CapabilitySetting | null; children: ReactNode }) {
  const reason = state === 'supported' ? '' : settingReason(setting, state)
  return <div className="settings-row" data-capability={state}>
    <span className="settings-row-copy"><strong>{provider ? <span className="model-picker-provider"><ProviderLogo provider={provider} />{label}</span> : label}</strong>{reason && <small>{reason}</small>}</span>
    <span className="settings-row-control">{children}</span>
  </div>
}

function concurrencyText(capabilities: RuntimeCapabilities | null, stored: number) {
  const agent = capabilities?.agentConcurrency
  if (!agent) return `Saved cap ${stored}. Effective cap not reported.`
  const configured = agent.configuredMaxConcurrency === null ? 'not reported' : String(agent.configuredMaxConcurrency)
  return `Configured ${configured} · effective ${agent.effectiveMaxConcurrency} · active ${agent.active}`
}

function envNote(setting: CapabilitySetting) {
  const state = capabilityState(setting)
  if (state !== 'supported') return settingReason(setting, state)
  const keys = setting.allowedKeys ?? []
  if (!keys.length) return 'Custom environment keys were not reported.'
  return `Allowed environment keys: ${keys.join(', ')}. Evidence: ${evidencePlain(setting.evidence)}.`
}
