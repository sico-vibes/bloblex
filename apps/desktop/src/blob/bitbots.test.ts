// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { robotStateFor } from './bitbots'
import { BOT_SHAPES, defaultBotShape, normalizeBot, randomBot, resolveBot, sameBot } from './look/bot'
import { agentLook, normalizeLook } from './look'

/** Bitbots reads its cache at module load, so each case imports a fresh copy. */
async function loadModule() {
  vi.resetModules()
  return import('./bitbots')
}

describe('theme style switch', () => {
  beforeEach(() => { localStorage.clear() })

  it('defaults to bitbots and marks the document', async () => {
    const bitbots = await loadModule()
    expect(bitbots.themeStyle()).toBe('bitbots')
    expect(bitbots.bitbotsEnabled()).toBe(false)
    expect(document.documentElement.dataset.style).toBe('bitbots')
    expect(document.documentElement.dataset.bitbots).toBeUndefined()
    expect(document.documentElement.dataset.wallpaper).toBe('lake')
    expect(document.documentElement.dataset.glass).toBe('solid')
  })

  it('keeps the bitbots marker exclusive to Legacy and applies wallpaper and glass preferences', async () => {
    const bitbots = await loadModule()
    for (const look of ['bitbots','blobots','pop','dot'] as const) {
      bitbots.setThemeStyle(look)
      expect(document.documentElement.dataset.style).toBe(look)
      expect(document.documentElement.dataset.bitbots).toBeUndefined()
    }
    bitbots.setThemeStyle('legacy')
    expect(document.documentElement.dataset.bitbots).toBe('on')
    expect(bitbots.bitbotsEnabled()).toBe(true)
    bitbots.setWallpaper('dusk')
    bitbots.setGlass('clear')
    expect(document.documentElement.dataset.wallpaper).toBe('dusk')
    expect(document.documentElement.dataset.glass).toBe('clear')
    expect(localStorage.getItem('bitbots.wallpaper')).toBe('dusk')
    expect(localStorage.getItem('bitbots.glass')).toBe('clear')
  })

  it('reads the new cache key first', async () => {
    localStorage.setItem('bitbots.style', 'blobots')
    const bitbots = await loadModule()
    expect(bitbots.themeStyle()).toBe('blobots')
    expect(bitbots.bitbotsEnabled()).toBe(false)
    expect(document.documentElement.dataset.style).toBe('blobots')
    expect(document.documentElement.dataset.bitbots).toBeUndefined()
  })

  it('falls back to the legacy key only when the new key is absent', async () => {
    localStorage.setItem('bloblex.bitbots', '0')
    expect((await loadModule()).themeStyle()).toBe('blobots')
    localStorage.clear()
    localStorage.setItem('bloblex.bitbots', '1')
    expect((await loadModule()).themeStyle()).toBe('bitbots')
    localStorage.clear()
    localStorage.setItem('bitbots.style', 'bitbots')
    localStorage.setItem('bloblex.bitbots', '0')
    expect((await loadModule()).themeStyle()).toBe('bitbots')
  })

  it('toggles the document attribute and never writes the legacy key', async () => {
    const bitbots = await loadModule()
    bitbots.setThemeStyle('blobots')
    expect(document.documentElement.dataset.style).toBe('blobots')
    expect(document.documentElement.dataset.bitbots).toBeUndefined()
    expect(localStorage.getItem('bitbots.style')).toBe('blobots')
    expect(localStorage.getItem('bloblex.bitbots')).toBeNull()

    bitbots.setThemeStyle('bitbots')
    expect(document.documentElement.dataset.bitbots).toBeUndefined()
    expect(localStorage.getItem('bitbots.style')).toBe('bitbots')

    bitbots.setThemeStyle('legacy')
    expect(document.documentElement.dataset.bitbots).toBe('on')

    bitbots.setBitbotsEnabled(false)
    expect(bitbots.bitbotsEnabled()).toBe(false)
    expect(bitbots.themeStyle()).toBe('blobots')
  })

  it('keeps the deprecated setter false-to-Blobots and true-to-Bitbots behavior', async () => {
    const bitbots = await loadModule()
    bitbots.setBitbotsEnabled(true)
    expect(bitbots.themeStyle()).toBe('bitbots')
    expect(bitbots.bitbotsEnabled()).toBe(false)
    expect(document.documentElement.dataset.bitbots).toBeUndefined()
    bitbots.setBitbotsEnabled(false)
    expect(bitbots.themeStyle()).toBe('blobots')
  })

  it('applies and clears the user accent on the document', async () => {
    const bitbots = await loadModule()
    bitbots.setAccentColor('#E17A56')
    const root = document.documentElement
    expect(bitbots.accentColor()).toBe('#e17a56')
    expect(root.dataset.accent).toBe('custom')
    expect(root.style.getPropertyValue('--user-accent')).toBe('#e17a56')
    expect(root.style.getPropertyValue('--user-accent-pressed')).toBe('#c66b4c')
    expect(root.style.getPropertyValue('--user-accent-soft')).toBe('rgba(225,122,86,.14)')
    expect(root.style.getPropertyValue('--user-accent-ink')).toBe('#0f0f10')
    expect(localStorage.getItem('bitbots.accent')).toBe('#e17a56')

    bitbots.setAccentColor('')
    expect(bitbots.accentColor()).toBe('')
    expect(root.style.getPropertyValue('--user-accent')).toBe('')
    expect(root.style.getPropertyValue('--user-accent-pressed')).toBe('')
    expect(root.style.getPropertyValue('--user-accent-soft')).toBe('')
    expect(root.style.getPropertyValue('--user-accent-ink')).toBe('')
    expect(root.dataset.accent).toBeUndefined()
    expect(localStorage.getItem('bitbots.accent')).toBeNull()
  })

  it('applies a cached accent at module load so first paint matches', async () => {
    localStorage.setItem('bitbots.accent', '#3b82f6')
    const bitbots = await loadModule()
    expect(bitbots.accentColor()).toBe('#3b82f6')
    expect(document.documentElement.dataset.accent).toBe('custom')
    expect(document.documentElement.style.getPropertyValue('--user-accent')).toBe('#3b82f6')
  })

  it('ignores an invalid accent', async () => {
    const bitbots = await loadModule()
    bitbots.setAccentColor('not-a-colour')
    expect(bitbots.accentColor()).toBe('')
    expect(document.documentElement.dataset.accent).toBeUndefined()
  })
})

