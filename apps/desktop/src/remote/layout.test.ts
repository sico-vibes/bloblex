import { describe, expect, it } from 'vitest'
import { resolveLayout } from './layout'

describe('Remote layout', () => {
  it.each([
    [1440, true, 'auto', 'wide'], [1440, false, 'auto', 'phone'],
    [700, true, 'auto', 'phone'], [899, true, 'auto', 'phone'],
    [900, true, 'auto', 'wide'], [1440, true, 'phone', 'phone'],
    [360, false, 'wide', 'wide'],
  ] as const)('%s px, fine=%s, override=%s -> %s', (width, pointerFine, override, expected) => {
    expect(resolveLayout({ width, pointerFine, override })).toBe(expected)
  })
})
