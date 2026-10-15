// The last few saved instruction texts per bot (FIX22 B3). Kept on this device
// only, in localStorage: a mistaken edit can be restored without the daemon
// knowing. Every storage access is guarded, so a blocked Storage API only
// costs the history, never the page.

export interface InstructionVersion {
  /** ISO timestamp of the save. */
  at: string
  text: string
}

/** How many saved versions are kept per bot. */
export const INSTRUCTION_HISTORY_LIMIT = 5
/** Each saved text is capped so one giant brief cannot fill localStorage. */
export const INSTRUCTION_TEXT_LIMIT = 20_000

const KEY_PREFIX = 'bitbots.instructionHistory.'
const AGENT_ID = /^[A-Za-z0-9._:-]{1,128}$/

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

function instructionsKey(agentId: string) { return `${KEY_PREFIX}${agentId}` }

function isVersion(value: unknown): value is InstructionVersion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.at === 'string' && typeof record.text === 'string'
}

/** Saved versions for a bot, newest first. Unknown or malformed entries are dropped. */
export function instructionVersions(agentId: string): InstructionVersion[] {
  if (!agentId || !AGENT_ID.test(agentId)) return []
  const store = storage()
  if (!store) return []
  try {
    const raw = store.getItem(instructionsKey(agentId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(isVersion)
      .map((version) => ({ at: version.at, text: version.text.slice(0, INSTRUCTION_TEXT_LIMIT) }))
      .slice(0, INSTRUCTION_HISTORY_LIMIT)
  } catch { return [] }
}

/**
 * Records a saved instruction text for a bot. The newest entry is first, an
 * identical text is not stored twice, and only the last `INSTRUCTION_HISTORY_LIMIT`
 * entries are kept. Text is capped at `INSTRUCTION_TEXT_LIMIT` characters.
 */
export function recordInstructionVersion(agentId: string, text: string): void {
  if (!agentId || !AGENT_ID.test(agentId)) return
  const store = storage()
  if (!store) return
  const capped = text.slice(0, INSTRUCTION_TEXT_LIMIT)
  const existing = instructionVersions(agentId)
  if (existing[0]?.text === capped) return
  const withoutDuplicate = existing.filter((version) => version.text !== capped)
  const next = [{ at: new Date().toISOString(), text: capped }, ...withoutDuplicate].slice(0, INSTRUCTION_HISTORY_LIMIT)
  try { store.setItem(instructionsKey(agentId), JSON.stringify(next)) } catch { /* History is a convenience. */ }
}

export interface InstructionCounts {
  characters: number
  /** A rough, always-labelled estimate: one token per four characters. */
  tokens: number
}

/** Character count and a rough token estimate for the instructions counter. */
export function instructionCounts(text: string): InstructionCounts {
  const characters = Array.from(text).length
  return { characters, tokens: Math.ceil(characters / 4) }
}

/** Thousands separators, locale-independent so tests are stable. */
export function thousands(value: number): string {
  const whole = Math.max(0, Math.trunc(value))
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
