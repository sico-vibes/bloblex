import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Runtime } from '../types'
import { labelize } from '../types'
import { rpc } from '../tauri'
import type { AgentDraft, FieldErrors, StoredExecution } from './agentForm'
import { runtimeDotClass, runtimeOptionLabel, scalarLength } from './rosterSelectors'
import { SwatchGrid } from './SwatchGrid'
import { approvalDescription } from '../approvalContract'
import type { ApprovalMode } from '../approvalContract'
import {
  allowsCustomModelId, capabilityState, catalogModel, evidencePlain, instructionNote, isProviderUnavailable,
  outcomeText, parseCapabilities, parseExecSnapshot, parseModelCatalog, rpcFailure, selectionAfterModelChange,
  sendGateFor, settingReason, showThinkingControl, showTierControl,
  type CapabilitySetting, type ExecutionSendGate, type ExecSnapshotView, type ModelCatalog, type RuntimeCapabilities,
} from '../executionContract'
import { Select } from './Select'
import { BypassConfirmDialog } from './approvalUi'

export function BlobSettings({ draft, runtimes, errors, execution, agentId, sessionId, onDraftChange, onArchive, onExecutionGate }: {
  draft: AgentDraft
  runtimes: Runtime[]
  errors: FieldErrors
  execution: StoredExecution
  agentId?: string | null
  sessionId?: string | null
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

  useEffect(() => {
    if (!catalog || !draft.model || allowsCustomModelId(provider) === false) return
    if (!catalog.models.some((model) => model.id === draft.model)) setCustom(true)
  }, [catalog, draft.model, provider])

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
    <section className="blob-card">
      <h3>Profile</h3>
      <SwatchGrid value={draft.color} onChange={(color) => onDraftChange({ ...draft, color })} />
      <label className="blob-field">Name
        <input aria-label="Blob name" aria-invalid={!!errors.name} aria-describedby={errors.name ? 'blob-name-error' : undefined} value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} />
      </label>
      {errors.name && <p className="blob-error" id="blob-name-error">{errors.name}</p>}
      <label className="blob-field">Description
        <textarea aria-label="Description" aria-invalid={!!errors.description} aria-describedby={described('blob-description-count', errors.description ? 'blob-description-error' : undefined)} value={draft.description} onChange={(event) => onDraftChange({ ...draft, description: event.target.value })} />
      </label>
      <p id="blob-description-count" className="blob-counter" style={{ color: descriptionCount > 255 ? 'var(--bad)' : 'var(--ink-3)' }}>{descriptionCount} / 255</p>
      {errors.description && <p className="blob-error" id="blob-description-error">{errors.description}</p>}
    </section>
    <section className="blob-card" aria-label="Execution">
      <h3>Execution</h3>
      <label className="blob-field">Runtime
        <span className="blob-runtime-picker">
          <i className={`status-dot ${runtimeDotClass(runtime?.status)}`} />
          <Select ariaLabel="Runtime" variant="field" align="left" value={draft.runtimeId} onChange={(value) => { setCustom(false); onDraftChange({ ...draft, runtimeId: value, model: null, thinking: null, serviceTier: null }) }} options={runtimes.map((item) => ({ value: item.id, label: runtimeOptionLabel(item, runtimes) }))} />
        </span>
      </label>
      {errors.runtimeId && <p className="blob-error">{errors.runtimeId}</p>}
      <p className="blob-help">New sessions use this runtime. Existing conversations stay on the runtime that started them.</p>
      {loading && <p className="blob-help" role="status">Loading execution options…</p>}
      {catalogError && <div className="blob-error" role="alert">
        <p>{catalogError}</p>
        {catalogUnavailable && <button type="button" className="secondary-button" onClick={() => void refreshCatalog()}>Retry</button>}
      </div>}
      {!loading && catalog && catalog.models.length === 0 && <p className="blob-help">No models were reported for this runtime.</p>}
      {catalog?.fallback && <p className="blob-help">These models are suggestions only. Bloblex has not validated that this runtime can run them.</p>}
      <CapabilityField label="Model" state={modelState} setting={capabilities?.settings.model ?? null}>
        <Select ariaLabel="Model" variant="field" align="left" value={custom ? '__custom__' : (draft.model ?? '')} disabled={!modelInteractive} onChange={(value) => {
          if (value === '__custom__') applyModel(draft.model, true)
          else applyModel(value || null, false)
        }} options={[
          { value: '', label: 'Runtime default' },
          ...(catalog?.models ?? []).map((model) => ({ value: model.id, label: model.displayName })),
          ...(draft.model && !custom && !(catalog?.models ?? []).some((model) => model.id === draft.model) ? [{ value: draft.model, label: draft.model }] : []),
          ...(allowsCustomModelId(provider) ? [{ value: '__custom__', label: 'Custom model id' }] : []),
        ]} />
        {custom && allowsCustomModelId(provider) && <>
          <input aria-label="Custom model id" aria-describedby="custom-model-note" value={draft.model ?? ''} disabled={!modelInteractive} onChange={(event) => onDraftChange({ ...draft, model: event.target.value || null, thinking: null, serviceTier: null })} />
          <p id="custom-model-note" className="blob-help">Not validated</p>
        </>}
      </CapabilityField>
      {thinkingVisible && <label className="blob-field">Thinking
        <Select ariaLabel="Thinking" variant="field" align="left" value={draft.thinking ?? ''} onChange={(value) => onDraftChange({ ...draft, thinking: value || null })} options={[{ value: '', label: 'Runtime default' }, ...(selected?.supportedThinking ?? []).map((level) => ({ value: level, label: level }))]} />
      </label>}
      {tierVisible && <CapabilityField label="Speed" state={tierState} setting={capabilities?.settings.serviceTier ?? null}>
        <Select ariaLabel="Speed" variant="field" align="left" value={draft.serviceTier ?? ''} disabled={!tierInteractive} onChange={(value) => onDraftChange({ ...draft, serviceTier: value || null })} options={[{ value: '', label: 'Runtime default' }, ...(selected?.serviceTiers ?? []).map((tier) => ({ value: tier.id, label: tier.name }))]} />
      </CapabilityField>}
      <div className="blob-field-actions">
        <button type="button" className="secondary-button" onClick={() => void refreshCatalog()} disabled={!draft.runtimeId || loading}>Refresh models</button>
      </div>
      <label className="blob-field">Instructions
        <textarea aria-label="Instructions" aria-invalid={!!errors.instructions} aria-describedby={described('blob-instructions-help', errors.instructions ? 'blob-instructions-error' : undefined)} value={draft.instructions} onChange={(event) => onDraftChange({ ...draft, instructions: event.target.value })} />
      </label>
      <p id="blob-instructions-help" className="blob-help">{instructionHelp}</p>
      {errors.instructions && <p className="blob-error" id="blob-instructions-error">{errors.instructions}</p>}
      <div className="blob-fact"><span>Concurrency</span><strong>{concurrencyText(capabilities, execution.maxConcurrency)}</strong></div>
      {capabilities?.settings.customEnv && <p className="blob-help">{envNote(capabilities.settings.customEnv)}</p>}
      <div aria-label="Last applied snapshot">
        <h4 className="blob-subhead">Last applied snapshot</h4>
        {snapshot ? <ul className="snapshot-outcomes">{snapshot.outcomes.map((outcome) => <li key={outcome.setting} data-outcome={outcome.label}><span>{outcome.setting === 'approvalMode' ? 'Approval mode' : outcome.setting === 'serviceTier' ? 'Speed' : labelize(outcome.setting)}</span><strong>{outcomeText(outcome)}</strong></li>)}</ul> : <p className="blob-help">{snapshotNote}</p>}
      </div>
      <label className="blob-field">Default project
        <input aria-label="Default project" aria-describedby="blob-project-help" value={draft.defaultProject ?? ''} onChange={(event) => onDraftChange({ ...draft, defaultProject: event.target.value })} />
      </label>
      <p id="blob-project-help" className="blob-help">Shown first when you start a session. Leave blank to pick from recent folders.</p>
      <p className="blob-help">Custom arguments are not accepted. Environment values are limited to the keys this runtime reports.</p>
      {onArchive && <button type="button" className="secondary-button" onClick={onArchive}>Archive blob</button>}
    </section>
    <section className="blob-card" aria-label="Permissions">
      <h3>Permissions</h3>
      <label className="blob-field">Approval mode
        <Select ariaLabel="Approval mode" variant="field" align="left" value={draft.approvalMode ?? ''} onChange={onApproval} options={[{ value: '', label: 'Inherit default' }, { value: 'ask', label: 'Ask' }, { value: 'auto', label: 'Auto-approve' }, { value: 'bypass', label: 'Bypass' }]} />
      </label>
      <p className="blob-help">{approvalDescription(draft.approvalMode)}</p>
    </section>
    {bypassOpen && <BypassConfirmDialog blobName={draft.name} onCancel={() => setBypassOpen(false)} onConfirm={() => { setBypassOpen(false); onDraftChange({ ...draft, approvalMode: 'bypass' satisfies ApprovalMode }) }} />}
  </>
}

function CapabilityField({ label, state, setting, children }: { label: string; state: ReturnType<typeof capabilityState>; setting: CapabilitySetting | null; children: ReactNode }) {
  const reason = state === 'supported' ? '' : settingReason(setting, state)
  return <label className="blob-field" data-capability={state}>
    {label}
    {children}
    {reason && <span className="blob-help">{reason}</span>}
  </label>
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
