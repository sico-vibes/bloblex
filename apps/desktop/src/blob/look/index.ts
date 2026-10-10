// Blob looks: a silhouette, a seed and a few pinned traits. The seed fills in
// every trait the user has not pinned, so a look is small enough to store with
// the blob and share in an export.
//
// The shape vocabulary, trait keys and face fitting are adapted from blobatar
// (https://github.com/Alain00/blobatar), MIT License, Copyright (c) 2026 Alain.

import { BLOB_SHAPES, layoutForm, shapeForPosition, type BlobShape, type FormLayout } from './forms'
import { traits, type TraitOverrides } from './seed'

export { BLOB_SHAPES, type BlobShape, type FormLayout, type FormEye } from './forms'
export type { TraitOverrides } from './seed'

export interface BlobLook {
  shape: BlobShape
  /** Fills every unpinned trait. Agents default to their id. */
  seed?: string | null
  traits?: TraitOverrides
}

export const SHAPE_LABELS: Record<BlobShape, string> = {
  round: 'Round', organic: 'Organic', boxy: 'Boxy', capsule: 'Capsule', cloud: 'Cloud',
  droplet: 'Droplet', hexagon: 'Hexagon', sun: 'Sun', triangle: 'Triangle', cat: 'Cat',
}

/**
 * The Bloblex mascot: the round silhouette with tall capsule eyes. It is the
 * face of onboarding, the welcome wave and the companion's default look.
 */
export const MASCOT_LOOK: BlobLook = {
  shape: 'round',
  seed: 'bloblex',
  traits: {
    'body.r': 0.999, 'body.ratio': 0.5, 'body.n': 0.25,
    'eye.rx': 0.999, 'eye.ratio': 0.33, 'eye.scale': 0.48, 'eye.stretch': 0.455, 'eye.gap': 0.53,
    'eye.n': 0.4, 'eye.lean': 0.5, 'eye.lean2': 0.5, 'eye.dy': 0.5, 'gaze.x': 0.5, 'gaze.y': 0.25,
  },
}

const TRAIT_KEY = /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/
export const MAX_LOOK_TRAITS = 48

export function isBlobShape(value: unknown): value is BlobShape {
  return typeof value === 'string' && (BLOB_SHAPES as readonly string[]).includes(value)
}

/** A stored or imported look, or null when it is missing or malformed. */
export function normalizeLook(raw: unknown): BlobLook | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (!isBlobShape(value.shape)) return null
  const look: BlobLook = { shape: value.shape }
  if (typeof value.seed === 'string' && value.seed.trim() && value.seed.length <= 80) look.seed = value.seed
  if (value.traits && typeof value.traits === 'object' && !Array.isArray(value.traits)) {
    const pinned: TraitOverrides = {}
    for (const [key, position] of Object.entries(value.traits as Record<string, unknown>).slice(0, MAX_LOOK_TRAITS)) {
      if (TRAIT_KEY.test(key) && key.length <= 32 && typeof position === 'number' && Number.isFinite(position)) pinned[key] = Math.max(0, Math.min(0.999999, position))
    }
    if (Object.keys(pinned).length) look.traits = pinned
  }
  return look
}

/** The look an agent wears: its stored look, else a round blob seeded by its id. */
export function agentLook(agent: { id?: string | null; look?: unknown } | null | undefined): BlobLook {
  const stored = normalizeLook(agent?.look)
  return { shape: stored?.shape ?? 'round', seed: stored?.seed || agent?.id || 'blob', traits: stored?.traits }
}

/** The look the editor previews: the draft's look, else the default for this blob id. */
export function draftLook(draft: { look: BlobLook | null }, agentId?: string | null): BlobLook {
  return draft.look ? { ...draft.look, seed: draft.look.seed || agentId || 'blob' } : agentLook({ id: agentId })
}

export function sameLook(a: BlobLook | null | undefined, b: BlobLook | null | undefined) {
  return lookKey(a ?? MASCOT_LOOK) === lookKey(b ?? MASCOT_LOOK)
}

