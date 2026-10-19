# FIX41 leftovers brief (Codex lane)

> **What this is:** Brief for the FIX41 leftovers (Codex lane).
> **Status:** historical
> **Last updated:** 2026-10-19

Two small fixes left over from FIX40 (see `docs/history/fix-40/report.md`, "Follow-ups not done", items 1 and 2). Work only in `apps/desktop/src/ui`. Do not run `git commit`. Do not touch any other files.

## 1. "No extra options" line padding

`apps/desktop/src/ui/AppearancePage.tsx` renders `<p className="appearance-quiet">This look has no extra options yet.</p>` directly inside a `.settings-card` for every look except Bitbots (Frost). The `p` has no horizontal padding, so its text sits flush against the card's left edge (most visible in Pop, `src/ui/themes/pop.css`, which draws a 2px card border).

- In `apps/desktop/src/ui/appearancePage.css`, give that paragraph the same inner padding as a settings row (`.settings-row` in `src/ui/settings.css` uses `padding: 12px 16px`) and `margin: 0`, so it lines up with other rows in Classic, Legacy, Pop and Dot.
- Scope the rule to the paragraph (for example `p.appearance-quiet` or `.settings-card > .appearance-quiet`) so the `small` elements that share the `.appearance-quiet` colour rule are not affected.
- No look-specific overrides should be needed; if a look's CSS overrides it, fix it there too.

## 2. Safe links: every activation goes through the safe opener

`apps/desktop/src/ui/SafeMarkdown.tsx` renders links in `SafeMarkdown` and `SafeMarkdownInline` as `<a href target="_blank" rel="noopener noreferrer" onClick=...>`. Middle-click (`auxclick`) and Ctrl/Cmd/Shift+click can make the webview open or navigate on its own, and `apps/desktop/src/ui/openSafeLink.ts` falls back to `window.open` inside the desktop webview when the native opener fails.

Required:

- Factor the two duplicated anchors into one small `SafeLink` component (in `SafeMarkdown.tsx`) used by both renderers.
- `onClick`: always `event.preventDefault()`, then call `onOpenLink(url)` for a primary-button click, with or without Ctrl/Cmd/Shift/Alt modifiers.
- `onAuxClick`: always `preventDefault()`; for `event.button === 1` (middle button) call `onOpenLink(url)`. Other aux buttons (right-click) only prevent default; do not open.
- `onMouseDown` with `button === 1`: `preventDefault()` so the webview does not start autoscroll or its own middle-click handling.
- Keyboard: Enter on a focused anchor fires `click` in browsers, so it goes through `onClick`; make sure nothing else is needed and do not double-open.
- Keep `href` (for hover status, focus and accessibility), `className="markdown-link"`, and `rel="noopener noreferrer"`. Keep `target="_blank"` only if it is harmless once every activation is prevented; otherwise remove it. State which you chose and why in your final message.
- Drag: set `draggable={false}` so dragging the link does not drop a URL into the webview.
- `openSafeLink.ts`: when `isNative()` is true and `invokeNative('plugin:opener|open_url', ...)` throws, do nothing (no `window.open`); you may `console.warn` a message that contains no URL. Keep the `window.open(..., '_blank', 'noopener,noreferrer')` path only for `!isNative()` (browser preview). Update the file's comment accordingly.

Tests (Vitest, happy-dom, mounted, following the style of `src/ui/SafeMarkdown.mounted.test.tsx`):

- Middle-click: dispatch `new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })` on the link; assert `onOpenLink` called exactly once with the URL and `event.defaultPrevented === true`.
- Right aux-click (`button: 2`): default prevented, `onOpenLink` not called.
- Ctrl+click: dispatch `new MouseEvent('click', { button: 0, ctrlKey: true, bubbles: true, cancelable: true })`; assert called once and default prevented. Add the same with `metaKey: true`.
- Plain click: default prevented (extend the existing test).
- The same middle-click and Ctrl+click checks for `SafeMarkdownInline`.
- A unit test for `openSafeLink` (new file `src/ui/openSafeLink.test.ts`): mock `../transport/nativeBridge` so `isNative()` returns true and `invokeNative` rejects; spy on `window.open` and assert it is never called. With `isNative()` false, `window.open` is called once with the normalised href and `'noopener,noreferrer'`. A `javascript:` URL and a URL with credentials never reach either path.

## Checks you can run

From `apps/desktop`: `npx tsc -b --pretty false` and `npx vitest run src/ui/SafeMarkdown src/ui/openSafeLink src/ui/SettingsSheet.appearance` (add `--configLoader runner` if Vite cannot write temp files in the sandbox). The Director runs the full gates and the browser preview.

## Final message

List the files changed, the `target="_blank"` decision, and the test results you saw.
