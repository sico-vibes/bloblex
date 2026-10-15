# FIX16 report: a transport and platform seam

Implemented 15 October 2026 on `opencode-go/deepseek-v4.1-flash`. No behaviour change;
every existing test still passes. Not committed (left in the worktree as a diff).

Gates: `npm run typecheck` clean; `npm run test` → **110 files / 691 tests passed**
(was 673 tests before adding the two new tests and before the previously failing
`SettingsSheet.appearance` suite loaded).

## Final API

### `apps/desktop/src/transport/platform.ts`

```ts
type PlatformKind = 'desktop' | 'preview' | 'browser'
interface PlatformCapabilities { kind; companion; tray; nativeDialogs; nativeSpeech;
  autostart; notifications: 'native'|'web'|'none'; editor; updater;
  fileDrop: 'paths'|'files'|'none'; keepAwake }
const DESKTOP_PLATFORM, PREVIEW_PLATFORM, BROWSER_PLATFORM: PlatformCapabilities
function platform(): PlatformCapabilities
function setPlatform(next: Partial<PlatformCapabilities> & { kind: PlatformKind }): void
function usePlatform(): PlatformCapabilities        // useSyncExternalStore
```

- `DESKTOP_PLATFORM` — every flag true, `notifications: 'native'`, `fileDrop: 'paths'`.
- `PREVIEW_PLATFORM` — `{ ...DESKTOP_PLATFORM, kind: 'preview' }` so the fixture preview and
  existing tests render exactly as before.
- `BROWSER_PLATFORM` — every flag false, `notifications: 'web'`, `fileDrop: 'files'`.
- Detected once at module load: `isNative()` → desktop; else
  `import.meta.env.MODE === 'test' || previewMode` → preview; else browser.
- `setPlatform` merges and notifies subscribers; `usePlatform` is the React binding.

### `apps/desktop/src/transport/nativeBridge.ts`

```ts
isNative(): boolean
invokeNative<T>(command, args?): Promise<T>
listenNative<T>(event, handler: (payload: T) => void): Promise<() => void>
emitNative(event, payload?): Promise<void>
currentWindow(): Pick<Window, 'onDragDropEvent' | 'startDragging'>
currentWebviewWindow(): Pick<WebviewWindow, 'listen'>
```

Thin wrappers with identical semantics: `invokeNative`/`emitNative`/`currentWindow()`/
`currentWebviewWindow()` pass through unchanged; `listenNative` unwraps the Tauri event
envelope so the handler receives the payload. `currentWindow().onDragDropEvent` keeps the
raw `{ payload }` event shape the call site already destructures.

### Guard + test

- `apps/desktop/src/transport/noDirectNative.test.ts` — walks `src` (skipping `transport/`,
  `preview/`, `tauri.ts`, `desktopIntegrations.ts`, test files and `*.d.ts`) and asserts no
  file imports `@tauri-apps/`; prints offenders on failure.
- `apps/desktop/src/ui/platform.browser.mounted.test.tsx` — one mounted test: sets
  `BROWSER_PLATFORM`, renders Settings (General) plus `ProfileMenu`, asserts the companion
  rows, autostart row and editor group are absent and the profile menu has no "Quit"; then
  switches to `PREVIEW_PLATFORM` and asserts everything returns.

## Call sites changed

### Direct `@tauri-apps/*` → native bridge

- `ui/App.tsx` — removed the four `@tauri-apps` imports. `invoke`→`invokeNative` (opener,
  `companion_visible`, `set_keep_awake` ×2); `listen`→`listenNative` (`bloblex-companion-visible-changed`
  ×2, `bloblex-notifications-enabled-changed`, `bloblex-tray-notice`,
  `bloblex-pause-all-requested`, `bloblex-sound-volume-changed`, `bloblex-sounds-changed`,
  `bloblex-dictation-surface`/`-dictation`/`-level`/`-engine`); `emit`→`emitNative`
  (`bloblex-sounds-changed`, `bloblex-sound-volume-changed`); `isTauri()`→`isNative()`;
  `getCurrentWindow()`→`currentWindow()`; `getCurrentWebviewWindow()`→`currentWebviewWindow()`.
  Event handlers changed from `({ payload }) => …` to `(payload) => …`.
