import { describe, expect, it } from 'vitest'
import { parseSharedBlob, serializeBlob } from './blobShare'

const base = { format: 'bloblex.blob.v1', name: 'Helper', description: '', colour: '#AABBCC', instructions: '', model: null, thinking: null, speed: null, look: { shape: 'cloud', seed: 'helper' }, providerId: 'codex' }

describe('blob share format', () => {
  it('ignores unknown fields and accepts only safe approval modes', () => {
    expect(parseSharedBlob(JSON.stringify({ ...base, extra: 'ignored', defaultApprovalMode: 'ask' }))).toMatchObject({ name: 'Helper', defaultApprovalMode: 'ask' })
    expect(() => parseSharedBlob(JSON.stringify({ ...base, defaultApprovalMode: 'bypass' }))).toThrow(/Only Ask or Auto/)
    expect(() => parseSharedBlob(JSON.stringify({ ...base, defaultApprovalMode: 'bypass', instructions: 'do not ask' }))).toThrow()
  })

  it('accepts a missing provider so the import flow can ask for an agent', () => {
    const { providerId: _providerId, ...withoutProvider } = base
    expect(parseSharedBlob(JSON.stringify(withoutProvider)).providerId).toBeUndefined()
  })

  it('round trips looks and gives older files a round look', () => {
    const agent = { id: 'agent-1', name: 'Helper', description: '', instructions: '', color: '#aabbcc', look: { shape: 'sun', seed: 'x', traits: { 'sun.n': 0.4 } }, model: null, thinking: null, serviceTier: null } as never
    const value = JSON.parse(serializeBlob(agent, 'codex'))
    expect(value.look).toEqual({ shape: 'sun', seed: 'x', traits: { 'sun.n': 0.4 } })
    expect(parseSharedBlob(JSON.stringify(value)).look).toEqual(value.look)
    const plain = JSON.parse(serializeBlob({ ...(agent as object), look: null } as never, 'codex'))
    expect(plain.look).toEqual({ shape: 'round', seed: 'agent-1' })
    const { look: _look, ...older } = base
    expect(parseSharedBlob(JSON.stringify(older)).look).toEqual({ shape: 'round', seed: 'Helper' })
    expect(() => parseSharedBlob(JSON.stringify({ ...base, look: { shape: 'star' } }))).toThrow(/look is not valid/)
  })

  it('rejects wrong versions, malformed colours, and oversized content', () => {
    expect(() => parseSharedBlob(JSON.stringify({ ...base, format: 'bloblex.blob.v2' }))).toThrow(/unsupported format version/)
    expect(() => parseSharedBlob(JSON.stringify({ ...base, colour: 'red' }))).toThrow(/#RRGGBB/)
    expect(() => parseSharedBlob(' '.repeat(70_000))).toThrow(/too large/)
    expect(() => parseSharedBlob(JSON.stringify({ ...base, name: 'x'.repeat(61) }))).toThrow(/name/)
    const malicious = `${JSON.stringify(base).slice(0, -1)},"__proto__":{"polluted":true}}`
    expect(parseSharedBlob(malicious).name).toBe('Helper')
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('never serializes bypass approval', () => {
    const agent = { name: 'A', description: '', instructions: '', color: '#abcdef', model: null, thinking: null, serviceTier: null, approvalMode: 'bypass' } as never
    const value = JSON.parse(serializeBlob(agent, 'codex'))
    expect(value.defaultApprovalMode).toBeUndefined()
    expect(value.format).toBe('bloblex.blob.v1')
  })
})
