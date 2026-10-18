import { organizeModels, presentedModelName } from './modelPresentation'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Project, Runtime, Session } from '../types'
import { labelize } from '../types'
import { openProjectFolder, rpc } from '../tauri'
import type { AgentDraft, BotSection, FieldErrors, StoredExecution } from './agentForm'
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
import { providerBrand } from './providerBrand'
import { AutoApprovedList, BypassConfirmDialog } from './approvalUi'
import { ChevronDown, ChevronRight, Hand, RefreshCw, ShieldAlert, ShieldCheck, type LucideIcon } from 'lucide-react'
import { HelpTip, RowCopy } from './SettingsParts'
import { fetchCached, invalidateCatalog, readCached } from './catalogCache'
import { LookEditor } from './LookEditor'
import { draftLook } from '../blob/look'
import { agentColorHex, previewHex } from './agentColor'
import { labelizeEffort } from './effortLabels'
import { preferredConcreteModel } from './modelPreferences'
import { useEntityNoun } from './vocabulary'
import { useAutosizeTextarea } from './useAutosize'
import { instructionCounts, instructionVersions, thousands, type InstructionVersion } from './instructionHistory'
import { instructionPresets, type BotTemplate } from './botTemplates'
import { recentFolders, rememberFolder } from './folderRecents'
import { useDetailsOpen } from './botPrefs'
import { BotMemoryGroup } from './BotMemoryGroup'
import { BotSkillsGroup } from './BotSkillsGroup'

const NOTIFICATION_LEVEL_HELP: Record<'all' | 'input' | 'muted', string> = {
  all: 'Tells you when it finishes, fails or needs you.',
  input: 'Tells you only when it needs an approval or an answer.',
  muted: 'Stays quiet. You can still see it in the app.',
}

/** Plain-language permissions (FIX22 B8). The values are unchanged. */
const APPROVAL_CHOICES: ReadonlyArray<{ value: ApprovalMode; name: string; sentence: string; Icon: LucideIcon }> = [
  { value: 'ask', name: 'Ask first', sentence: 'nothing changes until you approve each action', Icon: Hand },
  { value: 'auto', name: 'Auto-approve', sentence: 'safe actions go through, risky ones still ask', Icon: ShieldCheck },
  { value: 'bypass', name: 'Bypass', sentence: 'nothing asks; use only on a computer and project you trust', Icon: ShieldAlert },
]

