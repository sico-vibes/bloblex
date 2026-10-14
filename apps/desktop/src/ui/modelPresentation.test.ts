import { describe, expect, it } from 'vitest'
import type { CatalogModel } from '../executionContract'
import { organizeModels, presentedModelName } from './modelPresentation'
import { formatModelSize, normalizeEngineChoice } from './dictation'

function model(id: string, displayName: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { id, displayName, supportedThinking: [], defaultThinking: null, serviceTiers: [], defaultServiceTier: null, variants: [], hostDependent: false, isDefault: false, group: null, availability: null, ...extra }
}

describe('presentedModelName', () => {
  it('reads like the Claude names for every provider', () => {
    expect(presentedModelName('claude', model('claude-sonnet-5-5', 'Sonnet'))).toBe('Sonnet 5.5')
    expect(presentedModelName('claude', model('claude-opus-5-5', 'Claude Opus 5.5'))).toBe('Opus 5.5')
    expect(presentedModelName('codex', model('gpt-6-luna', 'GPT-6-Luna'))).toBe('Luna 6')
    expect(presentedModelName('codex', model('gpt-6.1-sol', 'GPT-6.1-Sol'))).toBe('Sol 6.1')
    expect(presentedModelName('codex', model('gpt-5.5', 'GPT-5.5'))).toBe('GPT-5.5')
    expect(presentedModelName('opencode', model('opencode-go/deepseek-v4.1-flash', 'opencode-go/DeepSeek V4.1 Flash'))).toBe('DeepSeek V4.1 Flash')
    expect(presentedModelName('opencode', model('opencode/big-pickle', 'opencode/Big Pickle'))).toBe('Big Pickle')
  })
})

describe('organizeModels', () => {
  it('groups Claude by family, most capable first, newest release first', () => {
    const ordered = organizeModels('claude', [
      model('claude-haiku-5-5', 'Haiku'),
      model('claude-sonnet-5-5', 'Sonnet'),
      model('claude-opus-5-5', 'Opus'),
      model('claude-fable-5-1', 'Fable'),
      model('claude-opus-5', 'Opus'),
      model('claude-sonnet-5', 'Sonnet'),
      model('claude-fable-5', 'Fable'),
      model('claude-opus-4-8', 'Opus'),
    ])
    expect(ordered.map((item) => item.id)).toEqual(['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5'])
    expect(ordered.map((item) => item.group)).toEqual(['Fable', 'Fable', 'Opus', 'Opus', 'Opus', 'Sonnet', 'Sonnet', 'Haiku'])
  })
  it('leaves other providers in the catalog order with their own groups', () => {
    const input = [model('b', 'B', { group: 'OpenCode Go' }), model('a', 'A', { group: 'OpenCode Zen' })]
    expect(organizeModels('opencode', input)).toBe(input)
  })
})

describe('dictation engine and model size', () => {
  it('shows only two engines and reads the older cloud value as Cloud', () => {
    expect(normalizeEngineChoice('local')).toBe('local')
    expect(normalizeEngineChoice('automatic')).toBe('automatic')
    expect(normalizeEngineChoice('cloud')).toBe('automatic')
    expect(normalizeEngineChoice(undefined)).toBe('local')
  })
  it('formats a model size for the download prompt', () => {
    expect(formatModelSize(150 * 1024 * 1024)).toBe('150 MB')
    expect(formatModelSize(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB')
    expect(formatModelSize(null)).toBe('')
  })
})
