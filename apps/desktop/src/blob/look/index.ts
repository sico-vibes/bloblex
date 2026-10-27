// Blob looks: a silhouette, a seed and a few pinned traits. The seed fills in
// every trait the user has not pinned, so a look is small enough to store with
// the blob and share in an export.
//
// The shape vocabulary, trait keys and face fitting are adapted from blobatar
// (https://github.com/Alain00/blobatar), MIT License, Copyright (c) 2026 Alain.

import { BLOB_SHAPES, layoutForm, type BlobShape, type FormLayout } from './forms'
import { traits, type TraitOverrides } from './seed'
import { normalizeBot, type BotStyle } from './bot'
import {
  PAINTED_SHAPES, RETIRED_ROBOT_ARTS, isBotArt, isPaintedShape, resolvePaint,
  type BotArt, type PaintedShape,
} from '../art/art'
import { isHazeIcon, type HazeIcon } from '../haze/icons'
import { rememberLookRuntime } from '../haze/runtimeRegistry'

export * from './bot'

export { BLOB_SHAPES, type BlobShape, type FormLayout, type FormEye } from './forms'
export type { TraitOverrides } from './seed'
export type { BotArt, PaintedShape } from '../art/art'

export interface BlobLook {
  shape: BlobShape
  /** Fills every unpinned trait. Agents default to their id. */
  seed?: string | null
  traits?: TraitOverrides
  /** The robot's outline and colours, read only while Bitbots mode is on. */
  bot?: BotStyle
  /** The art style. Omitted, the bot follows the app look. */
  art?: BotArt
  /** The hand-painted body. Omitted, it is derived from the blob shape. */
  paint?: PaintedShape
  /** The Haze look's mark: the runtime logo or a character. Omitted, it is the logo. */
  icon?: HazeIcon
}

export const SHAPE_LABELS: Record<BlobShape, string> = {
  circle: 'Circle', pebble: 'Pebble', squircle: 'Squircle', capsule: 'Capsule',
  triangle: 'Triangle', hexagon: 'Hexagon', cloud: 'Cloud', droplet: 'Droplet',
}

/**
 * The Bitbots mascot: the round silhouette with tall capsule eyes. It is the
 * face of onboarding, the welcome wave and the companion's default look.
 */
export const MASCOT_LOOK: BlobLook = {
  shape: 'circle',
  seed: 'bloblex',
  traits: {
    'body.r': 0.999, 'body.ratio': 0.5, 'body.n': 0.25,
    'eye.rx': 0.999, 'eye.ratio': 0.33, 'eye.scale': 0.48, 'eye.stretch': 0.455, 'eye.gap': 0.53,
    'eye.n': 0.4, 'eye.lean': 0.5, 'eye.lean2': 0.5, 'eye.dy': 0.5, 'gaze.x': 0.5, 'gaze.y': 0.25,
  },
}

const LEGACY_SHAPES: Readonly<Partial<Record<string, BlobShape>>> = Object.freeze({ round: 'circle', organic: 'pebble', boxy: 'squircle', sun: 'circle', cat: 'pebble' })

const TRAIT_KEY = /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/
export const MAX_LOOK_TRAITS = 48

export function isBlobShape(value: unknown): value is BlobShape {
  return typeof value === 'string' && (BLOB_SHAPES as readonly string[]).includes(value)
}

/** A stored or imported look, or null when it is missing or malformed. */
export function normalizeLook(raw: unknown): BlobLook | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const shape = isBlobShape(value.shape) ? value.shape : typeof value.shape === 'string' && Object.hasOwn(LEGACY_SHAPES, value.shape) ? LEGACY_SHAPES[value.shape] : undefined
  if (!shape) return null
  const look: BlobLook = { shape }
  if (typeof value.seed === 'string' && value.seed.trim() && value.seed.length <= 80) look.seed = value.seed
  if (value.traits && typeof value.traits === 'object' && !Array.isArray(value.traits)) {
    const pinned: TraitOverrides = {}
    for (const [key, position] of Object.entries(value.traits as Record<string, unknown>).slice(0, MAX_LOOK_TRAITS)) {
      if (TRAIT_KEY.test(key) && key.length <= 32 && typeof position === 'number' && Number.isFinite(position)) pinned[key] = Math.max(0, Math.min(0.999999, position))
    }
    if (Object.keys(pinned).length) look.traits = pinned
  }
  const bot = normalizeBot(value.bot)
  if (bot) look.bot = bot
  if (isBotArt(value.art)) look.art = value.art
  // The retired 2D, flat and dot robots become the 3D robot.
  else if ((RETIRED_ROBOT_ARTS as readonly unknown[]).includes(value.art)) look.art = 'robot'
  if (isPaintedShape(value.paint)) look.paint = value.paint
  if (isHazeIcon(value.icon)) look.icon = value.icon
  // A retired pixel icon becomes the logo in the bot colour.
  else if (typeof value.icon === 'string' && value.icon.startsWith('px-')) look.icon = 'logo-tint'
  return look
}

