import { COMPACT_W, EXPANDED_W, GREETING_H, OVERVIEW_H } from './engine/core/layout'

export type CompanionPresentation = 'petit' | 'hidden' | 'welcome' | 'home' | 'home-chat'

/**
 * Floating-window sizes. Expanded views use the 640×160 island; the
 * compact bar is taller than the source's 32 px notch strip so it can carry a
 * readable face and status line as a free-floating window, and the chat view
 * grows like the prompt view (240–300 px).
 */
export const COMPANION_WINDOW = {
  compact: { width: 344, height: 62 },
  greeting: { width: EXPANDED_W, height: OVERVIEW_H },
  overview: { width: EXPANDED_W, height: OVERVIEW_H },
  chat: { width: EXPANDED_W, height: 264 },
} as const

export function companionWindowSize(mode: CompanionPresentation) {
  if (mode === 'petit' || mode === 'hidden') return COMPANION_WINDOW.compact
  if (mode === 'welcome') return COMPANION_WINDOW.greeting
  if (mode === 'home-chat') return COMPANION_WINDOW.chat
  return COMPANION_WINDOW.overview
}

export const ISLAND_GEOMETRY = { compactWidth: COMPACT_W, expandedWidth: EXPANDED_W, overviewHeight: OVERVIEW_H, greetingHeight: GREETING_H }

/** Chat island heights the user can choose in the companion's settings. */
export const COMPANION_CHAT_SIZES = { small: 264, medium: 360, large: 480 } as const
export type CompanionChatSize = keyof typeof COMPANION_CHAT_SIZES
export const COMPANION_CHAT_SIZE_LABELS: Record<CompanionChatSize, string> = { small: 'Compact', medium: 'Comfortable', large: 'Tall' }
export function isCompanionChatSize(value: unknown): value is CompanionChatSize {
  return value === 'small' || value === 'medium' || value === 'large'
}
/** Teammates shown beside the focused blob on the island (a 2×2 grid). */
export const MAX_COMPANION_PEERS = 4
