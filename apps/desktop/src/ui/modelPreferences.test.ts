import { describe, expect, it } from 'vitest'
import type { CatalogModel } from '../executionContract'
import { concreteModelForSelection, preferredConcreteModel } from './modelPreferences'

const row = (id: string, releaseDate: string | null = null): CatalogModel => ({
  id, displayName:id, supportedThinking:[], defaultThinking:null, serviceTiers:[], defaultServiceTier:null,
  variants:[], hostDependent:true, isDefault:false, group:null, availability:'offered', releaseDate,
})

describe('concrete first model policy', () => {
  it('chooses the newest Sonnet by metadata/generation even when catalog order is stale or dates are absent', () => {
    const models = [row('claude-sonnet-5-5','2026-09-28'), row('claude-opus-5-5','2026-09-22'), row('claude-sonnet-6')]
    expect(preferredConcreteModel('claude', models)?.id).toBe('claude-sonnet-6')
  })

  it('chooses the newest Luna from an unsorted catalog and preserves a concrete saved selection', () => {
    const models = [row('gpt-6-luna'), row('gpt-6.2-luna'), row('gpt-6-sol')]
    expect(preferredConcreteModel('codex', models)?.id).toBe('gpt-6.2-luna')
    expect(concreteModelForSelection('codex', models, 'gpt-6-luna')?.id).toBe('gpt-6-luna')
  })

  it('uses only the confirmed Big Pickle id when it exists', () => {
    expect(preferredConcreteModel('opencode', [row('opencode/other')])).toBeNull()
    expect(preferredConcreteModel('opencode', [row('opencode/other'), row('opencode/big-pickle')])?.id).toBe('opencode/big-pickle')
  })
})
