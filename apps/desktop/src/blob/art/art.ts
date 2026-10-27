// Art styles for bots. A look may name one explicitly; otherwise it follows
// the app look. The art mood is the small state vocabulary the SVG renderers
// share, mapped from the classic blob's moods.

import type { BlobMood } from '../characterState'
import type { BlobShape } from '../look/forms'

export type BotArt = 'robot' | 'blob' | 'painted'

export const BOT_ARTS = ['robot', 'blob', 'painted'] as const

/** Retired arts (the 2D robot and the flat and dot robots it absorbed); a stored one shows the 3D robot. */
export const RETIRED_ROBOT_ARTS = ['robot-pop', 'robot-flat', 'robot-dot'] as const

export const ART_LABELS: Record<BotArt, string> = {
  robot: '3D robot',
  blob: 'Glossy',
  painted: 'Hand-painted',
}

export const ROBOT_ARTS: readonly BotArt[] = ['robot']
export const BLOB_ARTS: readonly BotArt[] = ['blob', 'painted']

export type PaintedShape = 'classic' | 'cube' | 'star' | 'flower' | 'pear' | 'peanut' | 'ghost' | 'bunny' | 'kitty' | 'ufo' | 'boxbot' | 'tile'

export const PAINTED_SHAPES = ['classic', 'cube', 'star', 'flower', 'pear', 'peanut', 'ghost', 'bunny', 'kitty', 'ufo', 'boxbot', 'tile'] as const

export const PAINTED_LABELS: Record<PaintedShape, string> = {
  classic: 'Classic',
  cube: 'Cube',
  star: 'Star',
  flower: 'Flower',
  pear: 'Pear',
  peanut: 'Peanut',
  ghost: 'Ghost',
  bunny: 'Bunny',
  kitty: 'Kitty',
  ufo: 'UFO',
  boxbot: 'Box bot',
  tile: 'Tile',
}

export type ArtMood = 'idle' | 'thinking' | 'typing' | 'waiting' | 'happy' | 'error' | 'sleeping' | 'offline'

export const ART_MOODS = ['idle', 'thinking', 'typing', 'waiting', 'happy', 'error', 'sleeping', 'offline'] as const

const ART_MOOD_FOR: Record<BlobMood, ArtMood> = {
  idle: 'idle',
  online: 'idle',
  thinking: 'thinking',
  working: 'typing',
  tool_activity: 'thinking',
  file_activity: 'typing',
  file_drop: 'happy',
  file_preparing: 'typing',
  file_ready: 'happy',
  file_sending: 'typing',
  file_error: 'error',
  permission: 'waiting',
  success: 'happy',
  error: 'error',
  offline: 'offline',
  listening: 'thinking',
  rate_limited: 'waiting',
  sleeping: 'sleeping',
}

/** A blob mood that produces each art mood, for sheets and tests. */
export const ART_MOOD_SAMPLE: Record<ArtMood, BlobMood> = {
  idle: 'idle',
  thinking: 'thinking',
  typing: 'working',
  waiting: 'permission',
  happy: 'success',
  error: 'error',
  sleeping: 'sleeping',
  offline: 'offline',
}

const PAINT_FOR_SHAPE: Record<BlobShape, PaintedShape> = {
  circle: 'classic',
  squircle: 'cube',
  droplet: 'pear',
  cloud: 'flower',
  pebble: 'ghost',
  capsule: 'peanut',
  triangle: 'star',
  hexagon: 'tile',
}

export function isBotArt(value: unknown): value is BotArt {
  return typeof value === 'string' && (BOT_ARTS as readonly string[]).includes(value)
}

export function isPaintedShape(value: unknown): value is PaintedShape {
  return typeof value === 'string' && (PAINTED_SHAPES as readonly string[]).includes(value)
}

export function artMoodFor(mood: BlobMood): ArtMood {
  return ART_MOOD_FOR[mood] ?? 'idle'
}

/** The art a bot wears when it has not chosen one: Glossy in both looks (Stone shows it; Haze shows a mark instead). */
export function defaultArtForStyle(_style?: string | null): BotArt {
  return 'blob'
}

/** An explicit choice wins; otherwise the app look decides. */
export function resolveArt(look: { art?: unknown } | null | undefined, style: string | null | undefined): BotArt {
  if ((RETIRED_ROBOT_ARTS as readonly unknown[]).includes(look?.art)) return 'robot'
  return isBotArt(look?.art) ? look.art : defaultArtForStyle(style)
}

export function paintForShape(shape: string | null | undefined): PaintedShape {
  return PAINT_FOR_SHAPE[shape as BlobShape] ?? 'classic'
}

/** The hand-painted body: the chosen one, or one that matches the blob shape. */
export function resolvePaint(look: { shape?: string | null; paint?: unknown } | null | undefined): PaintedShape {
  return isPaintedShape(look?.paint) ? look.paint : paintForShape(look?.shape)
}
