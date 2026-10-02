export type CapabilityState = 'supported' | 'disabled' | 'gated' | 'unknown'

export interface CapabilitySetting {
  supported: boolean
  enabled: boolean
  scope: string
  evidence: string
  reason?: string
  allowedKeys?: string[]
}

export interface AgentConcurrencyRow {
  agentId: string
  configuredMaxConcurrency: number | null
  effectiveMaxConcurrency: number
  active: number
}

export interface RuntimeCapabilities {
  runtimeId: string
  settings: {
    model: CapabilitySetting | null
    thinking: CapabilitySetting | null
    serviceTier: CapabilitySetting | null
    instructions: CapabilitySetting | null
    customEnv: CapabilitySetting | null
  }
  globalConcurrency: { limit: number; active: number } | null
  agentConcurrency: { configuredMaxConcurrency: number | null; effectiveMaxConcurrency: number; active: number } | null
  agentConcurrencies: AgentConcurrencyRow[]
  hostDependent: boolean
}

export interface ServiceTierOption {
  id: string
  name: string
}

export interface CatalogModel {
  id: string
  displayName: string
  providerId?: string
  supportedThinking: string[]
  defaultThinking: string | null
  serviceTiers: ServiceTierOption[]
  defaultServiceTier: string | null
  variants: string[]
  hostDependent: boolean
}

export interface ModelCatalog {
  runtimeId: string
  provider: string
  models: CatalogModel[]
  fetchedAt: string | null
  expiresAt: string | null
  fallback: boolean
  source: string | null
}

export type OutcomeLabel = 'Applied' | 'Not applied' | 'Unsupported' | 'Unknown'

export interface SettingOutcomeView {
  setting: 'model' | 'thinking' | 'serviceTier' | 'instructions' | 'approvalMode'
  label: OutcomeLabel
  evidence: string
}

export interface ExecSnapshotView {
  id: string
  sessionId: string
  status: string
  outcomes: SettingOutcomeView[]
  appliedModelId: string | null
}

export interface RpcFailure {
  code: string
  message: string
}

export interface ExecutionSendGate {
  model: boolean
  thinking: boolean
  serviceTier: boolean
}

const SETTING_KEYS = ['model', 'thinking', 'serviceTier', 'instructions', 'customEnv'] as const
const OUTCOME_KEYS = ['model', 'thinking', 'serviceTier', 'instructions'] as const

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function rpcFailure(reason: unknown): RpcFailure {
  const text = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
  const split = text.indexOf(': ')
  if (split > 0) return { code: text.slice(0, split), message: text.slice(split + 2) }
  return { code: '', message: text || 'The local daemon request failed.' }
}

export function isProviderUnavailable(failure: RpcFailure) {
  return failure.code === 'provider_unavailable'
}

export function capabilityState(setting: CapabilitySetting | null): CapabilityState {
  if (!setting) return 'unknown'
  if (!setting.supported) return 'disabled'
  if (!setting.enabled) return 'gated'
  return 'supported'
}

export function settingReason(setting: CapabilitySetting | null, state: CapabilityState) {
  if (setting?.reason?.trim()) return setting.reason.trim()
  if (state === 'gated') return 'This setting is off until its execution check passes.'
  if (state === 'disabled') return 'This runtime does not support this setting.'
  if (state === 'unknown') return 'Bloblex has not reported whether this setting is available.'
  return ''
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function parseSetting(value: unknown): CapabilitySetting | null {
  if (!isRecord(value)) return null
  if (typeof value.supported !== 'boolean' || typeof value.enabled !== 'boolean') return null
  const allowed = Array.isArray(value.allowedKeys)
    ? value.allowedKeys.filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
    : undefined
  return {
    supported: value.supported,
    enabled: value.enabled,
    scope: typeof value.scope === 'string' ? value.scope : '',
    evidence: typeof value.evidence === 'string' ? value.evidence : '',
    ...(typeof value.reason === 'string' && value.reason.trim() ? { reason: value.reason } : {}),
    ...(allowed ? { allowedKeys: allowed } : {}),
  }
}

export function parseCapabilities(value: unknown): RuntimeCapabilities | null {
  const root = isRecord(value) && isRecord(value.capabilities) ? value.capabilities : value
  if (!isRecord(root) || typeof root.runtimeId !== 'string' || !isRecord(root.settings)) return null
  const settings = {} as RuntimeCapabilities['settings']
  for (const key of SETTING_KEYS) settings[key] = parseSetting(root.settings[key])
  if (SETTING_KEYS.every((key) => settings[key] === null)) return null
  const global = isRecord(root.globalConcurrency) && typeof root.globalConcurrency.limit === 'number' && typeof root.globalConcurrency.active === 'number'
    ? { limit: root.globalConcurrency.limit, active: root.globalConcurrency.active }
    : null
  let agentConcurrency: RuntimeCapabilities['agentConcurrency'] = null
  if (isRecord(root.agentConcurrency) && typeof root.agentConcurrency.effectiveMaxConcurrency === 'number' && typeof root.agentConcurrency.active === 'number') {
    agentConcurrency = {
      configuredMaxConcurrency: typeof root.agentConcurrency.configuredMaxConcurrency === 'number' ? root.agentConcurrency.configuredMaxConcurrency : null,
      effectiveMaxConcurrency: root.agentConcurrency.effectiveMaxConcurrency,
      active: root.agentConcurrency.active,
    }
  }
  const agentConcurrencies = Array.isArray(root.agentConcurrencies)
    ? root.agentConcurrencies.map(parseAgentConcurrencyRow).filter((row): row is AgentConcurrencyRow => !!row)
    : []
  return {
    runtimeId: root.runtimeId,
    settings,
    globalConcurrency: global,
    agentConcurrency,
    agentConcurrencies,
    hostDependent: root.hostDependent === true,
  }
}

function parseAgentConcurrencyRow(value: unknown): AgentConcurrencyRow | null {
  if (!isRecord(value) || typeof value.agentId !== 'string' || !value.agentId.trim()) return null
  if (typeof value.effectiveMaxConcurrency !== 'number' || typeof value.active !== 'number') return null
  return {
    agentId: value.agentId,
    configuredMaxConcurrency: typeof value.configuredMaxConcurrency === 'number' ? value.configuredMaxConcurrency : null,
    effectiveMaxConcurrency: value.effectiveMaxConcurrency,
    active: value.active,
  }
}

function parseTier(value: unknown): ServiceTierOption | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) return null
  const name = typeof value.name === 'string' && value.name.trim() ? value.name : value.id
  return { id: value.id, name }
}