export function BlobSettings({ draft, runtimes, projects = [], errors, execution, agentId, savedRuntimeId, sessionId, autoApprovals, sections, sessions, memoryEnabled, manager = false, locked = false, onOpenMemory, onOpenSkills, onDraftChange, onArchive, onExecutionGate }: {
  draft: AgentDraft
  runtimes: Runtime[]
  projects?: Project[]
  errors: FieldErrors
  execution: StoredExecution
  agentId?: string | null
  /** The saved bot's runtime. The agent id is only sent with capability checks for that runtime. */
  savedRuntimeId?: string | null
  sessionId?: string | null
  /** Shown under the approval mode for saved blobs. */
  autoApprovals?: readonly AutoResolvedAction[]
  /** When given, only these groups render (used by the create wizard). Default: all. */
  sections?: readonly BotSection[]
  /** This bot's conversations, for the one-line activity summary. */
  sessions?: readonly Session[]
  /** Overrides the `experimental.memory` setting read from the daemon. */
  memoryEnabled?: boolean
  /** Opens Settings › Memory. Rendered only when given. */
  onOpenMemory?: () => void
  onOpenSkills?: () => void
  /** Editing the built-in Manager: no project, can't be archived. */
  manager?: boolean
  /** FIX39 item 13: a locked bot's settings open read-only behind a banner. */
  locked?: boolean
  onDraftChange: (draft: AgentDraft) => void
  onArchive?: () => void
  onExecutionGate?: (gate: ExecutionSendGate) => void
}) {
  const descriptionCount = scalarLength(draft.description)
  const noun = useEntityNoun()
  const Noun = useEntityNoun({ capital: true })
  const runtime = runtimes.find((item) => item.id === draft.runtimeId) ?? null
  const provider = runtime?.provider ?? ''
  const described = (id: string, errorId?: string) => errorId ? `${id} ${errorId}` : id
  const show = (id: BotSection) => !sections || sections.includes(id)
  const [capabilities, setCapabilities] = useState<RuntimeCapabilities | null>(null)
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [catalogUnavailable, setCatalogUnavailable] = useState(false)
  const [loading, setLoading] = useState(false)
  const [snapshot, setSnapshot] = useState<ExecSnapshotView | null>(null)
  const [snapshotNote, setSnapshotNote] = useState('No conversation yet, so there is no applied snapshot.')
  const [custom, setCustom] = useState(false)
  const [bypassOpen, setBypassOpen] = useState(false)
  const [recents, setRecents] = useState<string[]>(() => recentFolders())
  const [memoryOn, setMemoryOn] = useState(memoryEnabled ?? false)
  const [detailsOpen, setDetailsOpen] = useDetailsOpen()

  useEffect(() => {
    if (!draft.runtimeId) {
      setCapabilities(null)
      setCatalog(null)
      setCatalogError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    const cachedModels = readCached('runtime.models', { runtimeId: draft.runtimeId })
    const cachedCatalog = cachedModels === undefined ? null : parseModelCatalog(cachedModels)
    setCatalog(cachedCatalog)
    setLoading(!cachedCatalog)
    setCatalogError(null)
    setCatalogUnavailable(false)
    const probeModel = draft.model ?? (provider === 'claude' ? 'sonnet' : undefined)
    // A bot being moved to another coding agent is still saved on its old one, so its id only goes with its own runtime.
    const sameRuntime = !!agentId && (!savedRuntimeId || savedRuntimeId === draft.runtimeId)
    const params = { runtimeId: draft.runtimeId, ...(sameRuntime ? { agentId } : {}), ...(probeModel ? { model: probeModel } : {}) }
    // Models and capabilities load on their own, so a capability failure never blanks the model list.
    // The model list comes from the shared cache (warmed at boot), so it is usually instant.
    void Promise.allSettled([
      rpc('runtime.capabilities', params),
      fetchCached('runtime.models', { runtimeId: draft.runtimeId }),
    ]).then(([capsResult, modelsResult]) => {
      if (cancelled) return
      setCapabilities(capsResult.status === 'fulfilled' ? parseCapabilities(capsResult.value) : null)
      if (modelsResult.status === 'fulfilled') {
        const nextCatalog = parseModelCatalog(modelsResult.value)
        setCatalog(nextCatalog)
        if (!nextCatalog) setCatalogError('The model list was not reported.')
      } else {
        const failure = rpcFailure(modelsResult.reason)
        setCatalog(null)
        setCatalogUnavailable(isProviderUnavailable(failure))
        setCatalogError(isProviderUnavailable(failure) ? 'The coding agent could not be reached.' : failure.message)
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [draft.runtimeId, draft.model, agentId, savedRuntimeId, provider])

  useEffect(() => {
    if (agentId || custom || draft.model || !catalog?.validated) return
    const initial = preferredConcreteModel(provider, catalog.models)
    if (initial) onDraftChange({ ...draft, model: initial.id, thinking: null, serviceTier: null })
  }, [agentId, catalog, custom, draft, draft.model, onDraftChange, provider])

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

  // Memory is experimental: the group only renders when the daemon says it is on.
  useEffect(() => {
    if (memoryEnabled !== undefined) { setMemoryOn(memoryEnabled); return }
    if (!agentId) { setMemoryOn(false); return }
    let cancelled = false
    rpc<{ settings?: Record<string, unknown> }>('settings.get').then((result) => {
      if (cancelled) return
      setMemoryOn(result?.settings?.['experimental.memory'] === true)
    }).catch(() => { if (!cancelled) setMemoryOn(false) })
    return () => { cancelled = true }
  }, [memoryEnabled, agentId])

  const selected = catalogModel(catalog, custom ? null : draft.model)
  const gate = useMemo(() => sendGateFor(capabilities, custom), [capabilities, custom])
  useEffect(() => { onExecutionGate?.(gate) }, [gate, onExecutionGate])

  const refreshCatalog = async () => {
    if (!draft.runtimeId) return
    setLoading(true)
    setCatalogError(null)
    setCatalogUnavailable(false)
    try {
      const probeModel = draft.model ?? (provider === 'claude' ? 'sonnet' : undefined)
      const modelsRaw = await rpc('runtime.models', { runtimeId: draft.runtimeId, refresh: true, ...(probeModel ? { model: probeModel } : {}) })
      invalidateCatalog(draft.runtimeId)
      void fetchCached('runtime.models', { runtimeId: draft.runtimeId }, { force: true }).catch(() => undefined)
      const nextCatalog = parseModelCatalog(modelsRaw)
      setCatalog(nextCatalog)
      if (!nextCatalog) setCatalogError('The model list was not reported.')
    } catch (reason) {
      const failure = rpcFailure(reason)
      setCatalogUnavailable(isProviderUnavailable(failure))
      setCatalogError(isProviderUnavailable(failure) ? 'The coding agent could not be reached.' : failure.message)
    } finally { setLoading(false) }
  }

  const applyModel = (modelId: string | null, useCustom: boolean) => {
    const next = selectionAfterModelChange(modelId, catalog, useCustom)
    setCustom(useCustom)
    onDraftChange({ ...draft, model: next.model, thinking: next.thinking, serviceTier: next.serviceTier })
  }

  const chooseFolder = (path: string) => {
    const trimmed = path.trim()
    if (!trimmed) return
    onDraftChange({ ...draft, defaultProject: trimmed })
    rememberFolder(trimmed)
    setRecents(recentFolders())
  }
  const browseFolder = async () => {
    const path = await openProjectFolder().catch(() => null)
    if (path) chooseFolder(path)
  }

  const modelState = capabilityState(capabilities?.settings.model ?? null)
  const modelInteractive = modelState === 'supported' && !loading
  const thinkingVisible = showThinkingControl(capabilities, selected, custom)
  const tierVisible = showTierControl(capabilities, selected, custom)
  const tierState = capabilityState(capabilities?.settings.serviceTier ?? null)
  const tierInteractive = tierState === 'supported'
  const instructionHelp = instructionNote(provider, capabilities?.settings.instructions ?? null)

  const onApproval = (value: string) => {
    if (value === 'bypass') { if (draft.approvalMode !== 'bypass') setBypassOpen(true); return }
    const mode = value === 'ask' || value === 'auto' ? value : null
    onDraftChange({ ...draft, approvalMode: mode })
  }

  return <fieldset className="blob-settings-body" disabled={locked} aria-label={locked ? 'Locked bot settings' : undefined}>
    {show('look') && <EditGroup id="look" title="Look" label="Appearance">
      <LookEditor
        look={draftLook(draft, agentId)}
        color={draft.color}
        colorHex={previewHex(draft.color, agentColorHex('mint'))}
        name={draft.name.trim() || `New ${noun}`}
        locked={locked}
        onLookChange={(look, color) => onDraftChange({ ...draft, look, color: color ?? draft.color })}
        onColorChange={(color) => onDraftChange({ ...draft, color })}
      />
    </EditGroup>}

    {show('profile') && <EditGroup id="profile" title="Profile">
      <div className="blob-form">
        <label className="blob-field"><span>Name</span>
          <input aria-label={`${Noun} name`} aria-invalid={!!errors.name} aria-describedby={errors.name ? 'blob-name-error' : undefined} value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} />
        </label>
        {errors.name && <p className="blob-error" id="blob-name-error">{errors.name}</p>}
        <label className="blob-field"><span className="blob-field-title">Description<HelpTip text={`Teammates read this when deciding who to ask, and the ${noun} reads it as part of its instructions.`} align="start" /><small id="blob-description-count" className={descriptionCount > 255 ? 'over' : undefined}>{descriptionCount} / 255</small></span>
          <textarea aria-label="Description" rows={2} aria-invalid={!!errors.description} aria-describedby={described('blob-description-count', errors.description ? 'blob-description-error' : undefined)} value={draft.description} onChange={(event) => onDraftChange({ ...draft, description: event.target.value })} />
        </label>
        {errors.description && <p className="blob-error" id="blob-description-error">{errors.description}</p>}
      </div>
    </EditGroup>}

    {show('team') && <EditGroup id="team" title="Team">
      <div className="settings-row">
        <RowCopy label="Role" hint="A short label shown next to the name, like CTO or Researcher." />
        <span className="settings-row-control"><input className="text-input role-input" aria-label="Role" maxLength={40} placeholder="No role" value={draft.role} onChange={(event) => onDraftChange({ ...draft, role: event.target.value })} /></span>
      </div>
      {manager ? <div className="settings-row">
        <RowCopy label="Projects" hint={`The Manager works across every project and knows every ${noun}. It can't be moved into one.`} />
        <span className="settings-row-control"><span className="settings-value">All projects</span></span>
      </div> : <div className="settings-row">
        <RowCopy label="Team project" hint={`Which project this ${noun} belongs to on the team.`} />
        <span className="settings-row-control"><Select ariaLabel="Team project" variant="muted" value={draft.projectId ?? ''} onChange={(value) => onDraftChange({ ...draft, projectId: value || null })} options={[{ value: '', label: 'No team project (casual)' }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} /></span>
      </div>}
    </EditGroup>}

    {show('model') && <EditGroup id="model" title="Model" label="Execution" action={<span className="catalog-refresh-action">{catalog?.fetchedAt && <small>Updated {formatCatalogTime(catalog.fetchedAt)}</small>}<button type="button" className="ghost-button small" onClick={() => void refreshCatalog()} disabled={!draft.runtimeId || loading}><RefreshCw size={13} className={loading ? 'spinning' : ''} />Refresh models</button></span>}>
      <div className="settings-row">
        <RowCopy label="Coding agent" hint="New conversations use it. Existing ones keep theirs." />
        <span className="settings-row-control">
          <Select ariaLabel="Runtime" variant="muted" value={draft.runtimeId} onChange={(value) => { setCustom(false); onDraftChange({ ...draft, runtimeId: value, model: null, thinking: null, serviceTier: null }) }} options={runtimes.map((item) => ({ value: item.id, label: runtimeOptionLabel(item, runtimes), provider: item.provider }))} />
        </span>
      </div>
      {errors.runtimeId && <p className="blob-error blob-inset">{errors.runtimeId}</p>}
      {(catalogError || (!loading && catalog && catalog.models.length === 0)) && <div className="blob-notes model-notes">
        {catalogError && <div className="blob-error" role="alert">
          <p>{catalogError}</p>
          {catalogUnavailable && <button type="button" className="secondary-button small" onClick={() => void refreshCatalog()}>Retry</button>}
        </div>}
        {!loading && catalog && catalog.models.length === 0 && <p className="blob-help">No models were reported for this agent.</p>}
      </div>}
      {loading && !catalog
        ? <div className="settings-row model-skeleton" role="status" aria-busy="true"><span className="skeleton-block model-skeleton-label" /><span className="skeleton-block model-skeleton-control" /><span className="sr-only">Loading models…</span></div>
        : <CapabilityField label="Model" state={modelState} setting={capabilities?.settings.model ?? null}>
        <Select ariaLabel="Model" variant="muted" searchable={8} searchPlaceholder="Search models" placeholder={catalog ? 'Choose a model' : 'Model unavailable'} value={custom ? '__custom__' : (draft.model ?? '')} disabled={!modelInteractive} onChange={(value) => {
          if (value === '__custom__') applyModel(draft.model, true)
          else applyModel(value || null, false)
        }} options={[
          ...organizeModels(provider, catalog?.models ?? []).map((model, index, models) => ({ value: model.id, label: presentedModelName(provider, model), group: model.group && model.group !== models[index - 1]?.group ? model.group : undefined })),
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
      </CapabilityField>}
      {catalog && (!catalog.validated || catalog.fallback) && <p className="blob-help model-catalog-note">Suggested models, not checked with {providerLabel(provider)}.</p>}
      {custom && allowsCustomModelId(provider) && <div className="blob-form blob-form-tight">
        <label className="blob-field"><span>Custom model id <small id="custom-model-note">Not validated</small></span>
          <input aria-label="Custom model id" aria-describedby="custom-model-note" value={draft.model ?? ''} disabled={!modelInteractive} onChange={(event) => onDraftChange({ ...draft, model: event.target.value || null, thinking: null, serviceTier: null })} />
        </label>
      </div>}
      {thinkingVisible && <div className="settings-row">
        <span className="settings-row-copy"><strong>Thinking</strong></span>
        <span className="settings-row-control">
          <Select ariaLabel="Thinking" variant="muted" value={draft.thinking ?? ''} onChange={(value) => onDraftChange({ ...draft, thinking: value || null })} options={[{ value: '', label: 'Default' }, ...(selected?.supportedThinking ?? []).map((level) => ({ value: level, label: labelizeEffort(level, provider) }))]} />
        </span>
      </div>}
      {tierVisible && <CapabilityField label="Speed" state={tierState} setting={capabilities?.settings.serviceTier ?? null}>
        <Select ariaLabel="Speed" variant="muted" value={draft.serviceTier ?? ''} disabled={!tierInteractive} onChange={(value) => onDraftChange({ ...draft, serviceTier: value || null })} options={[{ value: '', label: 'Default' }, ...(selected?.serviceTiers ?? []).map((tier) => ({ value: tier.id, label: tier.name }))]} />
      </CapabilityField>}

      <InstructionsSection draft={draft} agentId={agentId ?? null} error={errors.instructions} help={instructionHelp} noun={noun} onDraftChange={onDraftChange} />

      <div className="blob-form">
        <label className="blob-field"><span className="blob-field-title">Working folder<HelpTip text={`Where this ${noun} works when you start a conversation. Leave empty to pick a folder each time.`} align="start" /></span>
          <input aria-label="Working folder" placeholder="C:\path\to\folder" value={draft.defaultProject ?? ''} onChange={(event) => onDraftChange({ ...draft, defaultProject: event.target.value })} />
        </label>
        <div className="working-folder-actions">
          {recents.length > 0 && <Select ariaLabel="Recent folders" variant="field" value="" placeholder="Recent folders" onChange={(value) => chooseFolder(value)} options={recents.map((folder) => ({ value: folder, label: folder }))} />}
          <button type="button" className="secondary-button small" onClick={() => void browseFolder()}>Browse…</button>
        </div>
      </div>
    </EditGroup>}

    {show('permissions') && <EditGroup id="permissions" title="Permissions">
      <div className="blob-form">
        <div className="approval-choices" role="radiogroup" aria-label="Approval mode">
          {APPROVAL_CHOICES.map((choice) => <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={draft.approvalMode === choice.value}
            data-mode={choice.value}
            className={`approval-choice${draft.approvalMode === choice.value ? ' on' : ''}${choice.value === 'bypass' ? ' warning' : ''}`}
            onClick={() => onApproval(choice.value)}
          >
            <span className="approval-choice-icon" aria-hidden="true"><choice.Icon size={16} /></span>
            <span className="approval-choice-copy">
              <span className="approval-choice-name">{choice.name}</span>
              <span className="approval-choice-sentence">{choice.sentence}</span>
            </span>
          </button>)}
        </div>
        <div className="approval-default">
          {draft.approvalMode
            ? <button type="button" className="ghost-button small" onClick={() => onDraftChange({ ...draft, approvalMode: null })}>Use the team default</button>
            : <span className="blob-help">{approvalDescription(null)}</span>}
        </div>
        {autoApprovals && <div className="auto-approvals-summary">
          <button type="button" className="link-button" onClick={() => document.getElementById('bot-auto-approvals-list')?.scrollIntoView?.({ block: 'nearest' })}>Approved without asking recently: {autoApprovals.length} {autoApprovals.length === 1 ? 'action' : 'actions'}</button>
          <div id="bot-auto-approvals-list"><AutoApprovedList actions={autoApprovals} /></div>
        </div>}
      </div>
    </EditGroup>}

    {show('notifications') && <EditGroup id="notifications" title="Notifications">
      <div className="settings-row">
        <RowCopy label="Notify me" hint={NOTIFICATION_LEVEL_HELP[draft.notificationLevel ?? 'all']} />
        <span className="settings-row-control">
          <Select ariaLabel="Notify me" variant="muted" value={draft.notificationLevel ?? 'all'} onChange={(value) => onDraftChange({ ...draft, notificationLevel: value === 'input' || value === 'muted' ? value : 'all' })} options={[{ value: 'all', label: 'About everything' }, { value: 'input', label: 'Only when it needs me' }, { value: 'muted', label: 'Never' }]} />
        </span>
      </div>
    </EditGroup>}

    {show('details') && <section id="bot-section-details" className="settings-group blob-group" aria-label="Technical details">
      <div className="settings-group-head">
        <h3><button type="button" className="details-toggle" aria-expanded={detailsOpen} aria-controls="bot-details-content" onClick={() => setDetailsOpen(!detailsOpen)}>
          {detailsOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}Technical details
        </button></h3>
      </div>
      <div className="settings-card" id="bot-details-content" hidden={!detailsOpen}>
        <div className="settings-row"><span className="settings-row-copy"><strong>Concurrency</strong></span><span className="settings-value">{concurrencyText(capabilities, execution.maxConcurrency)}</span></div>
        <div className="blob-form" aria-label="Last applied snapshot">
          <span className="blob-field-label">Last applied settings</span>
          {snapshot ? <ul className="snapshot-outcomes">{snapshot.outcomes.map((outcome) => <li key={outcome.setting} data-outcome={outcome.label}><span>{outcome.setting === 'approvalMode' ? 'Approval mode' : outcome.setting === 'serviceTier' ? 'Speed' : labelize(outcome.setting)}</span><strong>{outcomeText(outcome)}</strong></li>)}</ul> : <p className="blob-help">{snapshotNote}</p>}
          {capabilities?.settings.customEnv && <p className="blob-help">{envNote(capabilities.settings.customEnv)}</p>}
          <p className="blob-help">Custom arguments are not accepted.</p>
        </div>
      </div>
    </section>}

    {show('memory') && agentId && <BotMemoryGroup agentId={agentId} enabled={memoryOn} sessions={sessions} onOpenMemory={onOpenMemory} />}

    {show('skills') && agentId && <BotSkillsGroup agentId={agentId} onOpenSkills={onOpenSkills} />}

    {onArchive && <section className="settings-group">
      <div className="settings-card">
        <div className="settings-row">
          <RowCopy label={`Archive ${noun}`} hint="It leaves the sidebar. Its conversations stay saved." />
          <span className="settings-row-control"><button type="button" className="secondary-button small danger-button" onClick={onArchive}>Archive {noun}</button></span>
        </div>
      </div>
    </section>}
    {bypassOpen && <BypassConfirmDialog blobName={draft.name} onCancel={() => setBypassOpen(false)} onConfirm={() => { setBypassOpen(false); onDraftChange({ ...draft, approvalMode: 'bypass' satisfies ApprovalMode }) }} />}
  </fieldset>
}

/**
 * The instructions field, its live counter, the one-time plain-language helper,
 * the preset chips and the on-device version history (FIX22 B3).
 */
function InstructionsSection({ draft, agentId, error, help, noun, onDraftChange }: {
  draft: AgentDraft
  agentId: string | null
  error?: string
  help: string
  noun: string
  onDraftChange: (draft: AgentDraft) => void
}) {
  const counts = instructionCounts(draft.instructions)
  const [pending, setPending] = useState<BotTemplate | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  const maxHeight = () => {
    const element = textareaRef.current
    const line = element ? Number.parseFloat(getComputedStyle(element).lineHeight) : Number.NaN
    return (Number.isFinite(line) && line > 0 ? line : 20) * 20
  }
  useAutosizeTextarea(textareaRef, draft.instructions, maxHeight)

  useEffect(() => {
    if (!historyOpen) return
    const close = (event: PointerEvent) => {
      if (historyRef.current && !historyRef.current.contains(event.target as Node)) setHistoryOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setHistoryOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', onKey) }
  }, [historyOpen])

  const versions = historyOpen && agentId ? instructionVersions(agentId) : []

  const applyPreset = (template: BotTemplate) => {
    if (!draft.instructions.trim()) { onDraftChange({ ...draft, instructions: template.instructions }); return }
    setPending(template)
  }
  const applyPending = (mode: 'replace' | 'append') => {
    const template = pending
    if (!template) return
    const next = mode === 'replace' ? template.instructions : `${draft.instructions.replace(/\s+$/, '')}\n\n${template.instructions}`
    setPending(null)
    onDraftChange({ ...draft, instructions: next })
  }
  const restore = (version: InstructionVersion) => {
    setHistoryOpen(false)
    onDraftChange({ ...draft, instructions: version.text })
  }

  return <div className="blob-form instructions-section" id="bot-instructions">
    <div className="instructions-head">
      <span className="blob-field-label blob-field-title">Instructions<HelpTip align="start" placement="bottom" text={<dl>
        <div><dt>Role</dt><dd>The label next to the name.</dd></div>
        <div><dt>Description</dt><dd>What teammates read to decide whom to ask.</dd></div>
        <div><dt>Instructions</dt><dd>The {noun}’s standing brief, read on every request.{help ? ` ${help}` : ''}</dd></div>
      </dl>} /></span>
      <span className="instructions-head-trail">
        <small id="blob-instructions-count" className="instructions-count">{thousands(counts.characters)} characters, about {thousands(counts.tokens)} tokens</small>
        {agentId && <div className="instructions-history" ref={historyRef}>
          <button type="button" className="ghost-button small" aria-expanded={historyOpen} aria-haspopup="dialog" onClick={() => setHistoryOpen((open) => !open)}>History</button>
          {historyOpen && <div className="menu-surface instructions-history-menu" role="dialog" aria-label="Instructions history">
            <p className="blob-help instructions-history-note">Saved versions are kept on this device.</p>
            {versions.length === 0
              ? <p className="blob-muted">No saved versions yet.</p>
              : <ul className="instructions-history-list">{versions.map((version, index) => <li key={`${version.at}:${index}`}>
                  <span className="instructions-history-time">{formatVersionTime(version.at)}</span>
                  <span className="instructions-history-preview">{firstLine(version.text)}</span>
                  <button type="button" className="ghost-button small" onClick={() => restore(version)}>Restore</button>
                </li>)}</ul>}
          </div>}
        </div>}
      </span>
    </div>
    <div className="instructions-presets" role="group" aria-label="Preset instructions">
      <span className="blob-field-label">Start from a preset</span>
      <div className="instructions-preset-row">
        {instructionPresets().map((template) => <button key={template.id} type="button" className="preset-chip" title={template.tagline} onClick={() => applyPreset(template)}>{template.name}</button>)}
      </div>
    </div>
    {pending && <div className="instructions-choice" role="group" aria-label={`Apply ${pending.name} instructions`}>
      <span className="instructions-choice-copy">Instructions already has text. Replace it or add the preset to the end?</span>
      <span className="instructions-choice-actions">
        <button type="button" className="secondary-button small" onClick={() => applyPending('replace')}>Replace</button>
        <button type="button" className="secondary-button small" onClick={() => applyPending('append')}>Add to the end</button>
        <button type="button" className="ghost-button small" onClick={() => setPending(null)}>Cancel</button>
      </span>
    </div>}
    <label className="blob-field">
      <textarea ref={textareaRef} className="instructions-textarea" aria-label="Instructions" rows={10} placeholder={`How should this ${noun} work? For example: keep answers short and run the tests before finishing.`} aria-invalid={!!error} aria-describedby={error ? 'blob-instructions-error' : undefined} value={draft.instructions} onChange={(event) => onDraftChange({ ...draft, instructions: event.target.value })} />
    </label>
    {error && <p className="blob-error" id="blob-instructions-error">{error}</p>}
  </div>
}

function formatVersionTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function firstLine(text: string) {
  const line = text.split('\n').map((part) => part.trim()).find((part) => part.length > 0) ?? '(empty)'
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

function providerLabel(provider: string) { return providerBrand(provider).name || 'this agent' }

function formatCatalogTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function EditGroup({ id, title, label, action, children }: { id?: string; title: string; label?: string; action?: ReactNode; children: ReactNode }) {
  return <section id={id ? `bot-section-${id}` : undefined} className="settings-group blob-group" aria-label={label ?? title}>
    <div className="settings-group-head"><h3>{title}</h3>{action}</div>
    <div className="settings-card">{children}</div>
  </section>
}

function CapabilityField({ label, state, setting, children }: { label: string; state: ReturnType<typeof capabilityState>; setting: CapabilitySetting | null; children: ReactNode }) {
  const reason = state === 'supported' ? '' : settingReason(setting, state)
  return <div className="settings-row" data-capability={state}>
    <RowCopy label={label} hint={reason || undefined} />
    <span className="settings-row-control">{children}</span>
  </div>
}

function concurrencyText(capabilities: RuntimeCapabilities | null, stored: number) {
  // FIX39 item 18: there is no per-bot cap any more. Only the global limit
  // ("Bots working at once") applies; the saved per-bot value is kept for the
  // record but no longer enforced.
  const global = capabilities?.globalConcurrency
  if (!global) return `Saved cap ${stored}, no longer enforced. Global limit not reported.`
  return `Up to ${global.limit} bot conversations at once · ${global.active} running`
}

function envNote(setting: CapabilitySetting) {
  const state = capabilityState(setting)
  if (state !== 'supported') return settingReason(setting, state)
  const keys = setting.allowedKeys ?? []
  if (!keys.length) return 'Custom environment keys were not reported.'
  return `Allowed environment keys: ${keys.join(', ')}. Evidence: ${evidencePlain(setting.evidence)}.`
}
