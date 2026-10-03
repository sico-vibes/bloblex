import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window'

export async function autostartEnabled() {
  return (await import('@tauri-apps/plugin-autostart')).isEnabled()
}
export async function setAutostartEnabled(enabled: boolean) {
  const plugin = await import('@tauri-apps/plugin-autostart')
  return enabled ? plugin.enable() : plugin.disable()
}

export async function sendDesktopNotification(title: string, body: string) {
  const plugin = await import('@tauri-apps/plugin-notification')
  let granted = await plugin.isPermissionGranted()
  if (!granted) granted = (await plugin.requestPermission()) === 'granted'
  if (granted) plugin.sendNotification({ title, body })
}

export function flashMainWindow() {
  return getCurrentWindow().requestUserAttention(UserAttentionType.Critical)
}
