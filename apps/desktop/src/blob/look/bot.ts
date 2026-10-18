// Bitbots: the pixel-robot skin for blobs. A blob keeps its own look (the
// silhouette and face the classic renderer draws); this is the extra styling
// the robot heads read when Bitbots mode is on. Robots are drawn by the MIT
// licensed `robot-heads` library (github.com/fayazara/robot-heads).
//
// Only the outline and three colours are the user's to change. The antenna
// is always off and the speed is always 1, by product decision.

export const BOT_SHAPES = ['rectangle', 'square', 'circle', 'hexagon'] as const
export type BotShape = typeof BOT_SHAPES[number]

export const BOT_SHAPE_LABELS: Record<BotShape, string> = {
  rectangle: 'Rectangle', square: 'Square', circle: 'Circle', hexagon: 'Hexagon',
}

/** The robot's outline and colours. Every field is optional; the rest follows the blob. */
export interface BotStyle {
  shape?: BotShape
  /** The shell. Defaults to the blob's own colour. */
  shell?: string
  /** The ears and the antenna collar. */
  trim?: string
  /** The LEDs on the screen. */
  screen?: string
}

export interface ResolvedBot {
  shape: BotShape
  shell: string
  trim: string
  screen: string
}

export const DEFAULT_TRIM = '#93a6c8'
export const DEFAULT_SCREEN = '#e8f2ff'

export interface BotSwatch { id: string; label: string; value: string }

// Palettes follow the robot-heads playground so the heads look as intended.
export const SHELL_SWATCHES: readonly BotSwatch[] = [
  { id: 'cobalt', label: 'Cobalt', value: '#2b49a3' },
  { id: 'red', label: 'Red', value: '#d23b36' },
  { id: 'orange', label: 'Orange', value: '#e5812b' },
  { id: 'yellow', label: 'Yellow', value: '#e4b429' },
  { id: 'green', label: 'Green', value: '#2f8f4e' },
  { id: 'teal', label: 'Teal', value: '#1f8a8a' },
  { id: 'purple', label: 'Purple', value: '#7a4cc2' },
  { id: 'pink', label: 'Pink', value: '#d95f9a' },
  { id: 'graphite', label: 'Graphite', value: '#3d4046' },
  { id: 'white', label: 'White', value: '#e8eaee' },
]

export const TRIM_SWATCHES: readonly BotSwatch[] = [
  { id: 'steel', label: 'Steel', value: DEFAULT_TRIM },
  { id: 'silver', label: 'Silver', value: '#c9ccd3' },
  { id: 'brass', label: 'Brass', value: '#c9a45a' },
  { id: 'copper', label: 'Copper', value: '#c27850' },
  { id: 'graphite', label: 'Graphite', value: '#3d4046' },
]

export const SCREEN_SWATCHES: readonly BotSwatch[] = [
  { id: 'white', label: 'White', value: DEFAULT_SCREEN },
  { id: 'cyan', label: 'Cyan', value: '#59d7ff' },
  { id: 'green', label: 'Green', value: '#5dff9a' },
  { id: 'amber', label: 'Amber', value: '#ffc247' },
  { id: 'pink', label: 'Pink', value: '#ff6fb1' },
]

const HEX = /^#[0-9a-fA-F]{6}$/

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value)
}

export function isBotShape(value: unknown): value is BotShape {
  return typeof value === 'string' && (BOT_SHAPES as readonly string[]).includes(value)
}

/** A stored or imported style, or undefined when it holds nothing usable. */
export function normalizeBot(raw: unknown): BotStyle | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const style: BotStyle = {}
  if (isBotShape(value.shape)) style.shape = value.shape
  if (isHexColor(value.shell)) style.shell = value.shell.toLowerCase()
  if (isHexColor(value.trim)) style.trim = value.trim.toLowerCase()
  if (isHexColor(value.screen)) style.screen = value.screen.toLowerCase()
  return Object.keys(style).length ? style : undefined
}

/** The robot a blob silhouette maps to when the user has not chosen an outline. */
const SHAPE_FOR_BLOB: Record<string, BotShape> = {
  circle: 'circle', pebble: 'circle', squircle: 'square',
  round: 'circle', organic: 'circle', droplet: 'circle', sun: 'hexagon', hexagon: 'hexagon',
  boxy: 'square', triangle: 'square', cat: 'square', capsule: 'rectangle', cloud: 'rectangle',
}

export function defaultBotShape(blobShape: string | undefined): BotShape {
  return SHAPE_FOR_BLOB[blobShape ?? ''] ?? 'rectangle'
}

/** Fills the gaps in a style from the blob's own shape and colour. */
export function resolveBot(look: { shape?: string; bot?: BotStyle } | null | undefined, blobColorHex: string): ResolvedBot {
  const bot = look?.bot
  return {
    shape: bot?.shape ?? defaultBotShape(look?.shape),
    shell: bot?.shell ?? (isHexColor(blobColorHex) ? blobColorHex : SHELL_SWATCHES[0].value),
    trim: bot?.trim ?? DEFAULT_TRIM,
    screen: bot?.screen ?? DEFAULT_SCREEN,
  }
}

export function sameBot(a: BotStyle | undefined, b: BotStyle | undefined) {
  return JSON.stringify([a?.shape ?? null, a?.shell ?? null, a?.trim ?? null, a?.screen ?? null])
    === JSON.stringify([b?.shape ?? null, b?.shell ?? null, b?.trim ?? null, b?.screen ?? null])
}

/** A random but tasteful combination, for "Surprise me". */
export function randomBot(shape: BotShape, random: () => number = Math.random): BotStyle {
  const pick = <T,>(items: readonly T[]) => items[Math.min(items.length - 1, Math.floor(random() * items.length))]
  return {
    shape,
    shell: pick(SHELL_SWATCHES).value,
    trim: pick(TRIM_SWATCHES).value,
    screen: pick(SCREEN_SWATCHES).value,
  }
}