- `ui/dictation.ts` — `invoke`→`invokeNative` (`speech_models`, `speech_cloud_status`,
  `set_dictation_shortcut`, `dictation_warm`, `dictation_release`, `dictation_start`,
  `speech_model_download`, `speech_model_status`, `dictation_stop`); `listen`→`listenNative`;
  `isTauri()`→`isNative()` ×3; `getCurrentWebviewWindow()`→`currentWebviewWindow()`. Local
  `type Unlisten = () => void` replaces the imported `UnlistenFn`.
- `ui/DictationBubble.tsx` — `invoke`→`invokeNative` (`set_dictation_bubble_size`,
  `show_main_window`); `listen`→`listenNative` (surface / dictation / level / engine);
  `getCurrentWindow()`→`currentWindow()`. Local `Unlisten` type.
- `ui/LookEditor.tsx` — `invoke`→`invokeNative` (credit opener). Still reads `inDesktop`.
- `ui/SettingsSheet.tsx` — `invoke`→`invokeNative` (`companion_hotkey_registered` ×2,
  `companion_visible`, `speech_models`, `speech_model_status`, `speech_model_download`,
  `set_companion_hotkey`); `listen`→`listenNative` (`bloblex-companion-visible-changed`,
  `bloblex-speech-download`); `emit`→`emitNative` (`bloblex-notifications-enabled-changed`,
  `bloblex-sounds-changed`, `bloblex-sound-volume-changed` ×2).

### `usePlatform()` flags (§4) — native-only surfaces

- `ui/App.tsx` — companion sidebar card (`platform.companion`); update banner
  (`platform.updater`); more-menu "Quit Bitbots" (`platform.tray`); desktop composer
  dictation button (`platform.nativeSpeech`); companion composer dictation button
  (`platform.nativeSpeech`); Files-pane "Open in editor" / "Reveal in File Explorer"
  (`platform.editor`). `FilesPane` and `Companion` each call `usePlatform()` above their
  first early return.
- `ui/SettingsSheet.tsx` — "Start with Windows" (`platform.autostart`); "Close to tray"
  (`platform.tray`); "Companion display" + the "Companion" group (`platform.companion`);
  the "Editor" group (`platform.editor`); the updates panel (`platform.updater`).
- `ui/ProfileMenu.tsx` — "Quit Bitbots" (`platform.tray`).

## Tests updated

- `ui/SettingsSheet.appearance.mounted.test.tsx` — its `@tauri-apps/api/core` mock only
  exported `invoke`; `nativeBridge.isNative()` reaches `isTauri` at module load, so the mock
  now also returns `isTauri: () => true` (the same shape its sibling Settings tests already
  used). No assertion changed.

## Judgement calls

- **Quit's flag.** There is no lifecycle/`process` capability in the fixed interface, so both
  "Quit Bitbots" items are gated on `platform.tray` — the only app-shell/lifecycle flag.
  Desktop and preview have `tray: true`, so nothing changes there; a browser hides it.
- **Preview detection.** The "fixture bridge is aliased" signal is `previewMode` imported from
  `../tauri` (the real module exports `false`; the fixture bridge exports `true`). Under
  Vitest it is never read (`import.meta.env.MODE === 'test'` short-circuits first), so partial
  `../tauri` mocks stay valid.
- **Unused flags.** `nativeDialogs`, `fileDrop`, `keepAwake` and `notifications` are defined
  but not consumed yet: the UI branches on those paths via `inDesktop`/behaviour, not on the
  native-only *rendering* the spec lists, and changing them would change behaviour. They are
  ready for the remote client.
- **Speech settings page.** Only the composer dictation *buttons* are gated
  (`nativeSpeech`), matching the spec's list; the Settings → Speech page is left as-is.
- **Window wrappers.** `currentWindow`/`currentWebviewWindow` return narrowed `Pick`s of the
  Tauri types (only the methods call sites use) rather than new objects, so the drag-drop
  handler keeps its raw `{ payload }` shape.
- **Test mocks.** The existing `@tauri-apps/api/*` mocks were left in place: `nativeBridge` is
  a deliberate pass-through over exactly those modules, so the mocks still intercept and the
  tests keep their `{ payload }` delivery. Rewriting them to mock `nativeBridge` would change
  the delivered event shape and risk the "no behaviour change" requirement. Only the one mock
  that was too narrow (missing `isTauri`) needed updating.

## Not touched

`apps/desktop/src/remote/*` and `apps/desktop/src/preview/remoteFixture.ts` were not touched.
No `git commit` was run.
