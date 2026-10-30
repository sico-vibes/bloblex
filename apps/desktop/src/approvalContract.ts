export type ApprovalMode = 'ask' | 'accept_edits' | 'auto' | 'bypass'

export interface AgentApprovalRef {
  approvalMode?: ApprovalMode | null
  effectiveApprovalMode?: ApprovalMode | null
}

export interface PolicyAgentRow {
  agentId: string
  mode: ApprovalMode | null
  effectiveMode: ApprovalMode
}

export interface PermissionsPolicy {
  defaultMode: ApprovalMode
  perAgent: PolicyAgentRow[]
}

export interface AutoResolvedAction {
  permissionId?: string
  sessionId?: string
  turnId?: string
  agentId?: string
  mode: 'auto' | 'accept_edits' | 'bypass'
  decision?: string
  category?: string
  summary: string
  sequence: number
}

export interface BypassNotice {
  sessionId?: string
  agentId?: string
  providerMode?: string
  sequence: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function parseApprovalMode(value: unknown): ApprovalMode | null {
  if (value === 'ask' || value === 'accept_edits' || value === 'auto' || value === 'bypass') return value
  return null
}

export function parseGlobalMode(value: unknown): ApprovalMode {
  return parseApprovalMode(value) ?? 'ask'
}

export function effectiveApprovalMode(agent: AgentApprovalRef | null | undefined): ApprovalMode | null {
  if (!agent) return null
  const effective = parseApprovalMode(agent.effectiveApprovalMode)
  if (effective) return effective
  return parseApprovalMode(agent.approvalMode)
}

export function visibleApprovalMode(draftMode: ApprovalMode | null | undefined, agent: AgentApprovalRef | null | undefined): ApprovalMode | null {
  if (parseApprovalMode(draftMode)) return draftMode as ApprovalMode
  return effectiveApprovalMode(agent)
}

export function approvalDescription(mode: ApprovalMode | null) {
  if (mode === 'accept_edits') return 'Bitbots approves reading and editing files inside the project and asks about everything else, including every command.'
  if (mode === 'auto') return 'Bitbots approves low-risk actions inside the project and asks about everything else. Budgets, cancel, and Pause all still apply.'
  if (mode === 'bypass') return 'Bitbots approves every action without asking, and may launch the provider so it does not ask either. Budgets, cancel, and Pause all still stop the work.'
  if (mode === 'ask') return 'Every permission request waits for you.'
  return 'Use the default from Settings › Agents.'
}

export function parsePermissionsPolicy(value: unknown): PermissionsPolicy {
  const root = isRecord(value) && isRecord(value.policy) ? value.policy : value
  const record = isRecord(root) ? root : {}
  const rows = Array.isArray(record.perAgent) ? record.perAgent : []
  const perAgent: PolicyAgentRow[] = []
  for (const row of rows) {
    if (!isRecord(row) || typeof row.agentId !== 'string' || !row.agentId) continue
    const mode = row.mode === null ? null : parseApprovalMode(row.mode)
    if (row.mode !== null && row.mode !== undefined && mode === null) continue
    const effective = parseApprovalMode(row.effectiveMode) ?? mode ?? 'ask'
    perAgent.push({ agentId: row.agentId, mode, effectiveMode: effective })
  }
  return { defaultMode: parseGlobalMode(record.defaultMode), perAgent }
}

function optionalId(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function parseAutoResolved(payload: unknown, sequence: number): AutoResolvedAction | null {
  if (!isRecord(payload)) return null
  if (payload.mode !== 'auto' && payload.mode !== 'bypass') return null
  if (typeof payload.summary !== 'string' || !payload.summary.trim()) return null
  return {
    ...(optionalId(payload.permissionId) ? { permissionId: payload.permissionId as string } : {}),
    ...(optionalId(payload.sessionId) ? { sessionId: payload.sessionId as string } : {}),
    ...(optionalId(payload.turnId) ? { turnId: payload.turnId as string } : {}),
    ...(optionalId(payload.agentId) ? { agentId: payload.agentId as string } : {}),
    mode: payload.mode,
    ...(typeof payload.decision === 'string' ? { decision: payload.decision } : {}),
    ...(typeof payload.category === 'string' ? { category: payload.category } : {}),
    summary: payload.summary,
    sequence,
  }
}

export function parseBypassActive(payload: unknown, sequence: number): BypassNotice | null {
  if (!isRecord(payload)) return null
  const sessionId = optionalId(payload.sessionId)
  const agentId = optionalId(payload.agentId)
  if (!sessionId && !agentId) return null
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(typeof payload.providerMode === 'string' ? { providerMode: payload.providerMode } : {}),
    sequence,
  }
}

export function newestFirst<T extends { sequence: number }>(items: readonly T[]) {
  return [...items].sort((a, b) => b.sequence - a.sequence || 0)
}