describe('robot styling', () => {
  it('maps every blob mood onto one of the nine robot faces', () => {
    const faces = new Set(['idle', 'thinking', 'searching', 'listening', 'speaking', 'working', 'happy', 'error', 'sleeping'])
    for (const mood of ['idle', 'online', 'thinking', 'working', 'tool_activity', 'file_activity', 'file_drop', 'file_preparing', 'file_ready', 'file_sending', 'file_error', 'permission', 'success', 'error', 'offline', 'listening', 'rate_limited', 'sleeping'] as const) {
      expect(faces.has(robotStateFor(mood)), mood).toBe(true)
    }
    expect(robotStateFor('permission')).toBe('listening')
    expect(robotStateFor('success')).toBe('happy')
    expect(robotStateFor('tool_activity')).toBe('searching')
  })

  it('only ever offers the four outlines', () => {
    expect([...BOT_SHAPES]).toEqual(['rectangle', 'square', 'circle', 'hexagon'])
    expect(normalizeBot({ shape: 'triangle' })).toBeUndefined()
    expect(normalizeBot({ shape: 'circle', antenna: true, speed: 4 })).toEqual({ shape: 'circle' })
  })

  it('keeps only valid hex colours and lowercases them', () => {
    expect(normalizeBot({ shell: '#2B49A3', trim: 'steel', screen: '#FFFFFF' })).toEqual({ shell: '#2b49a3', screen: '#ffffff' })
    expect(normalizeBot('nope')).toBeUndefined()
  })

  it('fills the gaps from the blob: its silhouette and its colour', () => {
    expect(defaultBotShape('round')).toBe('circle')
    expect(defaultBotShape('hexagon')).toBe('hexagon')
    expect(defaultBotShape('mystery')).toBe('rectangle')
    expect(resolveBot({ shape: 'boxy' }, '#aabbcc')).toMatchObject({ shape: 'square', shell: '#aabbcc' })
    expect(resolveBot({ shape: 'boxy', bot: { shape: 'hexagon', shell: '#112233' } }, '#aabbcc')).toMatchObject({ shape: 'hexagon', shell: '#112233' })
  })

  it('travels inside the stored look and is compared by value', () => {
    const look = normalizeLook({ shape: 'round', seed: 'x', bot: { shape: 'square', screen: '#59d7ff' } })
    expect(look?.bot).toEqual({ shape: 'square', screen: '#59d7ff' })
    expect(agentLook({ id: 'a', look }).bot).toEqual({ shape: 'square', screen: '#59d7ff' })
    expect(sameBot({ shape: 'circle' }, { shape: 'circle' })).toBe(true)
    expect(sameBot({ shape: 'circle' }, undefined)).toBe(false)
  })

  it('surprise me stays inside the palettes', () => {
    const bot = randomBot('hexagon', () => 0.5)
    expect(bot.shape).toBe('hexagon')
    expect(bot.shell).toMatch(/^#[0-9a-f]{6}$/)
  })
})