function lookKey(look: BlobLook) {
  const pinned = Object.entries(look.traits ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify([look.shape, look.seed ?? '', pinned])
}

/**
 * Body presets. Every blob gets the same footprint: the body's size,
 * proportion and squareness are fixed per silhouette, while the face and the
 * shape's own details (lumps, petals, ears) still come from the seed.
 */
const BODY_PRESETS: TraitOverrides = { 'body.r': 0.999, 'body.ratio': 0.5, 'body.n': 0.25, 'capsule.squat': 0.5, 'droplet.tip': 0.5 }
// Boxy reads `body.n` over its own squarer range.
const SHAPE_PRESETS: Partial<Record<BlobShape, TraitOverrides>> = { boxy: { 'body.n': 0.45 } }

const cache = new Map<string, FormLayout>()

/** The resolved geometry for a look. Memoised: every avatar redraws from it. */
export function resolveForm(look: BlobLook | null | undefined): FormLayout {
  const value = look ?? MASCOT_LOOK
  const key = lookKey(value)
  let form = cache.get(key)
  if (!form) {
    form = layoutForm(value.shape, traits(value.seed || 'blob', { ...value.traits, ...BODY_PRESETS, ...SHAPE_PRESETS[value.shape] }))
    if (cache.size > 400) cache.clear()
    cache.set(key, form)
  }
  return form
}

/** The position a trait resolves to for this look, pinned or seeded. */
export function traitPosition(look: BlobLook, key: string): number {
  return traits(look.seed || 'blob', look.traits)(key)
}

export function withTrait(look: BlobLook, keys: string | readonly string[], position: number): BlobLook {
  const next = { ...(look.traits ?? {}) }
  for (const key of typeof keys === 'string' ? [keys] : keys) next[key] = Math.max(0, Math.min(0.999999, position))
  return { ...look, traits: next }
}

/** A fresh seed. With `anyShape`, the silhouette is drawn from the seed too. */
export function shuffleLook(look: BlobLook, anyShape = false, random: () => number = Math.random): BlobLook {
  const seed = `blob-${Math.floor(random() * 0xffffffff).toString(36)}`
  return { shape: anyShape ? shapeForPosition(random()) : look.shape, seed }
}

export interface LookControl {
  /** One key, or several written together (a macro). */
  keys: string | readonly string[]
  label: string
  /** Shown only for these silhouettes; omitted means every silhouette. */
  shapes?: readonly BlobShape[]
}

/** Silhouettes whose eyes come from the seeded face fit (the cat draws its own). */
const SEEDED_FACES = BLOB_SHAPES.filter((shape) => shape !== 'cat')

export interface LookControlGroup { title: string; controls: readonly LookControl[] }

/** A curated set: the trait keys that read well as sliders, per silhouette. */
export const LOOK_CONTROLS: readonly LookControlGroup[] = [
  {
    title: 'Details',
    controls: [
      { keys: 'body.rot', label: 'Tilt', shapes: ['boxy', 'hexagon', 'triangle'] },
      { keys: 'poly.round', label: 'Corner rounding', shapes: ['hexagon', 'triangle'] },
      { keys: 'sun.n', label: 'Petals', shapes: ['sun'] },
      { keys: 'sun.r', label: 'Petal size', shapes: ['sun'] },
      { keys: 'cloud.n', label: 'Puffs', shapes: ['cloud'] },
      { keys: 'cat.ear', label: 'Ear spread', shapes: ['cat'] },
    ],
  },
  {
    title: 'Eyes',
    controls: [
      { keys: 'eye.rx', label: 'Size' },
      { keys: 'eye.ratio', label: 'Height' },
      { keys: 'eye.n', label: 'Squareness', shapes: SEEDED_FACES },
      { keys: 'eye.gap', label: 'Spacing' },
      { keys: 'eye.lean', label: 'Lean', shapes: SEEDED_FACES },
      { keys: ['eye.scale', 'eye.stretch'], label: 'Asymmetry', shapes: SEEDED_FACES },
      { keys: 'gaze.y', label: 'Height on face' },
    ],
  },
]

export function controlsFor(shape: BlobShape) {
  return LOOK_CONTROLS
    .map((group) => ({ ...group, controls: group.controls.filter((control) => !control.shapes || control.shapes.includes(shape)) }))
    .filter((group) => group.controls.length > 0)
}
