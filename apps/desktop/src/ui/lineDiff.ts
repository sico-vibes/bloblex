// A small line diff for the Manager's playbook: what a proposal or an older
// version changes, line by line. Longest common subsequence; playbooks are at
// most 16,000 characters, so the table stays small.

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  const rows = a.length + 1
  const cols = b.length + 1
  const table = new Uint32Array(rows * cols)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i += 1; j += 1 }
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) { out.push({ kind: 'del', text: a[i] }); i += 1 }
    else { out.push({ kind: 'add', text: b[j] }); j += 1 }
  }
  while (i < a.length) { out.push({ kind: 'del', text: a[i] }); i += 1 }
  while (j < b.length) { out.push({ kind: 'add', text: b[j] }); j += 1 }
  return out
}

/** Changed lines with a little context; long unchanged stretches fold to one marker. */
export function foldDiff(lines: readonly DiffLine[], context = 2): Array<DiffLine | { kind: 'fold'; count: number }> {
  const near = lines.map((line, index) => line.kind !== 'same' || lines.slice(Math.max(0, index - context), index + context + 1).some((other) => other.kind !== 'same'))
  const out: Array<DiffLine | { kind: 'fold'; count: number }> = []
  let folded = 0
  lines.forEach((line, index) => {
    if (near[index]) {
      if (folded) { out.push({ kind: 'fold', count: folded }); folded = 0 }
      out.push(line)
    } else folded += 1
  })
  if (folded) out.push({ kind: 'fold', count: folded })
  return out
}
