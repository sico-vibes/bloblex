import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from './diffParser'

describe('parseUnifiedDiff', () => {
  it('tracks hunk line numbers and additions and deletions', () => {
    const parsed = parseUnifiedDiff('@@ -4,2 +4,3 @@\n same\n-old\n+new\n+more')
    expect(parsed).toMatchObject({ additions: 2, deletions: 1, binary: false, empty: false })
    expect(parsed.lines.filter((line) => line.kind !== 'hunk')).toMatchObject([
      { kind: 'context', oldNumber: 4, newNumber: 4 }, { kind: 'removed', oldNumber: 5 },
      { kind: 'added', newNumber: 5 }, { kind: 'added', newNumber: 6 },
    ])
  })

  it('handles no-newline markers, binary diffs and empty input', () => {
    expect(parseUnifiedDiff('@@ -1 +1 @@\n-old\n\\ No newline at end of file').lines.at(-1)?.kind).toBe('meta')
    expect(parseUnifiedDiff('Binary files a and b differ')).toMatchObject({ binary: true, additions: 0 })
    expect(parseUnifiedDiff('GIT binary patch\nliteral 4\n+not a text addition')).toMatchObject({ binary: true, additions: 0, deletions: 0 })
    expect(parseUnifiedDiff('')).toMatchObject({ empty: true, lines: [] })
  })
})
