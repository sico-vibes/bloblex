// The important half of FIX18: the policy table in `remoteTiers.ts` must not
// drift from the daemon it governs. This test reads the daemon's dispatch,
// extracts every method string it answers (including `a | b` alternations and
// method prefix guards), and fails when the two disagree. It fails loudly if
// the dispatch cannot be parsed, rather than passing quietly.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { METHOD_RULES } from './remoteTiers'

const MAIN_RS = fileURLToPath(new URL('../../../../crates/bloblex-daemon/src/main.rs', import.meta.url))

interface ParsedDispatch {
  /** Every concrete method string named by a dispatch arm. */
  methods: string[]
  /** How many arm patterns were found; a sanity check on the extraction. */
  arms: number
  /** Method prefix guards such as `req.method.starts_with("mcp.")`. */
  guards: string[]
}

/**
 * The body of `async fn dispatch`, found by scanning braces while skipping
 * string literals and comments. Throws rather than returning a partial body.
 */
function dispatchBody(source: string): string {
  const signature = 'async fn dispatch('
  const at = source.indexOf(signature)
  if (at < 0) throw new Error(`parity: could not find \`${signature}\` in ${MAIN_RS}`)
  const open = source.indexOf('{', at)
  if (open < 0) throw new Error('parity: `async fn dispatch` has no body')
  let depth = 0
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  for (let i = open; i < source.length; i++) {
    const c = source[i]
    const next = source[i + 1]
    if (inLineComment) { if (c === '\n') inLineComment = false; continue }
    if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++ } continue }
    if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; continue }
    if (c === '/' && next === '/') { inLineComment = true; i++; continue }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue }
    if (c === '"') { inString = true; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return source.slice(open + 1, i) }
  }
  throw new Error('parity: could not find the end of the dispatch function (unbalanced braces)')
}

function parseDispatch(source: string): ParsedDispatch {
  const body = dispatchBody(source)
  const methods = new Set<string>()
  let arms = 0
  for (const line of body.split(/\r?\n/)) {
    // Dispatch arms sit at eight spaces of indentation; nested matches go deeper.
    const arm = /^ {8}("(?:[a-z0-9_.]+)"(?:\s*\|\s*"[a-z0-9_.]+")*)\s*=>/.exec(line)
    if (!arm) continue
    arms++
    for (const quoted of arm[1].matchAll(/"([a-z0-9_.]+)"/g)) methods.add(quoted[1])
  }
  // Method prefix guards: only the RPC method receivers (`m`, `method`,
  // `req.method`) count; `k.starts_with("exec_gate.")` is a setting key.
  const guards = new Set<string>()
  const guard = /(?:\breq\.method|\bmethod|\breq_method|\bm)\s*\.starts_with\(\s*"([a-z0-9_.]+)"\s*\)/g
  for (const match of source.matchAll(guard)) guards.add(match[1])
  if (arms < 10 || methods.size < 10) {
    throw new Error(`parity: parsed only ${arms} arms and ${methods.size} methods from the dispatch; the extraction is stale, not the table`)
  }
  return { methods: [...methods], arms, guards: [...guards] }
}

const dispatch = parseDispatch(readFileSync(MAIN_RS, 'utf8'))

const isFamily = (method: string) => method.endsWith('.*')
const familyPrefix = (method: string) => method.slice(0, -1)
const exactRules = new Set(METHOD_RULES.filter((rule) => !isFamily(rule.method)).map((rule) => rule.method))
const familyRules = METHOD_RULES.filter((rule) => isFamily(rule.method))
const dispatchMethods = new Set(dispatch.methods)
const covers = (method: string) => exactRules.has(method) || familyRules.some((rule) => method.startsWith(familyPrefix(rule.method)))

describe('remote tier parity with the daemon dispatch', () => {
  it('parsed the dispatch it expects', () => {
    expect(dispatch.arms).toBeGreaterThan(30)
    expect(dispatch.methods.length).toBeGreaterThan(70)
    expect(dispatchMethods.has('session.prompt')).toBe(true)
    expect(dispatchMethods.has('settings.set')).toBe(true)
    expect(dispatch.guards).toContain('mcp.')
  })

  it('gives every dispatched method a rule', () => {
    const uncovered = dispatch.methods.filter((method) => !covers(method))
    expect(uncovered, `dispatch methods with no METHOD_RULES entry: ${uncovered.join(', ')}`).toEqual([])
  })

  it('gives every method prefix guard a family rule', () => {
    const uncovered = dispatch.guards.filter((guard) => !familyRules.some((rule) => {
      const prefix = familyPrefix(rule.method)
      return guard.startsWith(prefix) || prefix.startsWith(guard)
    }))
    expect(uncovered, `prefix guards with no family rule in METHOD_RULES: ${uncovered.join(', ')}`).toEqual([])
  })

  it('has no stale rules', () => {
    const stale: string[] = []
    for (const method of exactRules) {
      if (!dispatchMethods.has(method)) stale.push(method)
    }
    for (const rule of familyRules) {
      const prefix = familyPrefix(rule.method)
      const used = dispatch.methods.some((method) => method.startsWith(prefix))
        || dispatch.guards.some((guard) => guard.startsWith(prefix) || prefix.startsWith(guard))
      if (!used) stale.push(rule.method)
    }
    expect(stale, `METHOD_RULES entries the dispatch no longer has: ${stale.join(', ')}`).toEqual([])
  })
})
