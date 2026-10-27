import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { HAZE_ICONS, isHazeIcon } from './icons'
import { auraStatusFor } from './HazeAura'
import { resolveHazeIcon } from './HazeMark'
import { agentLook, normalizeLook } from '../look'
import { CHARACTER_ASSETS, HAZE_CHARACTERS } from './characters'

describe('Haze icons', () => {
  it('matches the daemon allowlist (valid_look ICONS)', () => {
    // Pixel icons were retired on 27 October 2026: only the logos and the characters remain.
    expect(HAZE_ICONS).toEqual(['logo', 'logo-tint', 'logo-mono', ...HAZE_CHARACTERS.map(({ id }) => id)])
    const storageSource = readFileSync(new URL('../../../../../crates/bloblex-storage/src/lib.rs', import.meta.url), 'utf8')
    const rustIcons = storageSource.match(/const ICONS: \[&str; \d+\] = \[([\s\S]*?)\];/)?.[1]?.match(/"([^"]+)"/g)?.map((entry) => entry.slice(1, -1))
    expect(rustIcons).toEqual(HAZE_ICONS)
    expect(isHazeIcon('px-cat')).toBe(false)
    expect(isHazeIcon('char-kratos')).toBe(true)
  })

  it('bundles the approved 29 original and animated portraits, excluding Lara and Samus', () => {
    expect(HAZE_CHARACTERS).toHaveLength(29)
    expect(HAZE_CHARACTERS.at(-1)).toEqual({ id: 'char-kratos', name: 'Kratos' })
    expect(HAZE_CHARACTERS.some(({ id }) => /lara|samus/.test(id))).toBe(false)
    for (const { id } of HAZE_CHARACTERS) {
      expect(CHARACTER_ASSETS[id].static, id).toMatch(/\.svg(?:\?|$)/)
      expect(CHARACTER_ASSETS[id].animated, id).toMatch(/\.svg(?:\?|$)/)
    }
  })

  it('keeps the icon through normalisation and agentLook, and drops unknown ones', () => {
    expect(normalizeLook({ shape: 'circle', icon: 'px-owl' })?.icon).toBe('logo-tint')
    expect(normalizeLook({ shape: 'circle', icon: 'char-kratos' })?.icon).toBe('char-kratos')
    expect(normalizeLook({ shape: 'circle', icon: 'nope' })?.icon).toBeUndefined()
    expect(agentLook({ id: 'a', look: { shape: 'circle', icon: 'logo-tint' } }).icon).toBe('logo-tint')
  })

  it('uses the logo by default, and the logo in the bot colour for a retired pixel icon', () => {
    expect(resolveHazeIcon(null)).toBe('logo')
    expect(resolveHazeIcon({ icon: 'logo-mono' })).toBe('logo-mono')
    expect(resolveHazeIcon({ icon: 'px-frog' })).toBe('logo-tint')
  })
})

describe('auraStatusFor', () => {
  it('maps moods onto the gradient states', () => {
    expect(auraStatusFor('working')).toBe('working')
    expect(auraStatusFor('tool_activity')).toBe('working')
    expect(auraStatusFor('thinking')).toBe('thinking')
    expect(auraStatusFor('permission')).toBe('needs')
    expect(auraStatusFor('error')).toBe('error')
    expect(auraStatusFor('success')).toBe('done')
    expect(auraStatusFor('idle')).toBe('idle')
    expect(auraStatusFor('offline')).toBe('idle')
    expect(auraStatusFor(undefined)).toBe('idle')
  })
})
