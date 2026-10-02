/** Midnight swatch map. These hex literals are the only new colour values in Phase 3. */

export const AGENT_SWATCHES = [
  { key: 'coral', hex: '#F38C6F' },
  { key: 'orange', hex: '#F0A05A' },
  { key: 'amber', hex: '#E8C15A' },
  { key: 'lemon', hex: '#E4D56A' },
  { key: 'lime', hex: '#A8D45C' },
  { key: 'mint', hex: '#89D6B3' },
  { key: 'teal', hex: '#5EBEB0' },
  { key: 'cyan', hex: '#6EC8E0' },
  { key: 'sky', hex: '#7EB6F0' },
  { key: 'blue', hex: '#82AAFF' },
  { key: 'violet', hex: '#BF9CFF' },
  { key: 'pink', hex: '#F0A0C4' },
] as const

export type SwatchKey = (typeof AGENT_SWATCHES)[number]['key']

const HEX_BY_KEY = new Map<string, string>(AGENT_SWATCHES.map((swatch) => [swatch.key, swatch.hex]))
const KEY_BY_HEX = new Map<string, SwatchKey>(AGENT_SWATCHES.map((swatch) => [swatch.hex.toLowerCase(), swatch.key]))
const FALLBACK_HEX = AGENT_SWATCHES.find((swatch) => swatch.key === 'mint')?.hex ?? AGENT_SWATCHES[0].hex

export function swatchLabel(key: string) {
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : key
}

/** `#` plus six hex digits, or six digits without `#`. Returns uppercase `#RRGGBB`. */
export function parseCustomHex(value: string): string | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(value.trim())
  if (!match?.[1]) return null
  return `#${match[1].toUpperCase()}`
}

export function swatchForColor(value: string): SwatchKey | null {
  const key = value.trim().toLowerCase()
  if (HEX_BY_KEY.has(key)) return key as SwatchKey
  const hex = parseCustomHex(value)
  if (!hex) return null
  return KEY_BY_HEX.get(hex.toLowerCase()) ?? null
}

/** Known swatch or valid hex, otherwise null. Does not apply the display fallback. */
export function resolvedAgentColor(value: string): string | null {
  const key = value.trim().toLowerCase()
  const fromKey = HEX_BY_KEY.get(key)
  if (fromKey) return fromKey
  const hex = parseCustomHex(value)
  if (!hex) return null
  const mapped = KEY_BY_HEX.get(hex.toLowerCase())
  return mapped ? HEX_BY_KEY.get(mapped) ?? hex : hex
}

export function agentColorHex(value: string): string {
  return resolvedAgentColor(value) ?? FALLBACK_HEX
}

export function colorsEquivalent(left: string, right: string): boolean {
  const a = resolvedAgentColor(left)
  const b = resolvedAgentColor(right)
  if (!a || !b) return false
  return a.toLowerCase() === b.toLowerCase()
}

/** Swatch key when the value maps to one, otherwise uppercase `#RRGGBB`. */
export function colorForRpc(value: string): string {
  const key = swatchForColor(value)
  if (key) return key
  return parseCustomHex(value) ?? value.trim()
}

export function previewHex(value: string, lastValid: string): string {
  return resolvedAgentColor(value) ?? lastValid
}
