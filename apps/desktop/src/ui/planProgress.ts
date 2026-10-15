// Plan checklists: pull the steps out of a proposed plan and mark the ones the
// assistant has since carried out. Pure and deterministic so the Director can
// render a checklist without guessing.

/**
 * A step counts as done when at least this share of its content words also
 * appear in one later assistant message (or its tool activity), measured as
 * `shared / stepTokens`.
 */
export const PLAN_STEP_MATCH_THRESHOLD = 0.6

/** Words too common to carry meaning for the overlap test. Kept small and fixed. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'over', 'your',
  'you', 'are', 'was', 'were', 'will', 'then', 'than', 'when', 'where', 'what',
  'which', 'while', 'each', 'their', 'there', 'have', 'has', 'had', 'not',
  'but', 'can', 'could', 'should', 'would', 'all', 'any', 'out', 'use', 'using',
  'add', 'added', 'run', 'runs', 'lets', 'let', 'its', 'set', 'new', 'also',
  'make', 'made', 'more', 'most', 'only', 'per', 'via', 'onto', 'off', 'one',
  'two', 'three', 'step', 'plan', 'first', 'next', 'last', 'well', 'just',
])

/** Content words of a piece of text: lowercased, punctuation stripped, stopwords dropped. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[`*_>#[\](){}]/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
}

/**
 * The actionable steps of a plan: numbered (`1.`, `2)`) or bulleted (`-`, `*`,
 * `+`, `•`) list lines, with the marker removed. Lines that are not list items
 * are ignored, so an introduction or a trailing paragraph is never a step.
 */
export function planSteps(planText: string): string[] {
  if (typeof planText !== 'string' || !planText) return []
  const steps: string[] = []
  for (const line of planText.split(/\r?\n/)) {
    const match = /^\s*(?:[-*+•]|\d+[.)])\s+(?<body>\S.*)$/.exec(line)
    if (!match?.groups?.body) continue
    const body = match.groups.body.trim()
    if (body) steps.push(body)
  }
  return steps
}

/**
 * Index-aligned progress for `steps`: `1` when the step is done, `0` when it is
 * not. A step is done when one of `assistantMessages` (later assistant replies,
 * including any tool activity folded into their text) shares at least
 * `PLAN_STEP_MATCH_THRESHOLD` of the step's content words. With no messages,
 * every step is `0`.
 */
export function planProgress(steps: readonly string[], assistantMessages: readonly string[]): number[] {
  const messageTokens = assistantMessages
    .filter((message): message is string => typeof message === 'string' && message.length > 0)
    .map((message) => new Set(tokenize(message)))
  return steps.map((step) => {
    const tokens = new Set(tokenize(step))
    if (tokens.size === 0) return 0
    const done = messageTokens.some((message) => {
      let shared = 0
      for (const token of tokens) if (message.has(token)) shared += 1
      return shared / tokens.size >= PLAN_STEP_MATCH_THRESHOLD
    })
    return done ? 1 : 0
  })
}
