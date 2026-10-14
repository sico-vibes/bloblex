const CLAUDE_FAMILY_ID = /^claude-(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/i

/**
 * The name a model is shown under. Claude Code reports bare family names
 * ("Sonnet") while its model id carries the release ("claude-sonnet-5-5"), so
 * a name with no number gains the version read from the id, the way Codex's
 * names already carry theirs. A name that already has a number, or an id that
 * names no release, is returned unchanged; the saved model id is never touched.
 */
export function modelDisplayName(model: { id: string; displayName: string }): string {
  const name = model.displayName.trim()
  if (!name || /\d/.test(name)) return model.displayName
  const id = (model.id.split('/').at(-1) ?? model.id).trim()
  const match = CLAUDE_FAMILY_ID.exec(id)
  if (!match) return model.displayName
  const family = match[1]!
  const label = family.charAt(0).toUpperCase() + family.slice(1).toLowerCase()
  // Only the family word the CLI already printed is extended, so a custom
  // name such as "Default (recommended)" is left alone.
  if (name.toLowerCase().replace(/^claude\s+/, '') !== family.toLowerCase()) return model.displayName
  const version = match[3] === undefined ? match[2]! : `${match[2]}.${match[3]}`
  return `${label} ${version}`
}
