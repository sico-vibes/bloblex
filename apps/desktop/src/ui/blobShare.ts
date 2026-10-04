import type { Agent } from '../types'
import { agentColorHex } from './agentColor'
import { isOutfit, normalizeOutfit, type Outfit } from '../blob/outfit'

export const BLOB_SHARE_FORMAT = 'bloblex.blob.v1'
export const BLOB_SHARE_MAX_BYTES = 64 * 1024

export interface SharedBlob {
  format: typeof BLOB_SHARE_FORMAT
  name: string
  description: string
  colour: string
  instructions: string
  model: string | null
  thinking: string | null
  speed: string | null
  outfit: Outfit
  defaultApprovalMode?: 'ask' | 'auto'
  providerId?: string
}

export function serializeBlob(agent: Agent, providerId: string): string {
  const defaultApprovalMode = agent.approvalMode === 'ask' || agent.approvalMode === 'auto' ? agent.approvalMode : undefined
  const blob: SharedBlob = {
    format: BLOB_SHARE_FORMAT,
    name: agent.name,
    description: agent.description,
    colour: agentColorHex(agent.color),
    instructions: agent.instructions,
    model: boundedOptional(agent.model, 160),
    thinking: boundedOptional(agent.thinking, 80),
    speed: boundedOptional(agent.serviceTier, 80),
    outfit: normalizeOutfit(agent.outfit),
    ...(defaultApprovalMode ? { defaultApprovalMode } : {}),
    providerId,
  }
  return `${JSON.stringify(blob, null, 2)}\n`
}

export function parseSharedBlob(text: string): SharedBlob {
  if (new TextEncoder().encode(text).byteLength > BLOB_SHARE_MAX_BYTES) throw new Error('This blob file is too large.')
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('This blob file is not valid JSON.') }
  if (!isRecord(parsed)) throw new Error('This blob file must contain an object.')
  if (parsed.format !== BLOB_SHARE_FORMAT) throw new Error('This blob file uses an unsupported format version.')
  const name = requiredText(parsed.name, 60, 'name')
  const description = optionalText(parsed.description, 255, 'description')
  const colour = typeof parsed.colour === 'string' && /^#[0-9a-fA-F]{6}$/.test(parsed.colour) ? parsed.colour.toLowerCase() : null
  if (!colour) throw new Error('The blob colour must use #RRGGBB format.')
  const instructions = optionalText(parsed.instructions, 20_000, 'instructions')
  const model = nullableText(parsed.model, 160, 'model')
  const thinking = nullableText(parsed.thinking, 80, 'thinking')
  const speed = nullableText(parsed.speed, 80, 'speed')
  if (parsed.outfit !== undefined && !isOutfit(parsed.outfit)) throw new Error('Choose a valid outfit.')
  const outfit = normalizeOutfit(parsed.outfit)
  let providerId: string | undefined
  if (parsed.providerId !== undefined && parsed.providerId !== null) {
    providerId = optionalText(parsed.providerId, 100, 'provider').trim() || undefined
  }
  if (parsed.defaultApprovalMode !== undefined && parsed.defaultApprovalMode !== 'ask' && parsed.defaultApprovalMode !== 'auto') throw new Error('Only Ask or Auto approval can be imported.')
  return {
    format: BLOB_SHARE_FORMAT, name, description, colour, instructions, model, thinking, speed, outfit,
    ...(parsed.defaultApprovalMode === 'ask' || parsed.defaultApprovalMode === 'auto' ? { defaultApprovalMode: parsed.defaultApprovalMode } : {}),
    ...(providerId ? { providerId } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function requiredText(value: unknown, max: number, field: string) { if (typeof value !== 'string' || !value.trim() || scalarLength(value) > max || value.includes('\0')) throw new Error(`Enter a valid ${field} (up to ${max} characters).`); return value.trim() }
function optionalText(value: unknown, max: number, field: string) { if (typeof value !== 'string' || scalarLength(value) > max || value.includes('\0')) throw new Error(`The ${field} is too long or contains an invalid character.`); return value }
function nullableText(value: unknown, max: number, field: string): string | null { if (value === null) return null; return optionalText(value, max, field) }
function scalarLength(value: string) { return [...value].length }
function boundedOptional(value: unknown, max: number): string | null { return typeof value === 'string' && scalarLength(value) <= max ? value : null }
