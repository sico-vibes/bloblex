# Native smoke tooling

Helpers used for the native smoke test in docs/NATIVE_SMOKE_RESULTS.md. They need only Node 22+ and PowerShell.

- Launch the app against an ISOLATED database with the WebView2 debug port open:
  `$env:BLOBLEX_DB_PATH = "<scratch>\bloblex.db"; $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'; npm run desktop:dev`
  Never point `BLOBLEX_DB_PATH` at `%LOCALAPPDATA%\Bloblex\bloblex.db`.
- `cdp.mjs`: list/screenshot/eval/click/type/key against the app's webviews over the debug port (`node cdp.mjs targets`, `shot <index> out.png`, `click <index> "<selector>" [text]`).
- `winenum.ps1 -ProcId <pid>`: visible native windows of the app with rectangles and styles; `region.ps1`: capture a screen rectangle and report corner pixels (transparency check); `mousedrag.ps1`: synthesized drag.
- `tray.ps1`: finds the tray icon via UI Automation (open the hidden-icons overflow first).
- `seed_v1.py`, `inspect_v2.py`, `agents_db.py`: seed a scratch v1 database made by an old daemon, then inspect the migrated result read-only.
