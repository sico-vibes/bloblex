// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHARACTER_ASSETS } from './characters'
import { HazeMark } from './HazeMark'
import { resolveHazeIcon } from './HazeMark'
import type { HazeIcon } from './icons'
import { BlobCanvas } from '../BlobCanvas'

const mounted: Array<{ root: Root; host: HTMLDivElement }> = []
function mount(size: number, icon: HazeIcon) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(<HazeMark color="#9be7c4" size={size} look={{ shape: 'circle', icon }} label="Kratos" />))
  mounted.push({ root, host })
  return host
}

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => { for (const { root, host } of mounted.splice(0)) { act(() => root.unmount()); host.remove() }; vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Haze character renderer', () => {
  it('uses the original static art for small avatars and the animated original for large avatars', () => {
    const small = mount(24, 'char-kratos')
    expect(small.querySelector('.haze-character-image')?.getAttribute('src')).toBe(CHARACTER_ASSETS['char-kratos'].static)
    const large = mount(88, 'char-kratos')
    expect(large.querySelector('.haze-character-image')?.getAttribute('src')).toBe(CHARACTER_ASSETS['char-kratos'].animated)
    expect(large.querySelector('.haze-mark')?.getAttribute('aria-label')).toBe('Kratos')
  })

  it('falls back safely for unknown icon ids', () => {
    expect(resolveHazeIcon({ icon: 'char-unknown' }, null)).toBe('px-robot')
  })

  it('renders saved character ids only while Haze is the active look', () => {
    const props = { color: '#9be7c4', size: 24, look: { shape: 'circle' as const, icon: 'char-kratos' as const }, label: 'Bot' }
    expect(renderToStaticMarkup(<BlobCanvas {...props} style="haze" />)).toContain('data-icon="char-kratos"')
    for (const style of ['bitbots', 'blobots'] as const) {
      const markup = renderToStaticMarkup(<BlobCanvas {...props} style={style} />)
      expect(markup).not.toContain('haze-mark')
      expect(markup).not.toContain('char-kratos')
    }
  })
})
