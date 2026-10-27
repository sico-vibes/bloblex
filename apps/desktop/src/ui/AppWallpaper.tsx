import { useThemeStyle } from '../blob/bitbots'

/** Haze's smoky backdrop behind the shell; Stone has none. */
export function AppWallpaper() {
  const style = useThemeStyle()
  return style === 'haze' ? <div className="app-wallpaper haze-backdrop" aria-hidden="true" /> : null
}
