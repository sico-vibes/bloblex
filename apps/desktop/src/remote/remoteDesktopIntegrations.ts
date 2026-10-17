// The remote build's stand-in for `src/desktopIntegrations.ts`. On a phone there
// is no native shell, so autostart does nothing, a "desktop notification" is not
// sent, and there is no window to flash. The signatures match the desktop module
// so any shared UI that imports it still links.

/** Autostart is a host-machine setting; a device cannot change it. */
export async function autostartEnabled(): Promise<boolean> { return false }
export async function setAutostartEnabled(enabled: boolean): Promise<void> { void enabled }

/**
 * Desktop notifications are not wired for the PWA yet (push is phase P3 in
 * docs/remote/PHASES.md). Resolving without sending keeps the caller simple.
 */
export async function sendDesktopNotification(title: string, body: string): Promise<void> { void title; void body }

/** There is no native window to flash. */
export function flashMainWindow(): void { /* no-op on a device */ }
