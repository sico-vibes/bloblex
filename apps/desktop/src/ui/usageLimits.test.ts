import { describe, expect, it } from 'vitest'
import { formatMinor, majorToMinor, minorToMajor } from './usageLimits'

describe('usage limit money conversion', () => {
  it('converts major amounts exactly for zero, two, and three digit currencies', () => {
    expect(majorToMinor('125', 'JPY')).toBe(125)
    expect(majorToMinor('1.29', 'USD')).toBe(129)
    expect(majorToMinor('1.234', 'KWD')).toBe(1234)
  })

  it('accepts excess zero decimals but refuses rounding away non-zero fractions', () => {
    expect(majorToMinor('1.2300', 'USD')).toBe(123)
    expect(majorToMinor('1.239', 'USD')).toBeNull()
    expect(majorToMinor('1.1', 'JPY')).toBeNull()
    expect(majorToMinor('-1', 'USD')).toBeNull()
  })

  it('keeps unknown amounts unknown and formats stored minor units', () => {
    expect(minorToMajor(null, 'USD')).toBe('')
    expect(minorToMajor(1234, 'USD')).toBe('12.34')
    expect(formatMinor(null, 'USD')).toBe('Unknown')
  })
})
