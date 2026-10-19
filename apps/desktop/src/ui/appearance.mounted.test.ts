// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { applyAppearance, applySurfaceAppearance } from './appearance'

describe('appearance mounted document behavior', () => {
  it('applies theme and text size before rendering in the main window', () => {
    const root = document.createElement('html')
    applyAppearance(root, 'dark', 'large')
    expect(root.dataset).toMatchObject({ theme: 'dark', textSize: 'large' })
  })

  it('keeps the companion theme dark while applying a saved text size', () => {
    const root = document.createElement('html')
    root.dataset.theme = 'dark'
    root.dataset.themeChoice = 'dark'
    applySurfaceAppearance(root, 'light', 'larger', true)
    expect(root.dataset).toMatchObject({ theme: 'dark', themeChoice: 'light', surfaceTheme: 'light', textSize: 'larger' })
  })

  it('resolves system appearance onto the companion surface without changing data-theme', () => {
    const root = document.createElement('html')
    root.dataset.theme = 'dark'
    const matchMedia = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
    applySurfaceAppearance(root, 'system', 'default', true)
    expect(root.dataset).toMatchObject({ theme: 'dark', themeChoice: 'system', surfaceTheme: 'light' })
    matchMedia.mockRestore()
  })

  it('applies the selected theme and text size to the main surface', () => {
    const root = document.createElement('html')
    applySurfaceAppearance(root, 'light', 'small', false)
    expect(root.dataset).toMatchObject({ theme: 'light', themeChoice: 'light', textSize: 'small' })
  })
})
