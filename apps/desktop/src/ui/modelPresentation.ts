import type { CatalogModel } from '../executionContract'
import { modelDisplayName } from './modelDisplayName'

/**
 * How a catalog model reads in the picker. The provider shows as its icon
 * (the pill draws it, a divider follows), so the text is only the model:
 *  - Claude   "Claude Sonnet 5.5"       -> "Sonnet 5.5"
 *  - Codex    "GPT-6-Luna"              -> "Luna 6"
 *  - OpenCode "opencode-go/DeepSeek V4" -> "DeepSeek V4"
 * Anything that does not match a known shape is returned as the catalog's own
 * name with only the provider prefix removed; the saved model id is never
 * touched.
 */
export function presentedModelName(provider: string, model: { id: string; displayName: string }): string {
  const named = modelDisplayName(model).trim()
  const kind = provider.toLowerCase()
  if (kind === 'codex') {
    const gpt = /^(?:gpt-)(\d+(?:\.\d+)?)-([a-z][a-z]+)$/i.exec(named)
    if (gpt) return `${capital(gpt[2]!)} ${gpt[1]}`
    return named
  }
  if (kind === 'opencode') return named.replace(/^[a-z0-9_.-]+\/(?=\S)/i, '')
  return named.replace(/^claude\s+(?=\S)/i, '')
}

function capital(word: string) { return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() }

const CLAUDE_FAMILY_ORDER = ['fable', 'opus', 'sonnet', 'haiku'] as const
type ClaudeFamily = typeof CLAUDE_FAMILY_ORDER[number]

function claudeFamilyAndVersion(model: { id: string; displayName: string }): { family: ClaudeFamily; version: number[] } | null {
  const id = (model.id.split('/').at(-1) ?? model.id).toLowerCase()
  const fromId = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id)
  if (fromId) return { family: fromId[1] as ClaudeFamily, version: [Number(fromId[2]), fromId[3] === undefined ? 0 : Number(fromId[3])] }
  const fromName = /\b(fable|opus|sonnet|haiku)\b\s*(\d+(?:\.\d+)?)?/i.exec(model.displayName)
  if (fromName) {
    const parts = (fromName[2] ?? '').split('.').filter(Boolean).map(Number)
    return { family: fromName[1]!.toLowerCase() as ClaudeFamily, version: [parts[0] ?? 0, parts[1] ?? 0] }
  }
  return null
}

function compareVersionsDescending(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

/**
 * Claude models grouped by family, most capable family first (Fable, Opus,
 * Sonnet, Haiku) and newest release first inside each. A model whose family
 * cannot be read keeps the catalog's order, after the known families. Other
 * providers keep the catalog's own grouping and order.
 */
export function organizeModels(provider: string, models: CatalogModel[]): CatalogModel[] {
  if (provider.toLowerCase() !== 'claude') return models
  const parsed = models.map((model, index) => ({ model, index, info: claudeFamilyAndVersion(model) }))
  const rank = (family: ClaudeFamily | undefined) => family ? CLAUDE_FAMILY_ORDER.indexOf(family) : CLAUDE_FAMILY_ORDER.length
  parsed.sort((a, b) => {
    const byFamily = rank(a.info?.family) - rank(b.info?.family)
    if (byFamily) return byFamily
    if (a.info && b.info) {
      const byVersion = compareVersionsDescending(a.info.version, b.info.version)
      if (byVersion) return byVersion
    }
    return a.index - b.index
  })
  return parsed.map(({ model, info }) => ({
    ...model,
    group: info ? capital(info.family) : 'Other',
  }))
}
