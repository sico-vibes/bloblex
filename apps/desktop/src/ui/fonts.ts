import type { ThemeStyle } from './appearance'

export type FontCategory = 'Sans' | 'Friendly / display' | 'Mono' | 'Pixel'
export type FontItem = { id: string; label: string; category: FontCategory; family: string; load: () => Promise<unknown> }
const LOADERS: Record<string, () => Promise<unknown>> = {
  inter: () => import('./fonts/variable/inter.css'), geist: () => import('./fonts/variable/geist.css'), 'dm-sans': () => import('./fonts/variable/dm-sans.css'), manrope: () => import('./fonts/variable/manrope.css'),
  'plus-jakarta-sans': () => import('./fonts/variable/plus-jakarta-sans.css'), 'ibm-plex-sans': () => import('./fonts/variable/ibm-plex-sans.css'), figtree: () => import('./fonts/variable/figtree.css'), sora: () => import('./fonts/variable/sora.css'),
  outfit: () => import('./fonts/variable/outfit.css'), nunito: () => import('./fonts/variable/nunito.css'), 'space-grotesk': () => import('./fonts/variable/space-grotesk.css'), 'bricolage-grotesque': () => import('./fonts/variable/bricolage-grotesque.css'),
  'jetbrains-mono': () => import('./fonts/variable/jetbrains-mono.css'), 'geist-mono': () => import('./fonts/variable/geist-mono.css'), 'fira-code': () => import('./fonts/variable/fira-code.css'),
  'ibm-plex-mono': () => Promise.all([import('@fontsource/ibm-plex-mono/latin-400.css'), import('@fontsource/ibm-plex-mono/latin-500.css'), import('@fontsource/ibm-plex-mono/latin-700.css')]),
  'dm-mono': () => Promise.all([import('@fontsource/dm-mono/latin-400.css'), import('@fontsource/dm-mono/latin-500.css')]),
  'space-mono': () => Promise.all([import('@fontsource/space-mono/latin-400.css'), import('@fontsource/space-mono/latin-700.css')]),
  doto: () => Promise.all([import('@fontsource/doto/latin-700.css'), import('@fontsource/doto/latin-900.css')]),
  silkscreen: () => import('@fontsource/silkscreen/latin-400.css'),
  'pixelify-sans': () => Promise.all([import('@fontsource/pixelify-sans/latin-400.css'), import('@fontsource/pixelify-sans/latin-500.css'), import('@fontsource/pixelify-sans/latin-700.css')]),
  vt323: () => import('@fontsource/vt323/latin-400.css'), 'press-start-2p': () => import('@fontsource/press-start-2p/latin-400.css'), 'jersey-10': () => import('@fontsource/jersey-10/latin-400.css'),
}
const FONT_ROWS: Array<[string, string, FontCategory, string]> = [
  ['inter','Inter','Sans','Inter'], ['geist','Geist','Sans','Geist'], ['dm-sans','DM Sans','Sans','DM Sans'], ['manrope','Manrope','Sans','Manrope'], ['plus-jakarta-sans','Plus Jakarta Sans','Sans','Plus Jakarta Sans'], ['ibm-plex-sans','IBM Plex Sans','Sans','IBM Plex Sans'], ['figtree','Figtree','Sans','Figtree'], ['sora','Sora','Sans','Sora'],
  ['outfit','Outfit','Friendly / display','Outfit'], ['nunito','Nunito','Friendly / display','Nunito'], ['space-grotesk','Space Grotesk','Friendly / display','Space Grotesk'], ['bricolage-grotesque','Bricolage Grotesque','Friendly / display','Bricolage Grotesque'],
  ['jetbrains-mono','JetBrains Mono','Mono','JetBrains Mono'], ['geist-mono','Geist Mono','Mono','Geist Mono'], ['fira-code','Fira Code','Mono','Fira Code'], ['ibm-plex-mono','IBM Plex Mono','Mono','IBM Plex Mono'], ['dm-mono','DM Mono','Mono','DM Mono'], ['space-mono','Space Mono','Mono','Space Mono'],
  ['doto','Doto','Pixel','Doto'], ['silkscreen','Silkscreen','Pixel','Silkscreen'], ['pixelify-sans','Pixelify Sans','Pixel','Pixelify Sans'], ['vt323','VT323','Pixel','VT323'], ['press-start-2p','Press Start 2P','Pixel','Press Start 2P'], ['jersey-10','Jersey 10','Pixel','Jersey 10'],
]
export const FONT_CATALOGUE: readonly FontItem[] = FONT_ROWS.map(([id, label, category, family]) => ({ id, label, category, family, load: LOADERS[id]! }))
export const FONT_DEFAULTS: Record<ThemeStyle, { ui: string; mono: string }> = {
  bitbots: { ui: 'inter', mono: '' }, blobots: { ui: '', mono: '' }, legacy: { ui: '', mono: '' }, pop: { ui: '', mono: '' }, dot: { ui: '', mono: '' },
}
export async function applyFonts(uiId: string, monoId: string, style: ThemeStyle = 'bitbots') {
  const ui = FONT_CATALOGUE.find((font) => font.id === (uiId || FONT_DEFAULTS[style].ui))
  const mono = FONT_CATALOGUE.find((font) => font.id === (monoId || FONT_DEFAULTS[style].mono))
  await Promise.all([ui?.load(), mono?.load()])
  const root = document.documentElement
  if (ui) root.style.setProperty('--font-ui', `"${ui.family}", "Segoe UI Variable Text", "Segoe UI", Inter, system-ui, sans-serif`)
  else root.style.removeProperty('--font-ui')
  if (mono) root.style.setProperty('--font-mono', `"${mono.family}", "Cascadia Mono", Consolas, ui-monospace, monospace`)
  else root.style.removeProperty('--font-mono')
}
