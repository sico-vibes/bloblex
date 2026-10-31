export type DiffLine = { kind: 'context' | 'added' | 'removed' | 'meta' | 'hunk'; text: string; oldNumber: number | null; newNumber: number | null }
export type ParsedDiff = { lines: DiffLine[]; additions: number; deletions: number; binary: boolean; empty: boolean }

export type SideRow = { kind: 'hunk' | 'meta'; text: string } | { kind: 'pair'; left: DiffLine | null; right: DiffLine | null }

/** Rows for the side-by-side view: a removal and the addition that follows it share a row, in order. */
export function sideBySideRows(lines: readonly DiffLine[]): SideRow[] {
  const rows: SideRow[] = []
  let removed: DiffLine[] = []
  let added: DiffLine[] = []
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index += 1) rows.push({ kind: 'pair', left: removed[index] ?? null, right: added[index] ?? null })
    removed = []
    added = []
  }
  for (const line of lines) {
    if (line.kind === 'removed') {
      // A removal after an addition starts a new change.
      if (added.length) flush()
      removed.push(line)
    } else if (line.kind === 'added') added.push(line)
    else {
      flush()
      if (line.kind === 'context') rows.push({ kind: 'pair', left: line, right: line })
      else rows.push({ kind: line.kind, text: line.text })
    }
  }
  flush()
  return rows
}

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
