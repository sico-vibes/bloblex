import { describe, expect, it } from 'vitest'
import type { CatalogModel } from '../executionContract'
import { filterModels, MODEL_SEARCH_THRESHOLD } from './SessionExecutionControls'
import { effortIconName } from './effortLabels'

const model = (id: string, displayName: string, group: string | null = null): CatalogModel => ({
  id, displayName, supportedThinking: [], defaultThinking: null, serviceTiers: [], defaultServiceTier: null,
  variants: [], hostDependent: false, isDefault: false, group, availability: null,
})

describe('model search', () => {
  const models = [
    model('opencode/gpt-6.1-sol', 'GPT-6.1 Sol', 'OpenCode Zen'),
    model('opencode/claude-haiku-5-5', 'Claude Haiku 5.5', 'OpenCode Zen'),
    model('opencode-go/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'OpenCode Go'),
  ]

  it('matches every word against the name, id and group, keeping catalog order', () => {
    expect(filterModels('opencode', models, '').map((item) => item.id)).toHaveLength(3)
    expect(filterModels('opencode', models, 'deep flash').map((item) => item.id)).toEqual(['opencode-go/deepseek-v4.1-flash'])
    expect(filterModels('opencode', models, 'zen').map((item) => item.displayName)).toEqual(['GPT-6.1 Sol', 'Claude Haiku 5.5'])
    expect(filterModels('opencode', models, 'nothing like this')).toEqual([])
  })

  it('only offers search on long lists', () => {
    expect(MODEL_SEARCH_THRESHOLD).toBe(8)
  })
})

describe('effort icons', () => {
  it('shows more bars for more reasoning', () => {
    expect(['low', 'medium', 'high', 'max', 'ultracode', null].map(effortIconName)).toEqual(['signal-low', 'signal-medium', 'signal-high', 'signal', 'flame', 'gauge'])
  })
})
