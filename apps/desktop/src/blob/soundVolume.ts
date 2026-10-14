// The companion sounds volume setting (`companion.soundVolume`). Kept apart
// from the audio engine so settings screens can read and format it without
// pulling in Web Audio.

/** What the volume reads before the user moves it. */
export const DEFAULT_SOUND_VOLUME = 0.8

/** A saved volume is a finite number from 0 to 1; anything else is the default. */
export function normalizeSoundVolume(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SOUND_VOLUME
  return Math.min(1, Math.max(0, value))
}

/** The slider works in whole 5% steps; the setting stores the 0 to 1 fraction. */
export function soundVolumeToPercent(volume: number): number {
  return Math.round(normalizeSoundVolume(volume) * 100)
}

export function percentToSoundVolume(percent: number): number {
  return normalizeSoundVolume(Math.round(percent) / 100)
}
