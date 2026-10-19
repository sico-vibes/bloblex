# FIX16: a transport and platform seam so the UI can run outside Tauri

> **What this is:** Spec for FIX16: a transport and platform seam so the UI can run outside Tauri.
> **Status:** historical
> **Last updated:** 2026-10-15

Written 15 October 2026. Context: Remote mode (see `docs/remote/`, written in parallel)
needs the same React UI to run in a browser or PWA with a different transport and without
native features. Today `src/tauri.ts` is the daemon bridge (the web preview swaps it for
`src/preview/fixtureBridge.ts` through aliases in `vite.preview.config.ts`), but five UI
files import `@tauri-apps/*` directly, so a browser build would break. **No behaviour may
change**: every existing test must keep passing.

Do not change any visual styling, copy or component structure. Do not touch
`apps/desktop/src/remote/*` or `apps/desktop/src/preview/remoteFixture.ts` (other lanes).

## 1. Platform capabilities

New `apps/desktop/src/transport/platform.ts`:

```ts
export type PlatformKind = 'desktop' | 'preview' | 'browser'
export interface PlatformCapabilities {
  kind: PlatformKind
  companion: boolean        // floating companion window
  tray: boolean
  nativeDialogs: boolean    // open/save dialogs, folder picker
  nativeSpeech: boolean     // cpal capture and sherpa dictation
  autostart: boolean
  notifications: 'native' | 'web' | 'none'
  editor: boolean           // open in editor, reveal in explorer
  updater: boolean
  fileDrop: 'paths' | 'files' | 'none'
  keepAwake: boolean
}
export function platform(): PlatformCapabilities
export function setPlatform(next: Partial<PlatformCapabilities> & { kind: PlatformKind }): void
export function usePlatform(): PlatformCapabilities       // useSyncExternalStore
export const DESKTOP_PLATFORM, PREVIEW_PLATFORM, BROWSER_PLATFORM: PlatformCapabilities
```

Defaults: inside Tauri (`isTauri()`) `DESKTOP_PLATFORM` (everything true, notifications
`native`, fileDrop `paths`). In the web preview (the fixture bridge sets `inDesktop = true`)
`PREVIEW_PLATFORM` behaves like desktop so existing tests and previews do not change,
`kind: 'preview'`. `BROWSER_PLATFORM` is everything false, notifications `web`, fileDrop
`files`; it is used later by the remote client via `setPlatform`.

Detect the kind once at module load: `isTauri()` -> desktop, else if `import.meta.env.MODE === 'test'`
or the fixture bridge is aliased -> preview, else browser. Tests can call `setPlatform`.

## 2. One module for native access

New `apps/desktop/src/transport/nativeBridge.ts` is the **only** place (besides `src/tauri.ts`
and `src/desktopIntegrations.ts`) that may import `@tauri-apps/*`. It exports thin wrappers
with the same semantics the call sites use today, for example:

```ts
export const isNative: () => boolean
export function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T>
export function listenNative<T>(event: string, handler: (payload: T) => void): Promise<() => void>
export function emitNative(event: string, payload?: unknown): Promise<void>
export function currentWindow(): { /* only the methods call sites actually use */ }
export function currentWebviewWindow(): { /* same */ }
```

Replace every direct `@tauri-apps/*` import in `ui/App.tsx`, `ui/dictation.ts`,
`ui/DictationBubble.tsx`, `ui/LookEditor.tsx`, `ui/SettingsSheet.tsx` with these wrappers.
Where `isTauri()` is called directly, use `isNative()`. Keep error behaviour identical
(rejections, swallowed errors). Existing tests that mock `@tauri-apps/api/*` must keep working;
if a test mocks the old module path, update the mock to the new module with the same shape.

## 3. Guard test

`apps/desktop/src/transport/noDirectNative.test.ts`: walks `apps/desktop/src` (skipping
`transport/`, `tauri.ts`, `desktopIntegrations.ts`, `preview/`, tests and `*.d.ts`) and fails
if any file imports `@tauri-apps/`. Print the offending files.

## 4. Use the flags where the UI already branches on "in desktop"

Where components branch on `inDesktop` for native-only features (companion toggle, tray,
autostart row, dictation button, open-in-editor menu items, updates panel), read
`usePlatform()` instead so a browser build can hide them. Do not change what the desktop and
preview render. Add one mounted test that sets `BROWSER_PLATFORM` and asserts the Settings
General page does not show the companion rows, the autostart row or the editor group, and
the profile menu shows no "Quit".

## Gates

`npm run typecheck`, `npm run test`. Never commit. Leave the diff and write
`docs/history/fix-16/report.md`: the final API, the list of call sites changed, any flag that needed a
judgement call.
