// Haze look: a bot shows its runtime's logo or a character portrait instead of a
// mascot. The icon is stored on the look (`look.icon`); the daemon's
// `valid_look` keeps the same list. Pixel icons were retired on 27 October 2026.
import { CHARACTER_LABELS, HAZE_CHARACTERS, type HazeCharacter } from './characters'

export type HazeIcon = 'logo' | 'logo-tint' | 'logo-mono' | HazeCharacter

export const LOGO_ICONS = ['logo', 'logo-tint', 'logo-mono'] as const
export const HAZE_ICONS: readonly HazeIcon[] = [...LOGO_ICONS, ...HAZE_CHARACTERS.map(({ id }) => id)]

export const ICON_LABELS: Record<HazeIcon, string> = {
  logo: 'Logo', 'logo-tint': 'Logo in bot colour', 'logo-mono': 'Logo in one colour',
  ...CHARACTER_LABELS,
}

export function isHazeIcon(value: unknown): value is HazeIcon {
  return typeof value === 'string' && (HAZE_ICONS as readonly string[]).includes(value)
}
