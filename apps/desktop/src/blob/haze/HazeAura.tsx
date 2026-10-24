// The Haze status gradient: a soft wave rolling in from the right. Speed and
// colourfulness carry the state; it shows only while a bot is doing something
// or is selected (the Manager keeps a still golden fade). A change of state
// cross-fades the old wave out and the new one in, so it never cuts.
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useThemeStyle } from '../bitbots'
import type { BlobMood } from '../characterState'

export type AuraStatus = 'idle' | 'thinking' | 'working' | 'needs' | 'error' | 'done'

/** The aura state for a bot's mood. */
export function auraStatusFor(mood: BlobMood | string | null | undefined): AuraStatus {
  switch (mood) {
    case 'working': case 'tool_activity': case 'file_activity': case 'file_preparing': case 'file_sending': return 'working'
    case 'thinking': case 'listening': return 'thinking'
    case 'permission': case 'rate_limited': return 'needs'
    case 'error': case 'file_error': return 'error'
    case 'success': case 'file_ready': return 'done'
    default: return 'idle'
  }
}

const FADE_MS = 900
const GOLD = ['#e7b24a', '#f6d27a', '#c98a2b'] as const

function hsl(hex: string): [number, number, number] {
  const raw = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : '9aa3ad'
  const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(raw.slice(at, at + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2
  if (max === min) return [0, 0, l * 100]
  const d = max - min, s = l > .5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s * 100, l * 100]
}
function shift(hex: string, dh: number, ds = 0, dl = 0) {
  const [h, s, l] = hsl(hex)
  return `hsl(${(h + dh + 360) % 360} ${Math.max(0, Math.min(100, s + ds))}% ${Math.max(0, Math.min(100, l + dl))}%)`
}

function layerStyle(status: AuraStatus, color: string, manager: boolean, quiet: boolean): CSSProperties {
  const idle = status === 'idle'
  const colours = status === 'needs' ? ['#ffb347', '#ff7a45', '#ffd98a']
    : status === 'error' ? ['#ff5a5f', '#d6336c', '#ff9a8a']
    : status === 'done' ? ['#3ddc97', '#8ef0c8', '#2bb3a3']
    : manager ? (idle ? [...GOLD] : [GOLD[0], '#ffcf6b', shift(GOLD[0], -18, 10, -6)])
    : status === 'working' ? [color, shift(color, 42, 12, 6), shift(color, -38, 8, 12)]
    : status === 'thinking' ? [color, shift(color, 16, 0, 12), shift(color, -10, -5, 4)]
    : [shift(color, 0, -40, 0), shift(color, 8, -50, 12), shift(color, -8, -45, 6)]
  const timing: Record<AuraStatus, [string, number]> = { working: ['2.4s', .72], thinking: ['5.5s', .52], needs: ['4s', .62], error: ['9s', .52], done: ['2.2s', .62], idle: [manager ? '16s' : '14s', manager ? .55 : .3] }
  const [dur, alpha] = timing[status]
  return { '--c1': colours[0], '--c2': colours[1], '--c3': colours[2], '--dur': dur, '--alpha': quiet ? alpha * .7 : alpha } as CSSProperties
}

type Layer = { key: number; status: AuraStatus; leaving: boolean }

/**
 * Render inside a positioned element that clips (`overflow: hidden`, a
 * radius); the aura fills it behind the content. Nothing renders outside the
 * Haze look.
 */
export function HazeAura({ status, color, selected = false, manager = false, quiet = false, className = '' }: { status: AuraStatus; color: string; selected?: boolean; manager?: boolean; quiet?: boolean; className?: string }) {
  const style = useThemeStyle()
  const visible = status !== 'idle' || selected || manager
  const shown: AuraStatus | null = visible ? status : null
  const [layers, setLayers] = useState<Layer[]>(() => shown ? [{ key: 0, status: shown, leaving: false }] : [])
  const counter = useRef(1)
  useEffect(() => {
    setLayers((current) => {
      const live = current.find((layer) => !layer.leaving)
      if (live?.status === shown) return current
      const faded = current.map((layer) => ({ ...layer, leaving: true }))
      return shown ? [...faded, { key: counter.current++, status: shown, leaving: false }] : faded
    })
  }, [shown])
  useEffect(() => {
    if (!layers.some((layer) => layer.leaving)) return
    const timer = window.setTimeout(() => setLayers((current) => current.filter((layer) => !layer.leaving)), FADE_MS + 50)
    return () => window.clearTimeout(timer)
  }, [layers])
  if (style !== 'haze' || layers.length === 0) return null
  const still = manager && shown === 'idle' && !selected
  return <span className={`haze-aura ${className}`} aria-hidden="true">
    {layers.map((layer) => <span key={layer.key} className={`haze-aura-layer aura-${layer.status}${layer.leaving ? ' is-leaving' : ''}${still && !layer.leaving ? ' is-still' : ''}`} style={layerStyle(layer.status, color, manager, quiet)}><span className="haze-aura-tone"><i /><i /><i /></span></span>)}
  </span>
}
