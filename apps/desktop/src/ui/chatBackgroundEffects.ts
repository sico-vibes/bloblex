// The chat background's effects: each takes an image's pixels and returns new ones.
// The algorithms are adapted from MonoCode (MIT); see docs/legal/third-party-notices.md.

export type ChatBackgroundEffect = 'none' | 'dither' | 'ascii' | 'halftone' | 'scanlines' | 'haze'
export const CHAT_BACKGROUND_EFFECTS: ReadonlyArray<{ value: ChatBackgroundEffect; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'dither', label: 'Dither' },
  { value: 'ascii', label: 'ASCII' },
  { value: 'halftone', label: 'Halftone' },
  { value: 'scanlines', label: 'Scanlines' },
  { value: 'haze', label: 'Haze' },
]

export type Pixels = { width: number; height: number; data: Uint8ClampedArray }

const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]
const GLYPHS = [
  [0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 4, 0],
  [0, 4, 0, 0, 4, 0, 0],
  [0, 0, 0, 14, 0, 0, 0],
  [0, 0, 14, 0, 14, 0, 0],
  [0, 4, 4, 31, 4, 4, 0],
  [0, 21, 14, 31, 14, 21, 0],
  [10, 10, 31, 10, 31, 10, 10],
  [17, 2, 4, 4, 8, 16, 17],
  [14, 17, 23, 21, 23, 16, 14],
]

const indexAt = (source: Pixels, x: number, y: number) => Math.max(0, Math.min(source.height - 1, Math.floor(y))) * source.width + Math.max(0, Math.min(source.width - 1, Math.floor(x)))
const lumaAt = (source: Pixels, index: number) => Math.round(source.data[index * 4]! * 0.2126 + source.data[index * 4 + 1]! * 0.7152 + source.data[index * 4 + 2]! * 0.0722)

function dither(source: Pixels) {
  const output = new Uint8ClampedArray(source.data.length)
  for (let y = 0; y < source.height; y += 2) {
    for (let x = 0; x < source.width; x += 2) {
      const base = indexAt(source, x + 1, y + 1) * 4
      const [r, g, b, a] = [source.data[base]!, source.data[base + 1]!, source.data[base + 2]!, source.data[base + 3]!]
      const peak = Math.max(r, g, b)
      const threshold = BAYER[Math.floor(y / 2) % 4]![Math.floor(x / 2) % 4]!
      const gain = peak / 255 > (threshold + 0.5) / 16 ? 255 / Math.max(peak, 1) : 0.08
      for (let dy = 0; dy < Math.min(2, source.height - y); dy += 1) {
        for (let dx = 0; dx < Math.min(2, source.width - x); dx += 1) {
          output.set([r * gain, g * gain, b * gain, a], ((y + dy) * source.width + x + dx) * 4)
        }
      }
    }
  }
  return output
}

function ascii(source: Pixels, light: boolean) {
  const output = new Uint8ClampedArray(source.data.length)
  const paper = light ? 255 : 0
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const sample = indexAt(source, Math.floor(x / 6) * 6 + 3, Math.floor(y / 8) * 8 + 4)
      const density = light ? 255 - lumaAt(source, sample) : lumaAt(source, sample)
      const glyph = GLYPHS[Math.floor(Math.sqrt(density / 255) * 9)]!
      const ink = x % 6 < 5 && y % 8 < 7 && (glyph[y % 8]! & (1 << (4 - (x % 6)))) !== 0
      const pixel = (y * source.width + x) * 4
      for (let color = 0; color < 3; color += 1) output[pixel + color] = source.data[pixel + color]! * 0.6 + (ink ? source.data[sample * 4 + color]! : paper) * 0.4
      output[pixel + 3] = source.data[pixel + 3]!
    }
  }
  return output
}

function halftone(source: Pixels, light: boolean) {
  const output = new Uint8ClampedArray(source.data.length)
  const paper = light ? 255 : 0
  for (let y = 0; y < source.height; y += 4) {
    for (let x = 0; x < source.width; x += 4) {
      const sampled = lumaAt(source, indexAt(source, x, y))
      const radius = 2 * (0.3 + 0.7 * Math.sqrt((light ? 255 - sampled : sampled) / 255))
      const dot = indexAt(source, x + 2, y + 2) * 4
      for (let dy = 0; dy < Math.min(4, source.height - y); dy += 1) {
        for (let dx = 0; dx < Math.min(4, source.width - x); dx += 1) {
          const coverage = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(dx - 1.5, dy - 1.5))) * (source.data[dot + 3]! / 255)
          const pixel = ((y + dy) * source.width + x + dx) * 4
          for (let color = 0; color < 3; color += 1) output[pixel + color] = source.data[pixel + color]! * 0.6 + (source.data[dot + color]! * coverage + paper * (1 - coverage)) * 0.4
          output[pixel + 3] = source.data[pixel + 3]!
        }
      }
    }
  }
  return output
}

function scanlines(source: Pixels, light: boolean) {
  const output = new Uint8ClampedArray(source.data.length)
  for (let y = 0; y < source.height; y += 1) {
    const gain = y % 3 === 0 ? 0.52 : 1
    for (let x = 0; x < source.width; x += 1) {
      const pixel = (y * source.width + x) * 4
      for (let color = 0; color < 3; color += 1) {
        const value = source.data[pixel + color]!
        output[pixel + color] = light ? value + (255 - value) * (1 - gain) : value * gain
      }
      output[pixel + 3] = source.data[pixel + 3]!
    }
  }
  return output
}

/** The effect's pixels. `none` and `haze` show the image as it is: Haze is drawn with CSS blur. */
export function applyEffect(source: Pixels, effect: ChatBackgroundEffect, light: boolean): Uint8ClampedArray {
  if (effect === 'dither') return dither(source)
  if (effect === 'ascii') return ascii(source, light)
  if (effect === 'halftone') return halftone(source, light)
  if (effect === 'scanlines') return scanlines(source, light)
  return source.data
}
