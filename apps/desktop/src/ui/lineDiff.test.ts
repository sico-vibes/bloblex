import { describe, expect, it } from 'vitest'
import { foldDiff, lineDiff } from './lineDiff'

describe('playbook line diff', () => {
  it('marks added, removed and kept lines in order', () => {
    expect(lineDiff('a\nb\nc', 'a\nc\nd')).toEqual([
      { kind: 'same', text: 'a' }, { kind: 'del', text: 'b' }, { kind: 'same', text: 'c' }, { kind: 'add', text: 'd' },
    ])
    expect(lineDiff('same', 'same').every((line) => line.kind === 'same')).toBe(true)
    expect(lineDiff('', 'new')).toEqual([{ kind: 'del', text: '' }, { kind: 'add', text: 'new' }])
  })

  it('folds long unchanged stretches but keeps context around a change', () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')
    const after = before.replace('line 10', 'line ten')
    const rows = foldDiff(lineDiff(before, after))
    expect(rows[0]).toEqual({ kind: 'fold', count: 8 })
    expect(rows.filter((row) => row.kind === 'same')).toHaveLength(4)
    expect(rows.at(-1)).toEqual({ kind: 'fold', count: 7 })
  })
})
