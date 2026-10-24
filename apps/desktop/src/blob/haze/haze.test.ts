import { describe, expect, it } from 'vitest'
import { HAZE_ICONS, PIXEL_ART, PIXEL_ICONS, isHazeIcon } from './icons'
import { auraStatusFor } from './HazeAura'
import { resolveHazeIcon } from './HazeMark'
import { agentLook, normalizeLook } from '../look'

describe('Haze icons', () => {
  it('draws every pixel icon on a 12×12 grid with the known palette', () => {
    for (const icon of PIXEL_ICONS) {
      const rows = PIXEL_ART[icon]
      expect(rows, icon).toHaveLength(12)
      for (const row of rows) {
        expect(row, icon).toHaveLength(12)
        expect(row, icon).toMatch(/^[.BDLKW]+$/)
      }
    }
  })

  it('matches the daemon allowlist (valid_look ICONS)', () => {
    expect(HAZE_ICONS).toEqual(['logo', 'logo-tint', 'logo-mono', 'px-robot', 'px-cat', 'px-ghost', 'px-alien', 'px-fox', 'px-frog', 'px-owl', 'px-bunny', 'px-bear', 'px-octopus', 'px-mushroom', 'px-slime', 'px-wizard', 'px-duck', 'px-rocket', 'px-bolt'])
    expect(isHazeIcon('px-cat')).toBe(true)
    expect(isHazeIcon('px-unknown')).toBe(false)
  })

  it('keeps the icon through normalisation and agentLook, and drops unknown ones', () => {
    expect(normalizeLook({ shape: 'circle', icon: 'px-owl' })?.icon).toBe('px-owl')
    expect(normalizeLook({ shape: 'circle', icon: 'nope' })?.icon).toBeUndefined()
    expect(agentLook({ id: 'a', look: { shape: 'circle', icon: 'logo-tint' } }).icon).toBe('logo-tint')
  })

  it('uses the logo by default, and a pixel robot when the runtime is unknown', () => {
    expect(resolveHazeIcon(null, 'claude')).toBe('logo')
    expect(resolveHazeIcon({ icon: 'logo-mono' }, 'opencode-go')).toBe('logo-mono')
    expect(resolveHazeIcon({ icon: 'logo' }, null)).toBe('px-robot')
    expect(resolveHazeIcon({ icon: 'px-frog' }, null)).toBe('px-frog')
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
