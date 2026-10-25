import { COMPACT_W, EXPANDED_W, GREETING_H, OVERVIEW_H } from './engine/core/layout'

export type CompanionPresentation = 'petit' | 'hidden' | 'welcome' | 'home' | 'home-chat'

/**
 * Floating-window sizes in logical pixels (the shell's own constants are in `set_companion_mode` and
 * `COMPANION_*_SIZE` in src-tauri/src/lib.rs, which win). The compact bar is fixed. The expanded
 * companion is the split layout (bots left, conversation right): it opens at the size the owner last
 * dragged it to, between a minimum where nothing is cut off and the display's work area.
 */
export const COMPANION_WINDOW = {
  compact: { width: 344, height: 62 },
  greeting: { width: EXPANDED_W, height: OVERVIEW_H },
  expandedMin: { width: 520, height: 340 },
  expanded: { width: 640, height: 420 },
  expandedLarge: { width: 960, height: 720 },
} as const

export function companionWindowSize(mode: CompanionPresentation) {
  if (mode === 'petit' || mode === 'hidden') return COMPANION_WINDOW.compact
  if (mode === 'welcome') return COMPANION_WINDOW.greeting
  return COMPANION_WINDOW.expanded
}

export const ISLAND_GEOMETRY = { compactWidth: COMPACT_W, expandedWidth: EXPANDED_W, overviewHeight: OVERVIEW_H, greetingHeight: GREETING_H }

/** Teammates shown beside the focused blob on the island (a 2×2 grid). */
export const MAX_COMPANION_PEERS = 4
