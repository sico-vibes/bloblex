import { describe, expect, it } from 'vitest'
import type { BlobMood } from '../characterState'
import {
  ART_LABELS, ART_MOOD_SAMPLE, ART_MOODS, BLOB_ARTS, BOT_ARTS, PAINTED_LABELS, PAINTED_SHAPES, RETIRED_ROBOT_ARTS, ROBOT_ARTS,
  artMoodFor, defaultArtForStyle, isBotArt, isPaintedShape, resolveArt, resolvePaint,
} from './art'

const MOODS: BlobMood[] = ['idle', 'online', 'thinking', 'working', 'tool_activity', 'file_activity', 'file_drop', 'file_preparing', 'file_ready', 'file_sending', 'file_error', 'permission', 'success', 'error', 'offline', 'listening', 'rate_limited', 'sleeping']

describe('bot art', () => {
  // The 2D robot (with the flat and dot robots it absorbed) was retired on 27 October 2026.
  it('offers the three arts under two groups with labels', () => {
    expect([...BOT_ARTS]).toEqual(['robot', 'blob', 'painted'])
    expect([...ROBOT_ARTS]).toEqual(['robot'])
    expect([...RETIRED_ROBOT_ARTS]).toEqual(['robot-pop', 'robot-flat', 'robot-dot'])
    expect([...BLOB_ARTS]).toEqual(['blob', 'painted'])
    for (const art of BOT_ARTS) expect(ART_LABELS[art]).toBeTruthy()
  })

  it('offers the twelve painted bodies under the renamed ids', () => {
    expect([...PAINTED_SHAPES]).toEqual(['classic', 'cube', 'star', 'flower', 'pear', 'peanut', 'ghost', 'bunny', 'kitty', 'ufo', 'boxbot', 'tile'])
    for (const paint of PAINTED_SHAPES) expect(PAINTED_LABELS[paint]).toBeTruthy()
    expect(isPaintedShape('cat')).toBe(false)
    expect(isPaintedShape('ufo')).toBe(true)
    expect(isBotArt('glossy')).toBe(false)
    expect(isBotArt('robot-dot')).toBe(false)
  })

  it('uses Glossy as the default art in every look', () => {
    expect(defaultArtForStyle('haze')).toBe('blob')
    expect(defaultArtForStyle('bitbots')).toBe('blob')
    expect(defaultArtForStyle('blobots')).toBe('blob')
    expect(defaultArtForStyle('legacy')).toBe('blob')
    expect(defaultArtForStyle('pop')).toBe('blob')
    expect(defaultArtForStyle('dot')).toBe('blob')
    expect(defaultArtForStyle('mystery')).toBe('blob')
    expect(defaultArtForStyle(undefined)).toBe('blob')
  })

  it('lets an explicit choice override the app look, and ignores a bad one', () => {
    expect(resolveArt({ art: 'painted' }, 'blobots')).toBe('painted')
    expect(resolveArt({}, 'blobots')).toBe('blob')
    for (const art of RETIRED_ROBOT_ARTS) expect(resolveArt({ art }, 'blobots')).toBe('robot')
    expect(resolveArt({ art: 'nonsense' }, 'blobots')).toBe('blob')
  })

  it('derives the painted body from the blob shape and prefers an explicit one', () => {
    expect(resolvePaint({ shape: 'circle' })).toBe('classic')
    expect(resolvePaint({ shape: 'squircle' })).toBe('cube')
    expect(resolvePaint({ shape: 'droplet' })).toBe('pear')
    expect(resolvePaint({ shape: 'cloud' })).toBe('flower')
    expect(resolvePaint({ shape: 'pebble' })).toBe('ghost')
    expect(resolvePaint({ shape: 'capsule' })).toBe('peanut')
    expect(resolvePaint({ shape: 'triangle' })).toBe('star')
    expect(resolvePaint({ shape: 'hexagon' })).toBe('tile')
    expect(resolvePaint({ shape: 'circle', paint: 'ufo' })).toBe('ufo')
    expect(resolvePaint({ shape: 'circle', paint: 'cat' })).toBe('classic')
    expect(resolvePaint(null)).toBe('classic')
  })

  it('maps all eighteen blob moods onto the eight art moods', () => {
    expect([...ART_MOODS]).toEqual(['idle', 'thinking', 'typing', 'waiting', 'happy', 'error', 'sleeping', 'offline'])
    for (const mood of MOODS) expect(ART_MOODS).toContain(artMoodFor(mood))
    expect(artMoodFor('online')).toBe('idle')
    expect(artMoodFor('working')).toBe('typing')
    expect(artMoodFor('file_sending')).toBe('typing')
    expect(artMoodFor('tool_activity')).toBe('thinking')
    expect(artMoodFor('listening')).toBe('thinking')
    expect(artMoodFor('permission')).toBe('waiting')
    expect(artMoodFor('rate_limited')).toBe('waiting')
    expect(artMoodFor('success')).toBe('happy')
    expect(artMoodFor('file_error')).toBe('error')
    expect(artMoodFor('offline')).toBe('offline')
    for (const mood of ART_MOODS) expect(artMoodFor(ART_MOOD_SAMPLE[mood])).toBe(mood)
  })
})
