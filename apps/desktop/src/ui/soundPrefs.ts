// One source of truth for the companion's sound toggle and volume. The
// companion's settings view and the main Settings sheet both read and write
// through this module, so the two controls can never disagree: the value lives
// in one small store per window, is persisted under one key pair, and every
// change is broadcast so the other window follows.

import { emitNative } from '../transport/nativeBridge'
import { DEFAULT_SOUND_VOLUME, normalizeSoundVolume } from '../blob/soundVolume'
import { rpc } from '../tauri'

export const SOUNDS_ENABLED_KEY = 'companion.soundsEnabled'
export const SOUND_VOLUME_KEY = 'companion.soundVolume'
/** Carries the boolean companion-sounds switch between windows. */
export const SOUNDS_CHANGED_EVENT = 'bloblex-sounds-changed'
/** Carries `{ volume, preview? }` between windows. */
export const SOUND_VOLUME_CHANGED_EVENT = 'bloblex-sound-volume-changed'

export interface SoundPrefs {
  soundsEnabled: boolean
  soundVolume: number
}

export const DEFAULT_SOUND_PREFS: SoundPrefs = { soundsEnabled: false, soundVolume: DEFAULT_SOUND_VOLUME }

/** The two settings out of a `settings.get` payload, normalized. */
export function soundPrefsFromSettings(source: unknown): SoundPrefs {
  const root = source && typeof source === 'object' ? source as Record<string, unknown> : {}
  const settings = root.settings && typeof root.settings === 'object' ? root.settings as Record<string, unknown> : root
  return {
    soundsEnabled: settings[SOUNDS_ENABLED_KEY] === true,
    soundVolume: normalizeSoundVolume(settings[SOUND_VOLUME_KEY]),
  }
}

let current: SoundPrefs = DEFAULT_SOUND_PREFS
const listeners = new Set<(prefs: SoundPrefs) => void>()

/** The value every control on this window agrees on. */
export function soundPrefs(): SoundPrefs {
  return current
}

/** Replace the shared value and tell every control on this window. */
export function applySoundPrefs(next: Partial<SoundPrefs>): SoundPrefs {
  const merged: SoundPrefs = {
    soundsEnabled: next.soundsEnabled ?? current.soundsEnabled,
    soundVolume: next.soundVolume === undefined ? current.soundVolume : normalizeSoundVolume(next.soundVolume),
  }
  if (merged.soundsEnabled === current.soundsEnabled && merged.soundVolume === current.soundVolume) return current
  current = merged
  for (const listener of [...listeners]) listener(current)
  return current
}

export function subscribeSoundPrefs(listener: (prefs: SoundPrefs) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Reset to the defaults; used when the saved settings cannot be read. */
export function resetSoundPrefs(): SoundPrefs {
  return applySoundPrefs(DEFAULT_SOUND_PREFS)
}

/** Save the switch, update the store and tell the other window. */
export async function saveSoundsEnabled(enabled: boolean): Promise<void> {
  await rpc('settings.set', { key: SOUNDS_ENABLED_KEY, value: enabled })
  applySoundPrefs({ soundsEnabled: enabled })
  try { await emitNative(SOUNDS_CHANGED_EVENT, enabled) } catch { /* The other window hydrates the saved value on its next connection. */ }
}

/** Save the volume, update the store and tell the other window. */
export async function saveSoundVolume(volume: number, preview = false): Promise<void> {
  const value = normalizeSoundVolume(volume)
  await rpc('settings.set', { key: SOUND_VOLUME_KEY, value })
  applySoundPrefs({ soundVolume: value })
  try { await emitNative(SOUND_VOLUME_CHANGED_EVENT, preview ? { volume: value, preview: true } : { volume: value }) } catch { /* The other window hydrates the saved value on its next connection. */ }
}

/** Ask the window that owns audio for one cue at the volume, without saving. */
export async function previewSoundVolume(volume: number): Promise<void> {
  try { await emitNative(SOUND_VOLUME_CHANGED_EVENT, { volume: normalizeSoundVolume(volume), preview: true }) } catch { /* The companion hydrates the saved value on its next connection. */ }
}
