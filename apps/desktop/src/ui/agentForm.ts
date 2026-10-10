import type { ApprovalMode } from '../approvalContract'
import type { ExecutionSendGate } from '../executionContract'
import type { Agent, Runtime } from '../types'
import { colorForRpc, colorsEquivalent, parseCustomHex, swatchForColor } from './agentColor'
import { runtimeUsable, scalarLength } from './rosterSelectors'
import { normalizeLook, sameLook, type BlobLook } from '../blob/look'
import { providerBrand } from './providerBrand'

export interface AgentDraft {
  name: string
  description: string
  instructions: string
  color: string
  /** Null keeps the default look (round, seeded by the blob id). */
  look: BlobLook | null
  runtimeId: string
  defaultProject: string | null
  model: string | null
  thinking: string | null
  serviceTier: string | null
  approvalMode: ApprovalMode | null
  /** Team placement, saved separately through agent.team.update. */
  role: string
  projectId: string | null
  leader: boolean
}

/** Team fields that differ from the baseline, as agent.team.update params. */
export function teamParams(draft: AgentDraft, baseline: AgentDraft | null): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  if (!baseline || draft.role.trim() !== baseline.role.trim()) params.role = draft.role.trim()
  if (!baseline || draft.projectId !== baseline.projectId) params.projectId = draft.projectId
  if (!baseline || draft.leader !== baseline.leader) params.leader = draft.leader
  return params
}

const CLOSED_GATE: ExecutionSendGate = { model: false, thinking: false, serviceTier: false }

function nullableText(value: string | null | undefined) {
  const trimmed = value?.trim() ?? ''
  return trimmed ? trimmed : null
}

export const CLIENT_MESSAGES = {
  nameEmpty: 'Enter a name.',
  nameLong: 'Use 60 characters or fewer for the name.',
  descriptionLong: 'Use 255 characters or fewer for the description.',
  instructionsNul: 'Instructions cannot include a null character.',
  color: 'Enter a colour as #RRGGBB, or choose a swatch.',
  runtime: 'Choose a runtime.',
  nameTaken: 'Another blob already uses this name.',
} as const

export type AgentField = 'name' | 'description' | 'instructions' | 'color' | 'runtimeId'
export type FieldErrors = Partial<Record<AgentField, string>>

export type DaemonFailureKind = 'agent.create' | 'agent.update' | 'agent.get' | 'agent.delete' | 'session.new' | 'agent.reorder'

export function normalizeProject(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed ? trimmed : null
}

/** Looks compare by value; two missing looks are the same default. */
export function lookEquals(a: BlobLook | null, b: BlobLook | null) {
  return a === null || b === null ? a === b : sameLook(a, b)
}

export function draftFromAgent(agent: Agent): AgentDraft {
  return {
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    color: agent.color,
    look: normalizeLook(agent.look),
    runtimeId: agent.runtimeId,
    defaultProject: agent.defaultProject,
    model: agent.model,
    thinking: agent.thinking,
    serviceTier: agent.serviceTier,
    approvalMode: agent.approvalMode ?? null,
    role: typeof agent.role === 'string' ? agent.role : '',
    projectId: typeof agent.projectId === 'string' ? agent.projectId : null,
    leader: agent.leader === true,
  }
}

export function createDraft(runtimes: readonly Runtime[], selectedRuntimeId: string | null): AgentDraft {
  const selectedStillExists = !!selectedRuntimeId && runtimes.some((runtime) => runtime.id === selectedRuntimeId)
  const runtimeId = (selectedStillExists ? selectedRuntimeId : null)
    ?? runtimes.find((runtime) => runtimeUsable(runtime))?.id
    ?? runtimes[0]?.id
    ?? ''
  return { name: '', description: '', instructions: '', color: 'mint', look: { shape: 'round', seed: `blob-${Math.floor(Math.random() * 0xffffffff).toString(36)}` }, runtimeId, defaultProject: null, model: null, thinking: null, serviceTier: null, approvalMode: null, role: '', projectId: null, leader: false }
}

