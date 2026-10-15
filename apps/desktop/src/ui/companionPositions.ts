// C8: remember where the companion was left, per display name, in the
// daemon-held `companion.positions` setting (at most 8 entries). The native
// window owns the live position; this module only keeps the settings value
// tidy and lets the Reset button forget one display.

import { rpc } from '../tauri'

export const POSITIONS_KEY = 'companion.positions'
export const MAX_COMPANION_POSITIONS = 8
const MAX_MONITOR_NAME = 200

export interface CompanionPoint {
  x: number
  y: number
}

export type CompanionPositions = Record<string, CompanionPoint>

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * Keep only entries that are `{ x, y }` numbers under a non-empty display name,
 * rounded to whole pixels, and at most the cap. Anything else is dropped rather
 * than thrown away wholesale.
 */
export function normalizeCompanionPositions(value: unknown): CompanionPositions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const output: CompanionPositions = {}
  for (const [monitor, point] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(output).length >= MAX_COMPANION_POSITIONS) break
    if (!monitor || monitor.length > MAX_MONITOR_NAME) continue
    if (!point || typeof point !== 'object' || Array.isArray(point)) continue
    const record = point as Record<string, unknown>
    if (!isFiniteNumber(record.x) || !isFiniteNumber(record.y)) continue
    output[monitor] = { x: Math.round(record.x), y: Math.round(record.y) }
  }
  return output
}

/** The positions out of a `settings.get` payload, normalized. */
export function positionsFromSettings(source: unknown): CompanionPositions {
  const root = source && typeof source === 'object' ? source as Record<string, unknown> : {}
  const settings = root.settings && typeof root.settings === 'object' ? root.settings as Record<string, unknown> : root
  return normalizeCompanionPositions(settings[POSITIONS_KEY])
}

/** Remember one display's position, dropping the oldest entry once the cap is reached. */
export function rememberCompanionPosition(positions: CompanionPositions, monitor: string, point: CompanionPoint): CompanionPositions {
  if (!monitor || monitor.length > MAX_MONITOR_NAME || !isFiniteNumber(point.x) || !isFiniteNumber(point.y)) return positions
  const next: CompanionPositions = { ...positions }
  delete next[monitor]
  next[monitor] = { x: Math.round(point.x), y: Math.round(point.y) }
  const keys = Object.keys(next)
  while (keys.length > MAX_COMPANION_POSITIONS) {
    const oldest = keys.shift()!
    delete next[oldest]
  }
  return next
}

/** Forget one display's position (the Reset button), leaving the others alone. */
export function forgetCompanionPosition(positions: CompanionPositions, monitor: string): CompanionPositions {
  if (!monitor || !(monitor in positions)) return positions
  const next = { ...positions }
  delete next[monitor]
  return next
}

export async function loadCompanionPositions(): Promise<CompanionPositions> {
  try {
    return positionsFromSettings(await rpc<Record<string, unknown>>('settings.get'))
  } catch { return {} }
}

export async function saveCompanionPositions(positions: CompanionPositions): Promise<void> {
  await rpc('settings.set', { key: POSITIONS_KEY, value: positions })
}

/** Risk-free convenience for the Reset button: read, forget the display, write. */
export async function clearCompanionPosition(monitor: string | null | undefined): Promise<void> {
  if (!monitor) return
  const positions = await loadCompanionPositions()
  const next = forgetCompanionPosition(positions, monitor)
  if (next === positions) return
  await saveCompanionPositions(next)
}
