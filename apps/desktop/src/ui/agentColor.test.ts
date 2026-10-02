import { describe, expect, it } from 'vitest'
import { AGENT_SWATCHES, agentColorHex, colorsEquivalent, parseCustomHex, swatchForColor } from './agentColor'

describe('agent colour', () => {
  it('maps the twelve swatches and the provider migration hexes', () => {
    expect(AGENT_SWATCHES.map((swatch) => swatch.key)).toEqual(['coral', 'orange', 'amber', 'lemon', 'lime', 'mint', 'teal', 'cyan', 'sky', 'blue', 'violet', 'pink'])
    expect(agentColorHex('coral')).toBe('#F38C6F')
    expect(agentColorHex('#82aaff')).toBe('#82AAFF')
    expect(agentColorHex('mint')).toBe('#89D6B3')
    expect(agentColorHex('violet')).toBe('#BF9CFF')
    expect(colorsEquivalent('#f38c6f', 'coral')).toBe(true)
    expect(colorsEquivalent('#82AAFF', 'blue')).toBe(true)
    expect(colorsEquivalent('#bf9cff', 'violet')).toBe(true)
    expect(colorsEquivalent('#89d6b3', 'mint')).toBe(true)
    expect(swatchForColor('#F38C6F')).toBe('coral')
    expect(swatchForColor('blue')).toBe('blue')
    expect(agentColorHex('not-a-colour')).toBe('#89D6B3')
  })

  it('accepts six-digit hex and rejects short, alpha, and named colours', () => {
    expect(parseCustomHex('f38c6f')).toBe('#F38C6F')
    expect(parseCustomHex('#f38c6f')).toBe('#F38C6F')
    expect(parseCustomHex('#F38')).toBeNull()
    expect(parseCustomHex('#F38C6F80')).toBeNull()
    expect(parseCustomHex('red')).toBeNull()
    expect(swatchForColor('#F0A0C4')).toBe('pink')
    expect(swatchForColor('#112233')).toBeNull()
  })
})
