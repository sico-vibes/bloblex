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
