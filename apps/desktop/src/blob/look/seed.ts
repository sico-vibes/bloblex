// Seed hashing and the trait reader behind blob looks.
//
// Adapted from blobatar (https://github.com/Alain00/blobatar, packages/blobatar
// src/hash.ts and src/traits.ts at a7fd546), MIT License, Copyright (c) 2026
// Alain. See THIRD_PARTY_NOTICES.md.

const SEP = 0xff
const utf8 = new TextEncoder()

function feed(h: number, bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) {
    h = Math.imul(h ^ bytes[i]!, 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return h
}

/** murmur3 fmix32: a bijection on uint32 with full avalanche. */
function finalize(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^ (h >>> 16)) >>> 0
}

export function normalizeSeed(seed: string): string {
  return seed.normalize('NFC').trim().toLowerCase()
}

function seedState(seed: string): number {
  const s = normalizeSeed(seed)
  return feed(1779033703 ^ s.length, utf8.encode(s))
}

/** One uniform float in [0, 1) for `key`, independent of every other key. */
function stream(state: number, key: string): number {
  return finalize(feed(feed(state, Uint8Array.of(SEP)), utf8.encode(key))) / 4294967296
}

/** Pinned trait positions in [0, 1), keyed as the layout reads them. */
export type TraitOverrides = Record<string, number>

export interface Traits {
  (key: string): number
  num(key: string, min: number, max: number): number
  int(key: string, min: number, max: number): number
  jitter(key: string, amount: number): number
}

/**
 * Every value is addressed by a string key, so a pinned key changes only that
 * trait and an unpinned one keeps coming from the seed. Overrides are clamped
 * into [0, 1) rather than trusted, and NaN falls to 0.
 */
export function traits(seed: string, overrides?: TraitOverrides): Traits {
  const state = seedState(seed)
  const t = ((key: string) => {
    const o = overrides?.[key]
    return o === undefined ? stream(state, key) : o > 0 ? (o < 1 ? o : 0.999999) : 0
  }) as Traits
  t.num = (key, min, max) => min + t(key) * (max - min)
  t.int = (key, min, max) => min + Math.floor(t(key) * (max - min + 1))
  t.jitter = (key, amount) => (t(key) * 2 - 1) * amount
  return t
}
