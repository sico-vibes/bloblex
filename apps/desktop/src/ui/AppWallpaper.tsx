import { useEffect, useState } from 'react'
import { getCustomWallpaperUrl, setCustomWallpaperUrl, useThemeStyle } from '../blob/bitbots'
import { inDesktop, readWallpaper } from '../tauri'
import lake from '../assets/wallpapers/lake.svg'
import dusk from '../assets/wallpapers/dusk.svg'
import bloom from '../assets/wallpapers/bloom.svg'
import sand from '../assets/wallpapers/sand.svg'
const WALLPAPERS = { lake, dusk, bloom, sand } as const
function savedWallpaper() { try { return localStorage.getItem('bitbots.wallpaper') ?? 'lake' } catch { return 'lake' } }
export function AppWallpaper() {
  const style = useThemeStyle()
  const [id, setId] = useState(savedWallpaper)
  const [, refresh] = useState(0)
  useEffect(() => {
    const update = () => { setId(savedWallpaper()); refresh((value) => value + 1) }
    window.addEventListener('bitbots-wallpaper-changed', update)
    if (id === 'custom' && inDesktop) void readWallpaper().then((bytes) => {
      if (!bytes.length) return
      const mime = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : 'image/webp'
      const old = getCustomWallpaperUrl(); if (old.startsWith('blob:')) URL.revokeObjectURL(old)
      setCustomWallpaperUrl(URL.createObjectURL(new Blob([bytes], { type: mime })))
    })
    return () => window.removeEventListener('bitbots-wallpaper-changed', update)
  }, [id])
  if (style === 'haze') return <div className="app-wallpaper haze-backdrop" aria-hidden="true" />
  if (style !== 'bitbots') return null
  const image = id === 'custom' ? getCustomWallpaperUrl() || lake : WALLPAPERS[id as keyof typeof WALLPAPERS] ?? lake
  return <div className="app-wallpaper" aria-hidden="true" style={{ backgroundImage: `url("${image}")` }} />
}
