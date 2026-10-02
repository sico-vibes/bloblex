import type { Agent, Runtime } from '../types'
import { colorForRpc, colorsEquivalent, parseCustomHex, swatchForColor } from './agentColor'
import { runtimeUsable, scalarLength } from './rosterSelectors'

export interface AgentDraft {
  name: string
  description: string
  instructions: string
  color: string
  runtimeId: string
  defaultProject: string | null
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

export function draftFromAgent(agent: Agent): AgentDraft {
  return {
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    color: agent.color,
    runtimeId: agent.runtimeId,
    defaultProject: agent.defaultProject,
  }
}

export function createDraft(runtimes: readonly Runtime[], selectedRuntimeId: string | null): AgentDraft {
  const selectedStillExists = !!selectedRuntimeId && runtimes.some((runtime) => runtime.id === selectedRuntimeId)
  const runtimeId = (selectedStillExists ? selectedRuntimeId : null)
    ?? runtimes.find((runtime) => runtimeUsable(runtime))?.id
    ?? runtimes[0]?.id
    ?? ''
  return { name: '', description: '', instructions: '', color: 'mint', runtimeId, defaultProject: null }
}

export function isAgentDirty(draft: AgentDraft, baseline: AgentDraft) {
  return draft.name !== baseline.name
    || draft.description !== baseline.description
    || draft.instructions !== baseline.instructions
    || !colorsEquivalent(draft.color, baseline.color)
    || draft.runtimeId !== baseline.runtimeId
    || normalizeProject(draft.defaultProject) !== normalizeProject(baseline.defaultProject)
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

export function createParams(draft: AgentDraft): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    runtimeId: draft.runtimeId,
    description: draft.description,
    instructions: draft.instructions,
    color: colorForRpc(draft.color),
    defaultProject: normalizeProject(draft.defaultProject),
  }
}

export function duplicateParams(source: Agent, name: string): Record<string, unknown> {
  return {
    name,
    runtimeId: source.runtimeId,
    description: source.description,
    instructions: source.instructions,
    color: source.color,
    model: source.model,
    thinking: source.thinking,
    serviceTier: source.serviceTier,
    customArgs: source.customArgs,
    customEnv: source.customEnv,
    maxConcurrency: source.maxConcurrency,
    defaultProject: source.defaultProject,
  }
}

export function updateParams(agentId: string, draft: AgentDraft, baseline: AgentDraft): Record<string, unknown> {
  const params: Record<string, unknown> = { agentId }
  if (draft.name !== baseline.name) params.name = draft.name.trim()
  if (draft.description !== baseline.description) params.description = draft.description
  if (draft.instructions !== baseline.instructions) params.instructions = draft.instructions
  if (!colorsEquivalent(draft.color, baseline.color)) params.color = colorForRpc(draft.color)
  if (draft.runtimeId !== baseline.runtimeId) params.runtimeId = draft.runtimeId
  if (normalizeProject(draft.defaultProject) !== normalizeProject(baseline.defaultProject)) params.defaultProject = normalizeProject(draft.defaultProject)
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