function parseModel(value: unknown): CatalogModel | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) return null
  const thinking = Array.isArray(value.supportedThinking) ? value.supportedThinking.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
  const tiers = Array.isArray(value.serviceTiers) ? value.serviceTiers.map(parseTier).filter((tier): tier is ServiceTierOption => !!tier) : []
  const variants = Array.isArray(value.variants) ? value.variants.filter((item): item is string => typeof item === 'string') : []
  return {
    id: value.id,
    displayName: typeof value.displayName === 'string' && value.displayName.trim() ? value.displayName : value.id,
    ...(typeof value.providerId === 'string' ? { providerId: value.providerId } : {}),
    supportedThinking: thinking,
    defaultThinking: optionalString(value.defaultThinking),
    serviceTiers: tiers,
    defaultServiceTier: optionalString(value.defaultServiceTier),
    variants,
    hostDependent: value.hostDependent === true,
  }
}

export function parseModelCatalog(value: unknown): ModelCatalog | null {
  const root = isRecord(value) && isRecord(value.catalog) ? value.catalog : value
  if (!isRecord(root) || typeof root.runtimeId !== 'string' || !Array.isArray(root.models)) return null
  return {
    runtimeId: root.runtimeId,
    provider: typeof root.provider === 'string' ? root.provider : '',
    models: root.models.map(parseModel).filter((model): model is CatalogModel => !!model),
    fetchedAt: optionalString(root.fetchedAt),
    expiresAt: optionalString(root.expiresAt),
    fallback: root.fallback === true,
    source: optionalString(root.source),
  }
}

export function evidencePlain(kind: string) {
  switch (kind) {
    case 'none': return 'No evidence'
    case 'request_shape': return 'Request shape'
    case 'provider_echo': return 'Provider echo'
    case 'usage_effect': return 'Usage effect'
    case 'successful_turn': return 'Successful turn'
    default: return 'Unknown'
  }
}

export function instructionNote(provider: string, setting: CapabilitySetting | null) {
  const state = capabilityState(setting)
  if (state === 'unknown') return 'Bloblex has not reported whether instructions are sent for this runtime.'
  if (state === 'disabled') return settingReason(setting, state)
  if (state === 'gated') return settingReason(setting, state)
  const scope = (setting?.scope ?? '').toLowerCase()
  const codex = provider.toLowerCase().includes('codex')
  let timing = 'Saved with this blob.'
  if (codex) timing = 'Applies to new conversations.'
  else if (scope === 'thread' || scope === 'launch' || scope === 'spawn' || scope === 'resume' || scope === 'process') timing = 'Applies when the next conversation starts.'
  else if (scope === 'turn') timing = 'Applies on the next turn.'
  const evidence = evidencePlain(setting?.evidence ?? '')
  if (!setting?.evidence || setting.evidence === 'none' || setting.evidence === 'request_shape') {
    return `${timing} Bloblex has not confirmed that the provider applies them (${evidence}).`
  }
  return `${timing} Recorded evidence: ${evidence}.`
}

export function allowsCustomModelId(provider: string) {
  return provider.toLowerCase().includes('claude')
}

export function catalogModel(catalog: ModelCatalog | null, modelId: string | null) {
  if (!catalog || !modelId) return null
  return catalog.models.find((model) => model.id === modelId) ?? null
}

function listedOrNull(value: string | null, allowed: readonly string[]) {
  return value && allowed.includes(value) ? value : null
}

