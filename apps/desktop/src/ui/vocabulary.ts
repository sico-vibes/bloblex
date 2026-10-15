// The word the UI uses for a blob: a bot in Bitbots, a blob in Blobots. Kept
// as a helper so copy can follow the chosen style without hard-coding either.

import { useThemeStyle } from '../blob/bitbots'
import type { ThemeStyle } from './appearance'

export interface EntityNounOptions {
  plural?: boolean
  capital?: boolean
}

export function entityNoun(style: ThemeStyle, options: EntityNounOptions = {}): string {
  const word = (style === 'blobots' ? 'blob' : 'bot') + (options.plural ? 's' : '')
  return options.capital ? word[0]!.toUpperCase() + word.slice(1) : word
}

export function useEntityNoun(options: EntityNounOptions = {}): string {
  return entityNoun(useThemeStyle(), options)
}
