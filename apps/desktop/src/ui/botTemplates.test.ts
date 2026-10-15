import { describe, expect, it } from 'vitest'
import { AGENT_SWATCHES } from './agentColor'
import { BLOB_SHAPES } from '../blob/look'
import { BOT_TEMPLATES, applyTemplate, instructionPresets } from './botTemplates'
import { createDraft, type AgentDraft } from './agentForm'

const NAMES = ['Code reviewer', 'Test writer', 'Documentation writer', 'Refactoring helper', 'Bug hunter', 'Researcher', 'Blank']

function lineCount(text: string) {
  return text.split('\n').filter((line) => line.trim().length > 0).length
}

function draft(partial: Partial<AgentDraft> = {}): AgentDraft {
  return {
    name: 'Claude', description: '', instructions: '', color: 'mint', look: null, runtimeId: 'rt-1', defaultProject: null,
    model: 'alpha', thinking: 'high', serviceTier: 'flex', approvalMode: 'auto', role: '', projectId: null, leader: false, ...partial,
  }
}

describe('bot templates', () => {
  it('offers each named starter exactly once', () => {
    expect(BOT_TEMPLATES.map((template) => template.name)).toEqual(NAMES)
    expect(new Set(BOT_TEMPLATES.map((template) => template.id)).size).toBe(BOT_TEMPLATES.length)
  })

  it('keeps role, description, brief, colour and shape inside the declared bounds', () => {
    const swatches = new Set<string>(AGENT_SWATCHES.map((swatch) => swatch.key))
    const shapes = new Set<string>(BLOB_SHAPES)
    for (const template of BOT_TEMPLATES) {
      expect(template.name.trim().length).toBeGreaterThan(0)
      expect(template.tagline.trim().length).toBeGreaterThan(0)
      expect(template.tagline).not.toContain('\n')
      expect(template.role.length).toBeLessThanOrEqual(40)
      expect(template.description.length).toBeLessThanOrEqual(255)
      expect(swatches.has(template.color), `${template.id} colour`).toBe(true)
      expect(shapes.has(template.shape), `${template.id} shape`).toBe(true)
      if (template.id === 'blank') {
        expect(template.instructions).toBe('')
        expect(template.role).toBe('')
      } else {
        expect(lineCount(template.instructions), `${template.id} brief`).toBeGreaterThanOrEqual(6)
        expect(lineCount(template.instructions), `${template.id} brief`).toBeLessThanOrEqual(12)
      }
    }
  })

  it('offers every non-blank preset as an instruction chip', () => {
    expect(instructionPresets().map((template) => template.id)).toEqual(BOT_TEMPLATES.filter((template) => template.id !== 'blank').map((template) => template.id))
  })

  it('applies name, text, role, colour and shape while keeping where and how it runs', () => {
    const template = BOT_TEMPLATES[0]
    const applied = applyTemplate(draft({ look: { shape: 'cat', seed: 'keep-me' } }), template)
    expect(applied.name).toBe(template.name)
    expect(applied.description).toBe(template.description)
    expect(applied.instructions).toBe(template.instructions)
    expect(applied.role).toBe(template.role)
    expect(applied.color).toBe(template.color)
    expect(applied.look).toEqual({ shape: template.shape, seed: 'keep-me' })
    expect(applied.runtimeId).toBe('rt-1')
    expect(applied.model).toBe('alpha')
    expect(applied.thinking).toBe('high')
    expect(applied.serviceTier).toBe('flex')
    expect(applied.approvalMode).toBe('auto')
  })

  it('seeds a look when the draft has none', () => {
    const applied = applyTemplate(draft({ look: null, runtimeId: 'runtime-x' }), BOT_TEMPLATES[1])
    expect(applied.look).toEqual({ shape: BOT_TEMPLATES[1].shape, seed: `blob-${BOT_TEMPLATES[1].id}` })
    expect(applied.runtimeId).toBe('runtime-x')
  })

  it('applies to a fresh draft without changing the chosen runtime', () => {
    const applied = applyTemplate(createDraft([{ id: 'rt-codex', provider: 'codex' }], 'rt-codex'), BOT_TEMPLATES[2])
    expect(applied.runtimeId).toBe('rt-codex')
    expect(applied.name).toBe(BOT_TEMPLATES[2].name)
  })
})
