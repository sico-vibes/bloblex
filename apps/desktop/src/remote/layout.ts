import { useEffect, useState } from 'react'

export type RemoteLayout = 'phone' | 'wide'
export type LayoutOverride = 'auto' | RemoteLayout
const KEY = 'bitbots.remote.layout'
const WIDTH = '(min-width: 900px)'
const POINTER = '(pointer: fine)'

export function resolveLayout({ width, pointerFine, override }: { width: number; pointerFine: boolean; override: LayoutOverride }): RemoteLayout {
  return override === 'auto' ? width >= 900 && pointerFine ? 'wide' : 'phone' : override
}

export function useRemoteLayout() {
  const [override, setOverride] = useState<LayoutOverride>(() => {
    try {
      const saved = localStorage.getItem(KEY)
      return saved === 'phone' || saved === 'wide' ? saved : 'auto'
    } catch { return 'auto' }
  })
  const [media, setMedia] = useState(() => ({ width: typeof window !== 'undefined' && window.matchMedia?.(WIDTH).matches ? 900 : 0, pointerFine: typeof window !== 'undefined' && !!window.matchMedia?.(POINTER).matches }))
  useEffect(() => {
    if (!window.matchMedia) return
    const width = window.matchMedia(WIDTH)
    const pointer = window.matchMedia(POINTER)
    const update = () => setMedia({ width: width.matches ? 900 : 0, pointerFine: pointer.matches })
    width.addEventListener('change', update)
    pointer.addEventListener('change', update)
    update()
    return () => { width.removeEventListener('change', update); pointer.removeEventListener('change', update) }
  }, [])
  const changeOverride = (value: string) => {
    if (value !== 'auto' && value !== 'phone' && value !== 'wide') return
    setOverride(value)
    try { localStorage.setItem(KEY, value) } catch { /* A private browser can still change this session. */ }
  }
  return { layout: resolveLayout({ ...media, override }), override, changeOverride }
}
