// The word the UI uses for a character. They are bots in both looks (owner
// review, 16 October 2026); the Blobots look keeps its art, not the word.
// Kept as a helper so copy has one place to change.

import { useThemeStyle } from '../blob/bitbots'
import type { ThemeStyle } from './appearance'

export interface EntityNounOptions {
  plural?: boolean
  capital?: boolean
}

export function entityNoun(_style: ThemeStyle, options: EntityNounOptions = {}): string {
  const word = 'bot' + (options.plural ? 's' : '')
  return options.capital ? word[0]!.toUpperCase() + word.slice(1) : word
}

export function useEntityNoun(options: EntityNounOptions = {}): string {
  return entityNoun(useThemeStyle(), options)
}
