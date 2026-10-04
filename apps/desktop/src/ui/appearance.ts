export type ThemeChoice = 'system' | 'dark' | 'light'
export type TextSizeChoice = 'small' | 'default' | 'large' | 'larger'

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
    applyTextSize(root, textSize)
    return
  }
  root.dataset.themeChoice = theme
  applyAppearance(root, theme, textSize)
}