export function starterDraft(runtime: Runtime): AgentDraft {
  return { ...createDraft([runtime], runtime.id), name: providerDisplayNameForStarter(runtime.provider), color: starterColorFor(runtime.provider), approvalMode: 'ask' }
}

function providerDisplayNameForStarter(provider: string) {
  return providerBrand(provider).name
}

function starterColorFor(provider: string) {
  const colors: Record<string, string> = { claude: 'coral', codex: 'blue', opencode: 'violet' }
  return colors[provider.toLowerCase()] ?? 'mint'
}

export function isAgentDirty(draft: AgentDraft, baseline: AgentDraft) {
  return Object.keys(teamParams(draft, baseline)).length > 0
    || draft.name !== baseline.name
    || draft.description !== baseline.description
    || draft.instructions !== baseline.instructions
    || !colorsEquivalent(draft.color, baseline.color)
    || !lookEquals(draft.look, baseline.look)
    || draft.runtimeId !== baseline.runtimeId
    || normalizeProject(draft.defaultProject) !== normalizeProject(baseline.defaultProject)
    || nullableText(draft.model) !== nullableText(baseline.model)
    || nullableText(draft.thinking) !== nullableText(baseline.thinking)
    || nullableText(draft.serviceTier) !== nullableText(baseline.serviceTier)
    || (draft.approvalMode ?? null) !== (baseline.approvalMode ?? null)
}

export function validateAgentDraft(draft: AgentDraft, otherActiveNames: readonly string[]): FieldErrors {
  const errors: FieldErrors = {}
  const name = draft.name.trim()
  if (!name) errors.name = CLIENT_MESSAGES.nameEmpty
  else if (scalarLength(name) > 60) errors.name = CLIENT_MESSAGES.nameLong
  else if (otherActiveNames.some((other) => other.trim().toLocaleLowerCase('en') === name.toLocaleLowerCase('en'))) errors.name = CLIENT_MESSAGES.nameTaken
  if (scalarLength(draft.description) > 255) errors.description = CLIENT_MESSAGES.descriptionLong
  if (draft.instructions.includes('\0')) errors.instructions = CLIENT_MESSAGES.instructionsNul
  if (!swatchForColor(draft.color) && !parseCustomHex(draft.color)) errors.color = CLIENT_MESSAGES.color
  if (!draft.runtimeId.trim()) errors.runtimeId = CLIENT_MESSAGES.runtime
  return errors
}

export function draftReady(draft: AgentDraft, otherActiveNames: readonly string[]) {
  return Object.keys(validateAgentDraft(draft, otherActiveNames)).length === 0
}

export function createParams(draft: AgentDraft, gate: ExecutionSendGate = CLOSED_GATE): Record<string, unknown> {
  const params: Record<string, unknown> = {
    name: draft.name.trim(),
    runtimeId: draft.runtimeId,
    description: draft.description,
    instructions: draft.instructions,
    color: colorForRpc(draft.color),
    ...(draft.look ? { look: draft.look } : {}),
    defaultProject: normalizeProject(draft.defaultProject),
  }
  if (gate.model && nullableText(draft.model)) params.model = nullableText(draft.model)
  if (gate.thinking && nullableText(draft.thinking)) params.thinking = nullableText(draft.thinking)
  if (gate.serviceTier && nullableText(draft.serviceTier)) params.serviceTier = nullableText(draft.serviceTier)
  if (draft.approvalMode) params.approvalMode = draft.approvalMode
  return params
}

export function duplicateParams(source: Agent, name: string): Record<string, unknown> {
  return {
    name,
    runtimeId: source.runtimeId,
    description: source.description,
    instructions: source.instructions,
    color: source.color,
    look: normalizeLook(source.look) ?? { shape: 'round', seed: source.id },
    model: source.model,
    thinking: source.thinking,
    serviceTier: source.serviceTier,
    customArgs: source.customArgs,
    customEnv: source.customEnv,
    maxConcurrency: source.maxConcurrency,
    defaultProject: source.defaultProject,
    ...(source.approvalMode ? { approvalMode: source.approvalMode } : {}),
  }
}

