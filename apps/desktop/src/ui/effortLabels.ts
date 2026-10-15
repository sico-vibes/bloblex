/** Provider-scoped display labels. Return the provider's raw id when it has
 * no known presentation alias; this function never changes the saved value. */
export function labelizeEffort(value: string, provider = '') {
  const key = value.trim().toLowerCase()
  if (provider.toLowerCase() === 'codex') {
    if (key === 'low') return 'Light'
    if (key === 'medium') return 'Medium'
    if (key === 'high') return 'High'
    if (key === 'xhigh') return 'Extra High'
    if (key === 'max') return 'Max'
    if (key === 'ultra') return 'Ultra'
  }
  if (key === 'xhigh') return 'Extra high'
  if (key === 'ultracode') return 'Ultracode'
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

/**
 * One short, plain-language line for an effort level, shown under its name in
 * the effort menu. Ultracode (and any unknown level) returns '' and keeps its
 * own wording elsewhere.
 */
export function effortDescription(value: string): string {
  const key = value.trim().toLowerCase()
  if (key === 'low') return 'Fast, light reasoning'
  if (key === 'medium') return 'Balanced'
  if (key === 'high') return 'Slower, more thorough'
  if (key === 'xhigh' || key === 'max') return 'Slowest, deepest'
  return ''
}
