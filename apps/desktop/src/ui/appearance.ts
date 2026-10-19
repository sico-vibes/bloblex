export type ThemeChoice = 'system' | 'dark' | 'light'
export type TextSizeChoice = 'small' | 'default' | 'large' | 'larger'

export type ThemeStyle = 'bitbots' | 'blobots' | 'legacy' | 'pop' | 'dot'
export const THEME_STYLES: readonly ThemeStyle[] = ['bitbots', 'blobots', 'legacy', 'pop', 'dot']
export const THEME_LOOKS: ReadonlyArray<{ id: ThemeStyle; label: string; family: 'primary' | 'alternative' | 'more'; description: string }> = [
  { id: 'bitbots', label: 'Bitbots', family: 'primary', description: 'Frosted glass over a wallpaper you choose.' },
  { id: 'blobots', label: 'Blobots', family: 'alternative', description: 'Soft, quiet and monochrome.' },
  { id: 'legacy', label: 'Legacy', family: 'more', description: 'The original pixel look.' },
  { id: 'pop', label: 'Pop', family: 'more', description: 'Retro colour, outlined cards.' },
  { id: 'dot', label: 'Dot', family: 'more', description: 'Monochrome widgets, dot-matrix numbers.' },
]

export function isThemeStyle(value: unknown): value is ThemeStyle {
  return THEME_STYLES.includes(value as ThemeStyle)
}

const ACCENT_PATTERN = /^#[0-9a-fA-F]{6}$/

/** '' for anything that is not a `#rrggbb` colour, otherwise the colour in lower case. */
export function normalizeAccent(value: unknown): string {
  return typeof value === 'string' && ACCENT_PATTERN.test(value) ? value.toLowerCase() : ''
}

function accentChannels(hex: string): [number, number, number] {
  const raw = hex.replace('#', '')
  return [
    Number.parseInt(raw.slice(0, 2), 16),
    Number.parseInt(raw.slice(2, 4), 16),
    Number.parseInt(raw.slice(4, 6), 16),
  ]
}

function relativeLuminance(hex: string): number {
  const [red, green, blue] = accentChannels(hex).map((channel) => {
    const value = channel / 255
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
  })
  return .2126 * red! + .7152 * green! + .0722 * blue!
}

/** WCAG 2.x contrast ratio between two `#rrggbb` colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((left, right) => right - left)
  return (high! + .05) / (low! + .05)
}

const INK_DARK = '#0f0f10'
const INK_LIGHT = '#ffffff'

/** The four custom properties the UI reads for a user accent colour. */
export function accentTokens(hex: string): { accent: string; pressed: string; soft: string; ink: string } {
  const accent = normalizeAccent(hex)
  if (!accent) return { accent: '', pressed: '', soft: '', ink: INK_DARK }
  const [red, green, blue] = accentChannels(accent)
  const toHex = (value: number) => value.toString(16).padStart(2, '0')
  const pressed = `#${[red, green, blue].map((channel) => toHex(Math.round(channel * .88))).join('')}`
  const soft = `rgba(${red},${green},${blue},.14)`
  const dark = contrastRatio(INK_DARK, accent)
  const light = contrastRatio(INK_LIGHT, accent)
  const ink = dark >= 4.5 ? INK_DARK : light >= 4.5 ? INK_LIGHT : dark >= light ? INK_DARK : INK_LIGHT
  return { accent, pressed, soft, ink }
}

export function appearanceAttributes(theme: ThemeChoice, textSize: TextSizeChoice) {
  return { theme: theme === 'system' ? (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme, textSize }
}

export function applyAppearance(root: HTMLElement, theme: ThemeChoice, textSize: TextSizeChoice) {
  const resolved = appearanceAttributes(theme, textSize)
  root.dataset.theme = resolved.theme
  applyTextSize(root, resolved.textSize)
}

export function applyTextSize(root: HTMLElement, textSize: TextSizeChoice) {
  root.dataset.textSize = textSize
}

export function applySurfaceAppearance(root: HTMLElement, theme: ThemeChoice, textSize: TextSizeChoice, companion: boolean) {
  if (companion) {
    root.dataset.themeChoice = theme
    root.dataset.surfaceTheme = appearanceAttributes(theme, textSize).theme
    applyTextSize(root, textSize)
    return
  }
  root.dataset.themeChoice = theme
  applyAppearance(root, theme, textSize)
}
