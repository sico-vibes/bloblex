declare module '@tauri-apps/plugin-autostart' {
  export function enable(): Promise<void>
  export function disable(): Promise<void>
  export function isEnabled(): Promise<boolean>
}

declare module '@tauri-apps/plugin-notification' {
  export function isPermissionGranted(): Promise<boolean>
  export function requestPermission(): Promise<'granted' | 'denied' | 'default'>
  export function sendNotification(options: { title: string; body: string }): void
}
