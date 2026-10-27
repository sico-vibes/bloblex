import { useSyncExternalStore } from 'react'

/**
 * Display rules for a step's command output in the work log. Only what the coding agent reported is shown (the
 * daemon keeps a bounded, merged `output` per tool call); nothing is read from a terminal. What a provider streams
 * is a fact about that provider's protocol, stated plainly when a command is running and nothing has arrived.
 */

let provider: string | null = null
const listeners = new Set<() => void>()
/** The window shows one conversation at a time; the shell says which coding agent runs it. */
export function setActivityProvider(next: string | null | undefined) {
  const value = next ? String(next).toLowerCase() : null
  if (value === provider) return
  provider = value
  listeners.forEach((listener) => listener())
}
export const useActivityProvider = (): string | null => useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => provider)

/** What a running command can show before it finishes, per provider protocol. */
export function outputStreaming(providerId: string | null): { streams: boolean | 'maybe'; note: string } {
  if (providerId === 'codex') return { streams: true, note: 'Codex reports command output as it runs.' }
  if (providerId === 'claude') return { streams: false, note: 'Claude Code reports a command’s output when the command finishes, so none is shown while it runs.' }
  if (providerId === 'opencode' || providerId === 'acp') return { streams: 'maybe', note: 'This coding agent shows output only if it reports progress for the command.' }
  return { streams: 'maybe', note: 'This coding agent has not reported any output for this command yet.' }
}

export const TAIL_LINES = 24
const TAIL_CHARS = 4000

/** The last lines of a (possibly long) output, and whether anything was left out. */
export function tailOf(value: string, lines = TAIL_LINES): { text: string; cut: boolean } {
  const all = value.replace(/\r\n?/g, '\n').split('\n')
  let text = all.slice(-lines).join('\n')
  let cut = all.length > lines
  if (text.length > TAIL_CHARS) { text = text.slice(-TAIL_CHARS); cut = true }
  return { text, cut }
}

/** The last non-empty line, for the step's one-line live readout. */
export function lastLine(value: string, max = 90): string {
  const line = value.replace(/\r\n?/g, '\n').split('\n').map((entry) => entry.trim()).filter(Boolean).pop() ?? ''
  return line.length > max ? `…${line.slice(-max)}` : line
}

const HIDDEN = '••••'
const PATTERNS: Array<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, `[private key hidden]`],
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, HIDDEN],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, HIDDEN],
  [/\bAKIA[0-9A-Z]{16}\b/g, HIDDEN],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, HIDDEN],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, HIDDEN],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, (_match, scheme) => `${scheme} ${HIDDEN}`],
  [/\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|secret|token|passwd|password|credential)s?)(["']?\s*[=:]\s*["']?)([^\s"',;&]{6,})/gi, (_match, key, glue) => `${key}${glue}${HIDDEN}`],
]

/** Hides high-confidence credentials in text shown on screen. Display only: stored data is unchanged. */
export function maskSecrets(value: string): { text: string; masked: boolean } {
  let masked = false
  let text = value
  for (const [pattern, replacement] of PATTERNS) {
    text = text.replace(pattern, (...args: unknown[]) => {
      masked = true
      return typeof replacement === 'string' ? replacement : replacement(...(args as [string, ...string[]]))
    })
  }
  return { text, masked }
}
