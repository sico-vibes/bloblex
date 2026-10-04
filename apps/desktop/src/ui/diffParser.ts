export type DiffLine = { kind: 'context' | 'added' | 'removed' | 'meta' | 'hunk'; text: string; oldNumber: number | null; newNumber: number | null }
export type ParsedDiff = { lines: DiffLine[]; additions: number; deletions: number; binary: boolean; empty: boolean }

export function parseUnifiedDiff(content: string): ParsedDiff {
  const lines: DiffLine[] = []
  let oldNumber: number | null = null
  let newNumber: number | null = null
  let additions = 0
  let deletions = 0
  let binary = false
  for (const text of content.split(/\r?\n/)) {
    if (binary) { lines.push({ kind: 'meta', text, oldNumber: null, newNumber: null }); continue }
    if (/^(Binary files .* differ|GIT binary patch)/.test(text)) { binary = true; lines.push({ kind: 'meta', text, oldNumber: null, newNumber: null }); continue }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      oldNumber = Number(hunk[1]); newNumber = Number(hunk[2])
      lines.push({ kind: 'hunk', text, oldNumber: null, newNumber: null }); continue
    }
    if (text.startsWith('\\ No newline at end of file')) { lines.push({ kind: 'meta', text, oldNumber: null, newNumber: null }); continue }
    if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff --') || text.startsWith('index ') || text.startsWith('new file mode') || text.startsWith('deleted file mode')) {
      lines.push({ kind: 'meta', text, oldNumber: null, newNumber: null }); continue
    }
    if (text.startsWith('+')) { lines.push({ kind: 'added', text, oldNumber: null, newNumber }); additions += 1; if (newNumber !== null) newNumber += 1; continue }
    if (text.startsWith('-')) { lines.push({ kind: 'removed', text, oldNumber, newNumber: null }); deletions += 1; if (oldNumber !== null) oldNumber += 1; continue }
    if (text.startsWith(' ')) { lines.push({ kind: 'context', text, oldNumber, newNumber }); if (oldNumber !== null) oldNumber += 1; if (newNumber !== null) newNumber += 1; continue }
    if (text) lines.push({ kind: 'meta', text, oldNumber: null, newNumber: null })
  }
  return { lines, additions, deletions, binary, empty: content.length === 0 }
}