/** The look an agent wears: its stored look, else a round blob seeded by its id. */
export function agentLook(agent: { id?: string | null; look?: unknown; runtimeId?: unknown } | null | undefined): BlobLook {
  const stored = normalizeLook(agent?.look)
  const look: BlobLook = {
    shape: stored?.shape ?? 'circle',
    seed: stored?.seed || agent?.id || 'blob',
    traits: stored?.traits,
    ...(stored?.bot ? { bot: stored.bot } : {}),
    ...(stored?.art ? { art: stored.art } : {}),
    ...(stored?.paint ? { paint: stored.paint } : {}),
    ...(stored?.icon ? { icon: stored.icon } : {}),
  }
  rememberLookRuntime(look, agent?.runtimeId)
  return look
}

/** The look the editor previews: the draft's look, else the default for this blob id. */
export function draftLook(draft: { look: BlobLook | null; runtimeId?: unknown }, agentId?: string | null): BlobLook {
  const look = draft.look ? { ...draft.look, seed: draft.look.seed || agentId || 'blob' } : agentLook({ id: agentId })
  rememberLookRuntime(look, draft.runtimeId)
  return look
}

export function sameLook(a: BlobLook | null | undefined, b: BlobLook | null | undefined) {
  return lookKey(a ?? MASCOT_LOOK) === lookKey(b ?? MASCOT_LOOK)
}

function lookKey(look: BlobLook) {
  const pinned = Object.entries(look.traits ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify([look.shape, look.seed ?? '', pinned, look.bot ?? null, look.art ?? null, look.paint ?? null, look.icon ?? null])
}

const cache = new Map<string, FormLayout>()

/** The resolved geometry for a look. Memoised: every avatar redraws from it. */
export function resolveForm(look: BlobLook | null | undefined): FormLayout {
  const value = look ?? MASCOT_LOOK
  const key = lookKey(value)
  let form = cache.get(key)
  if (!form) {
    form = layoutForm(value.shape, traits(value.seed || 'blob', value.traits))
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

/** A fresh face, retaining the silhouette, art and alternate robot styling. */
export function shuffleLook(look: BlobLook, random: () => number = Math.random): BlobLook {
  let seed = `blob-${Math.floor(random() * 0xffffffff).toString(36)}`
  if (seed === look.seed) seed += '-next'
  const { traits: _traits, ...rest } = look
  const next: BlobLook = { ...rest, seed }
  if (look.art === 'painted') {
    const current = look.paint ?? resolvePaint(look)
    const choices = PAINTED_SHAPES.filter((shape) => shape !== current)
    next.paint = choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))] ?? current
  }
  return next
}

export interface LookControl {
  /** One key, or several written together (a macro). */
  keys: string | readonly string[]
  label: string
  /** Shown only for these silhouettes; omitted means every silhouette. */
  shapes?: readonly BlobShape[]
}

export interface LookControlGroup { title: string; controls: readonly LookControl[] }

/** A curated set: the trait keys that read well as sliders, per silhouette. */
export const LOOK_CONTROLS: readonly LookControlGroup[] = [
  {
    title: 'Eyes',
    controls: [
      { keys: 'eye.rx', label: 'Size' },
      { keys: 'eye.ratio', label: 'Height' },
      { keys: 'eye.n', label: 'Squareness' },
      { keys: 'eye.gap', label: 'Spacing' },
      { keys: 'gaze.y', label: 'Height on face' },
    ],
  },
]

export function controlsFor(shape: BlobShape) {
  return LOOK_CONTROLS
    .map((group) => ({ ...group, controls: group.controls.filter((control) => !control.shapes || control.shapes.includes(shape)) }))
    .filter((group) => group.controls.length > 0)
}
