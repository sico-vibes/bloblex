import desktopPackage from '../package.json'

/** Build-time version from the desktop package. Matches tauri.conf.json and the Cargo workspace. */
export const appVersion = typeof desktopPackage.version === 'string' && desktopPackage.version.trim()
  ? desktopPackage.version.trim()
  : ''
