// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { bitbotsEnabled, robotStateFor, setBitbotsEnabled } from './bitbots'
import { BOT_SHAPES, defaultBotShape, normalizeBot, randomBot, resolveBot, sameBot } from './look/bot'
import { agentLook, normalizeLook } from './look'

describe('bitbots mode switch', () => {
  beforeEach(() => { setBitbotsEnabled(false) })

  it('marks the document while on and caches the choice', () => {
    setBitbotsEnabled(true)
    expect(bitbotsEnabled()).toBe(true)
    expect(document.documentElement.dataset.bitbots).toBe('on')
    expect(localStorage.getItem('bloblex.bitbots')).toBe('1')
    setBitbotsEnabled(false)
    expect(document.documentElement.dataset.bitbots).toBeUndefined()
    expect(localStorage.getItem('bloblex.bitbots')).toBe('0')
  })

  it('maps every blob mood onto one of the nine robot faces', () => {
    const faces = new Set(['idle', 'thinking', 'searching', 'listening', 'speaking', 'working', 'happy', 'error', 'sleeping'])
    for (const mood of ['idle', 'online', 'thinking', 'working', 'tool_activity', 'file_activity', 'file_drop', 'file_preparing', 'file_ready', 'file_sending', 'file_error', 'permission', 'success', 'error', 'offline', 'listening', 'rate_limited', 'sleeping'] as const) {
      expect(faces.has(robotStateFor(mood)), mood).toBe(true)
    }
    expect(robotStateFor('permission')).toBe('listening')
    expect(robotStateFor('success')).toBe('happy')
    expect(robotStateFor('tool_activity')).toBe('searching')
  })
})

describe('robot styling', () => {
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
    const bot = randomBot(() => 0.5)
    expect(BOT_SHAPES).toContain(bot.shape)
    expect(bot.shell).toMatch(/^#[0-9a-f]{6}$/)
  })
})
