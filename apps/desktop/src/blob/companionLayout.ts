import { COMPACT_W, EXPANDED_W, GREETING_H, OVERVIEW_H } from './coucou/core/layout'

export type CompanionPresentation = 'petit' | 'hidden' | 'coucou' | 'home' | 'home-chat'

/**
 * Floating-window sizes. Expanded views use Coucou's 640×160 island; the
 * compact bar is taller than the source's 32 px notch strip so it can carry a
 * readable face and status line as a free-floating window, and the chat view
 * grows like Coucou's prompt view (240–300 px).
 */
export const COMPANION_WINDOW = {
  compact: { width: 344, height: 62 },
  greeting: { width: EXPANDED_W, height: OVERVIEW_H },
  overview: { width: EXPANDED_W, height: OVERVIEW_H },
  chat: { width: EXPANDED_W, height: 264 },
} as const

export function companionWindowSize(mode: CompanionPresentation) {
  if (mode === 'petit' || mode === 'hidden') return COMPANION_WINDOW.compact
  if (mode === 'coucou') return COMPANION_WINDOW.greeting
  if (mode === 'home-chat') return COMPANION_WINDOW.chat
  return COMPANION_WINDOW.overview
}

export const COUCOU_SOURCE_GEOMETRY = { compactWidth: COMPACT_W, expandedWidth: EXPANDED_W, overviewHeight: OVERVIEW_H, greetingHeight: GREETING_H }
