import { describe, expect, it, vi } from 'vitest'
vi.mock('../tauri', () => ({ rpc: vi.fn() }))
import type { Session } from '../types'
import { fileChanges, sessionTokenSplit } from './SessionRail'

const session = (extra: Partial<Session> = {}): Session => ({ id: 's1', runtimeId: 'rt', ...extra })

describe('session rail data', () => {
  it('sums this conversation\'s reported tokens once per report', () => {
    const usage = [
      { id: 'u1', sessionId: 's1', inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 },
      { id: 'u2', sessionId: 's1', inputTokens: 10, outputTokens: 5, reasoningTokens: 7 },
      { id: 'u3', sessionId: 'other', inputTokens: 999 },
    ]
    // u1 also arrived with the session itself: it must not count twice.
    const split = sessionTokenSplit(session({ usage: [usage[0]] }), usage)
    expect(split).toEqual({ input: 110, output: 25, cacheRead: 50, cacheWrite: 0, reasoning: 7 })
    expect(sessionTokenSplit(session(), [])).toBeNull()
    expect(sessionTokenSplit(null, usage)).toBeNull()
  })

  it('lists each changed file once with its latest change, newest first, and counts lines from the diff', () => {
    const files = [
      { id: 'f1', path: 'src/a.ts', change: 'modified', diff: '@@ -1,2 +1,2 @@\n-old\n+new\n same' },
      { id: 'f2', path: 'docs/new.md', change: 'added', addedLines: 12, removedLines: 0 },
      { id: 'f3', path: 'src/a.ts', change: 'modified', diff: '@@ -1 +1,2 @@\n+one\n+two\n same' },
    ]
    const changes = fileChanges(session({ files }))
    expect(changes.map((file) => [file.path, file.change, file.added, file.removed])).toEqual([
      ['src/a.ts', 'modified', 2, 0],
      ['docs/new.md', 'added', 12, 0],
    ])
    expect(fileChanges(null)).toEqual([])
  })
})
