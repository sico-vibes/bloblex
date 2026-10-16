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

export type EffortIconName = 'signal-zero' | 'signal-low' | 'signal-medium' | 'signal-high' | 'signal' | 'flame' | 'gauge'

/**
 * The bars icon shown next to an effort level: more bars for more reasoning,
 * a flame for the Ultra levels, a gauge when the model's default applies.
 */
export function effortIconName(value: string | null | undefined): EffortIconName {
  const key = (value ?? '').trim().toLowerCase()
  if (!key) return 'gauge'
  if (key === 'none' || key === 'off' || key === 'minimal') return 'signal-zero'
  if (key === 'low' || key === 'light') return 'signal-low'
  if (key === 'medium') return 'signal-medium'
  if (key === 'high') return 'signal-high'
  if (key === 'xhigh' || key === 'max') return 'signal'
  if (key === 'ultra' || key === 'ultracode') return 'flame'
  return 'gauge'
}