export function updateParams(agentId: string, draft: AgentDraft, baseline: AgentDraft, gate: ExecutionSendGate = CLOSED_GATE): Record<string, unknown> {
  const params: Record<string, unknown> = { agentId }
  if (draft.name !== baseline.name) params.name = draft.name.trim()
  if (draft.description !== baseline.description) params.description = draft.description
  if (draft.instructions !== baseline.instructions) params.instructions = draft.instructions
  if (!colorsEquivalent(draft.color, baseline.color)) params.color = colorForRpc(draft.color)
  if (!lookEquals(draft.look, baseline.look)) params.look = draft.look
  if (draft.runtimeId !== baseline.runtimeId) params.runtimeId = draft.runtimeId
  if (normalizeProject(draft.defaultProject) !== normalizeProject(baseline.defaultProject)) params.defaultProject = normalizeProject(draft.defaultProject)
  if (gate.model && nullableText(draft.model) !== nullableText(baseline.model)) params.model = nullableText(draft.model)
  if (gate.thinking && nullableText(draft.thinking) !== nullableText(baseline.thinking)) params.thinking = nullableText(draft.thinking)
  if (gate.serviceTier && nullableText(draft.serviceTier) !== nullableText(baseline.serviceTier)) params.serviceTier = nullableText(draft.serviceTier)
  if ((draft.approvalMode ?? null) !== (baseline.approvalMode ?? null)) params.approvalMode = draft.approvalMode
  return params
}

export function daemonCodeOf(reason: unknown) {
  const text = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
  const split = text.indexOf(': ')
  if (split <= 0) return ''
  return text.slice(0, split)
}

export function messageForDaemonCode(code: string, kind: DaemonFailureKind, options: { archived?: boolean; sentName?: boolean } = {}) {
  if (code === 'unauthorized') return 'Bloblex could not reach the local daemon. Reconnect and try again.'
  if (code === 'conflict') {
    if (kind === 'session.new') return 'This blob is archived, so a new session cannot be started.'
    if (kind === 'agent.update' && options.archived) return 'This blob is archived and cannot be edited.'
    if (kind === 'agent.create' || (kind === 'agent.update' && options.sentName)) return 'Another blob already uses this name.'
    return 'The local daemon request failed.'
  }
  if (code === 'not_found') {
    if (kind === 'agent.reorder') return 'That runtime is no longer available.'
    if (kind === 'agent.create') return 'That runtime is no longer available. Refresh and choose another.'
    if (kind === 'agent.get' || kind === 'agent.update' || kind === 'agent.delete' || kind === 'session.new') return 'That blob is no longer available. Refresh and try again.'
    return 'The local daemon request failed.'
  }
  if (code === 'invalid_argument') {
    if (kind === 'agent.reorder') return 'The roster order is out of date. Refresh and try again.'
    if (kind === 'session.new') return 'Choose a project folder that exists on this device.'
    if (kind === 'agent.create' || kind === 'agent.update') return 'Check the name, description, colour, and runtime, then try again.'
    return 'The local daemon request failed.'
  }
  if (code === 'internal' && (kind === 'agent.create' || kind === 'agent.update' || kind === 'agent.delete')) {
    return 'Bloblex could not save that change. Nothing was applied.'
  }
  return 'The local daemon request failed.'
}

export interface StoredExecution {
  model: string | null
  thinking: string | null
  serviceTier: string | null
  maxConcurrency: number
}

export function executionFromAgent(agent: Agent | null): StoredExecution {
  return {
    model: agent?.model ?? null,
    thinking: agent?.thinking ?? null,
    serviceTier: agent?.serviceTier ?? null,
    maxConcurrency: agent?.maxConcurrency ?? 1,
  }
}
