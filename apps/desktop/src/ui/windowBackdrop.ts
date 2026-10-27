import { applyWindowBackdrop, windowBackdropState } from '../tauri'
import type { WindowBackdrop } from '../types'

/** Last effect the shell reported, so the next start paints the matching tint on the first frame (index.html reads it). */
export const BACKDROP_CACHE_KEY = 'bitbots.backdrop'

type Backdrop = Pick<WindowBackdrop, 'effect' | 'active'>
type BackdropApi = { apply: (enabled: boolean, dark: boolean) => Promise<Backdrop>; state: () => Promise<Backdrop> }

const NATIVE_API: BackdropApi = { apply: applyWindowBackdrop, state: windowBackdropState }

/** `data-backdrop` is set only while the operating system really draws a blur behind the window. */
export function backdropAttribute(report: Backdrop): 'acrylic' | 'blur' | null {
  return report.active && (report.effect === 'acrylic' || report.effect === 'blur') ? report.effect : null
}

/**
 * Keeps the main Haze window's native frosted backdrop in step with the document: on for Haze, off for Frost and
 * Stone, dark or light following `data-theme`. It never runs in the companion or dictation windows. The CSS only
 * turns the page into a translucent tint while `data-backdrop` is set, so a refused or unavailable effect leaves
 * the opaque Haze backdrop in place.
 */
export function startWindowBackdrop(root: HTMLElement = document.documentElement, api: BackdropApi = NATIVE_API): () => void {
  if (root.classList.contains('companion-surface') || root.classList.contains('dictation-surface')) return () => {}
  let stopped = false
  let applied = ''
  let queue: Promise<void> = Promise.resolve()

  const show = (report: Backdrop, wanted: boolean) => {
    const effect = wanted ? backdropAttribute(report) : null
    if (effect) root.dataset.backdrop = effect
    else delete root.dataset.backdrop
    try { localStorage.setItem(BACKDROP_CACHE_KEY, effect ?? 'none') } catch { /* The cache only speeds up the next first frame. */ }
  }
  const sync = (force = false) => {
    const wanted = root.dataset.style === 'haze'
    const dark = root.dataset.theme !== 'light'
    const key = `${wanted ? 1 : 0}${dark ? 'd' : 'l'}`
    if (!force && key === applied) return
    applied = key
    queue = queue.then(async () => {
      if (stopped) return
      try { show(await api.apply(wanted, dark), wanted) } catch { show({ effect: 'none', active: false }, wanted) }
    })
  }
  // Windows lets the user switch transparency effects off at any time; look again when the window is used.
  const recheck = () => {
    if (root.dataset.style !== 'haze') return
    queue = queue.then(async () => {
      if (stopped) return
      try { show(await api.state(), true) } catch { /* Keep what is shown. */ }
    })
  }

  const observer = new MutationObserver(() => sync())
  observer.observe(root, { attributes: true, attributeFilter: ['data-style', 'data-theme'] })
  window.addEventListener('focus', recheck)
  sync(true)
  return () => {
    stopped = true
    observer.disconnect()
    window.removeEventListener('focus', recheck)
  }
}