export function selectionAfterModelChange(modelId: string | null, catalog: ModelCatalog | null, custom: boolean) {
  const row = custom ? null : catalogModel(catalog, modelId)
  if (!row) return { model: modelId, thinking: null, serviceTier: null }
  const thinking = listedOrNull(row.defaultThinking, row.supportedThinking)
  const serviceTier = listedOrNull(row.defaultServiceTier, row.serviceTiers.map((tier) => tier.id))
  return { model: modelId, thinking, serviceTier }
}

export function sendGateFor(capabilities: RuntimeCapabilities | null, custom: boolean): ExecutionSendGate {
  return {
    model: capabilityState(capabilities?.settings.model ?? null) === 'supported',
    thinking: capabilityState(capabilities?.settings.thinking ?? null) === 'supported' && !custom,
    serviceTier: capabilityState(capabilities?.settings.serviceTier ?? null) === 'supported' && !custom,
  }
}

export function showThinkingControl(capabilities: RuntimeCapabilities | null, model: CatalogModel | null, custom: boolean) {
  const state = capabilityState(capabilities?.settings.thinking ?? null)
  if (state === 'disabled' || state === 'gated' || state === 'unknown') return false
  if (custom || !model) return false
  return model.supportedThinking.length > 0
}

export function showTierControl(capabilities: RuntimeCapabilities | null, model: CatalogModel | null, custom: boolean) {
  if (custom || !model || model.serviceTiers.length === 0) return false
  const state = capabilityState(capabilities?.settings.serviceTier ?? null)
  return state === 'supported' || state === 'gated' || state === 'disabled'
}

function outcomeReason(entry: unknown, evidenceEntry: unknown) {
  if (isRecord(entry) && typeof entry.reason === 'string' && entry.reason.trim()) return entry.reason
  if (isRecord(evidenceEntry) && typeof evidenceEntry.reason === 'string') return evidenceEntry.reason
  return ''
}

function outcomeFromEntry(entry: unknown, evidenceEntry: unknown): { label: OutcomeLabel; evidence: string } {
  const evidenceKind = evidenceKindOf(entry, evidenceEntry)
  const evidence = evidencePlain(evidenceKind)
  const reason = outcomeReason(entry, evidenceEntry)
  if (/unsupported|unavailable|execution_gate/i.test(reason)) return { label: 'Unsupported', evidence }
  if (!isRecord(entry)) {
    if (entry === true) return { label: 'Applied', evidence }
    if (entry === false) return { label: 'Not applied', evidence }
    return { label: 'Unknown', evidence }
  }
  if (entry.applied === true) return { label: 'Applied', evidence }
  if (entry.applied === false) return { label: 'Not applied', evidence }
  return { label: 'Unknown', evidence }
}

function evidenceKindOf(entry: unknown, evidenceEntry: unknown) {
  if (isRecord(evidenceEntry)) {
    if (typeof evidenceEntry.kind === 'string') return evidenceEntry.kind
    if (typeof evidenceEntry.evidenceKind === 'string') return evidenceEntry.evidenceKind
  }
  if (typeof evidenceEntry === 'string') return evidenceEntry
  if (isRecord(entry)) {
    if (typeof entry.evidenceKind === 'string') return entry.evidenceKind
    if (typeof entry.kind === 'string') return entry.kind
  }
  return ''
}

export function parseExecSnapshot(value: unknown): ExecSnapshotView | null {
  if (value === null || value === undefined) return null
  const root = isRecord(value) && isRecord(value.snapshot) ? value.snapshot : value
  if (!isRecord(root) || typeof root.id !== 'string') return null
  const applied = isRecord(root.applied) ? root.applied : {}
  const evidence = isRecord(root.evidence) ? root.evidence : {}
  const outcomes: SettingOutcomeView[] = OUTCOME_KEYS.map((setting) => {
    const view = outcomeFromEntry(applied[setting], evidence[setting])
    return { setting, label: view.label, evidence: view.evidence }
  })
  if (applied.approvalMode !== undefined || evidence.approvalMode !== undefined) {
    const approval = outcomeFromEntry(applied.approvalMode, evidence.approvalMode)
    outcomes.push({ setting: 'approvalMode', label: approval.label, evidence: approval.evidence })
  }
  const modelOutcome = outcomes.find((item) => item.setting === 'model')
  const requested = isRecord(root.requested) ? root.requested : {}
  const appliedModel = modelIdFrom(applied.model)
  const requestedModel = typeof requested.model === 'string' ? requested.model : null
  const appliedModelId = modelOutcome?.label === 'Applied' ? (appliedModel ?? requestedModel) : null
  return {
    id: root.id,
    sessionId: typeof root.sessionId === 'string' ? root.sessionId : '',
    status: typeof root.status === 'string' ? root.status : 'unknown',
    outcomes,
    appliedModelId: appliedModelId && appliedModelId.trim() ? appliedModelId : null,
  }
}

function modelIdFrom(entry: unknown) {
  if (typeof entry === 'string' && entry.trim()) return entry
  if (!isRecord(entry)) return null
  if (typeof entry.value === 'string' && entry.value.trim()) return entry.value
  if (typeof entry.id === 'string' && entry.id.trim()) return entry.id
  return null
}

export function outcomeText(outcome: SettingOutcomeView) {
  return `${outcome.label} · ${outcome.evidence}`
}
